import { dataView, hex, inBounds, item, MAX_SYMBOLS, readCString, readFixedString, sortSymbols } from './shared.js'

const MAX_LOAD_COMMANDS = 65536
const MAX_FAT_ARCHS = 32

const MH_MAGIC = 0xfeedface
const MH_CIGAM = 0xcefaedfe
const MH_MAGIC_64 = 0xfeedfacf
const MH_CIGAM_64 = 0xcffaedfe
const FAT_MAGIC = 0xcafebabe
const FAT_CIGAM = 0xbebafeca

const MAGIC_NAMES = {
  [MH_MAGIC]: '32-bit Mach-O',
  [MH_MAGIC_64]: '64-bit Mach-O',
  [MH_CIGAM]: '32-bit Mach-O (reversed)',
  [MH_CIGAM_64]: '64-bit Mach-O (reversed)',
  [FAT_MAGIC]: 'Universal Binary',
  [FAT_CIGAM]: 'Universal Binary (reversed)'
}

function isThinMachOMagic(magic) {
  return magic === MH_MAGIC || magic === MH_CIGAM || magic === MH_MAGIC_64 || magic === MH_CIGAM_64
}

// 0xCAFEBABE is also the Java class file magic. In a class file the next u32 is
// minor/major version (major >= 45), so a fat header needs a small arch count
// and an arch table that fits in the file.
function readFatHeader(view) {
  if (view.byteLength < 8) return null
  const magic = view.getUint32(0, false)
  if (magic !== FAT_MAGIC && magic !== FAT_CIGAM) return null
  const littleEndian = magic === FAT_CIGAM
  const nfat = view.getUint32(4, littleEndian)
  if (nfat < 1 || nfat > MAX_FAT_ARCHS || 8 + nfat * 20 > view.byteLength) return null
  return { littleEndian, nfat }
}

const CPU_ARCH_ABI64 = 0x01000000
const CPU_ARCH_ABI64_32 = 0x02000000
const MACHO_CPUS = {
  7: 'x86',
  [7 | CPU_ARCH_ABI64]: 'x86_64',
  12: 'arm',
  [12 | CPU_ARCH_ABI64]: 'arm64',
  [12 | CPU_ARCH_ABI64_32]: 'arm64_32',
  18: 'ppc',
  [18 | CPU_ARCH_ABI64]: 'ppc64'
}

function cpuName(cputype, cpusubtype) {
  if (cputype === (12 | CPU_ARCH_ABI64) && (cpusubtype & 0xff) === 2) return 'arm64e'
  return MACHO_CPUS[cputype] || `Unknown (${hex(cputype >>> 0)})`
}

const MACHO_FILE_TYPES = {
  1: 'Object',
  2: 'Executable',
  4: 'Core dump',
  5: 'Preloaded executable',
  6: 'Dynamic library',
  7: 'Dynamic linker',
  8: 'Bundle',
  9: 'Dynamic library stub',
  10: 'Debug symbols (dSYM)',
  11: 'Kernel extension'
}

const LC_SEGMENT = 0x1
const LC_SYMTAB = 0x2
const LC_SEGMENT_64 = 0x19

// nm letter for a section: the classic __TEXT,__text / __DATA,__data / __DATA,__bss
// names, plus section type and attribute flags for everything else.
function machOSectionLetter(section) {
  const type = section.flags & 0xff
  if (type === 0x1 || type === 0xc || type === 0x12) return 'B' // zerofill variants
  if (section.sectname === '__bss' || section.sectname === '__common') return 'B'
  if (section.sectname === '__text' || (section.flags & 0x80000400) !== 0) return 'T'
  if (section.sectname === '__data') return 'D'
  return 'S'
}

// Parses one thin Mach-O image starting at `base`. Offsets inside the image
// (symoff, stroff) are relative to `base`, which matters for fat slices.
function parseMachOImage(view, base, end) {
  const magic = view.getUint32(base, false)
  const littleEndian = magic === MH_CIGAM || magic === MH_CIGAM_64
  const is64Bit = magic === MH_MAGIC_64 || magic === MH_CIGAM_64
  const headerSize = is64Bit ? 32 : 28
  if (base + headerSize > end) throw new Error('Mach-O header is truncated')

  const cputype = view.getInt32(base + 4, littleEndian)
  const cpusubtype = view.getInt32(base + 8, littleEndian)
  const filetype = view.getUint32(base + 12, littleEndian)
  const ncmds = view.getUint32(base + 16, littleEndian)

  const sections = [null] // n_sect is 1-based
  const symtabs = []
  let cmdOffset = base + headerSize
  for (let i = 0; i < Math.min(ncmds, MAX_LOAD_COMMANDS); i++) {
    if (cmdOffset + 8 > end) break
    const cmd = view.getUint32(cmdOffset, littleEndian)
    const cmdsize = view.getUint32(cmdOffset + 4, littleEndian)
    if (cmdsize < 8 || cmdOffset + cmdsize > end) break

    if (cmd === LC_SYMTAB && cmdsize >= 24) {
      symtabs.push({
        symoff: view.getUint32(cmdOffset + 8, littleEndian),
        nsyms: view.getUint32(cmdOffset + 12, littleEndian),
        stroff: view.getUint32(cmdOffset + 16, littleEndian),
        strsize: view.getUint32(cmdOffset + 20, littleEndian)
      })
    } else if (cmd === LC_SEGMENT || cmd === LC_SEGMENT_64) {
      const seg64 = cmd === LC_SEGMENT_64
      const headerLength = seg64 ? 72 : 56
      const sectionLength = seg64 ? 80 : 68
      if (cmdsize >= headerLength) {
        const nsects = view.getUint32(cmdOffset + (seg64 ? 64 : 48), littleEndian)
        const fits = Math.floor((cmdsize - headerLength) / sectionLength)
        for (let s = 0; s < Math.min(nsects, fits); s++) {
          const sectOffset = cmdOffset + headerLength + s * sectionLength
          sections.push({
            sectname: readFixedString(view, sectOffset, 16),
            segname: readFixedString(view, sectOffset + 16, 16),
            flags: view.getUint32(sectOffset + (seg64 ? 64 : 56), littleEndian)
          })
        }
      }
    }
    cmdOffset += cmdsize
  }

  const symbols = []
  const entrySize = is64Bit ? 16 : 12
  for (const { symoff, nsyms, stroff, strsize } of symtabs) {
    const symStart = base + symoff
    const strStart = base + stroff
    const strEnd = Math.min(strStart + strsize, end)
    if (symStart >= end || strStart >= end) continue
    const count = Math.min(nsyms, MAX_SYMBOLS, Math.floor((end - symStart) / entrySize))

    for (let j = 0; j < count; j++) {
      const entry = symStart + j * entrySize
      const strx = view.getUint32(entry, littleEndian)
      const type = view.getUint8(entry + 4)
      const sect = view.getUint8(entry + 5)
      if (type & 0xe0) continue // N_STAB debugging entry
      if (strx === 0 || strStart + strx >= strEnd) continue

      let name = readCString(view, strStart + strx, strEnd)
      if (name.startsWith('_')) name = name.substring(1)
      if (!name) continue

      const value = is64Bit
        ? view.getBigUint64(entry + 8, littleEndian)
        : view.getUint32(entry + 8, littleEndian)
      const isExternal = (type & 0x01) !== 0

      let letter
      switch (type & 0x0e) {
        case 0x0: letter = isExternal && value ? 'C' : 'U'; break // N_UNDF (C: common)
        case 0x2: letter = 'A'; break // N_ABS
        case 0xa: letter = 'I'; break // N_INDR
        case 0xc: letter = 'U'; break // N_PBUD
        case 0xe: // N_SECT
          // Without a segment command describing n_sect the section kind is
          // unknown; fall back to S ("other section"), as llvm-nm does.
          letter = sections[sect] ? machOSectionLetter(sections[sect]) : 'S'
          break
        default: continue
      }
      if (!isExternal) letter = letter.toLowerCase()

      const defined = letter !== 'U' && letter !== 'u' && letter !== 'I' && letter !== 'i'
      const symbol = { name, type: letter }
      if (letter === 'C') symbol.note = `size ${value}`
      else if (defined) symbol.address = hex(value)
      symbols.push(symbol)
    }
  }

  return {
    arch: cpuName(cputype, cpusubtype),
    fileType: MACHO_FILE_TYPES[filetype] || `Unknown (${filetype})`,
    is64Bit,
    littleEndian,
    hasSymtab: symtabs.length > 0,
    headerEnd: Math.min(cmdOffset, end),
    symbols
  }
}

function imageSummary(image) {
  const summary = [
    item('Architecture', image.arch),
    item('File Type', image.fileType),
    item('Class', `Mach-O ${image.is64Bit ? '64-bit' : '32-bit'}, ${image.littleEndian ? 'little' : 'big'} endian`)
  ]
  if (!image.hasSymtab) summary.push(item('Symbol table', 'none'))
  return summary
}

function parseMachO(view) {
  const magic = view.getUint32(0, false)
  const formatName = MAGIC_NAMES[magic] || 'Mach-O binary'
  const fields = [{ name: 'Magic', offset: 0, length: 4, value: hex(magic), kind: 'magic', description: formatName }]

  const fat = readFatHeader(view)
  if (!fat) {
    if (!isThinMachOMagic(magic) || view.byteLength < 28) return { formatName, fields }
    const image = parseMachOImage(view, 0, view.byteLength)
    return {
      formatName,
      summary: imageSummary(image),
      fields,
      regions: [{ name: 'Mach header and load commands', offset: 0, length: image.headerEnd, kind: 'header' }],
      symbols: sortSymbols(image.symbols)
    }
  }

  fields.push({ name: 'nfat_arch', offset: 4, length: 4, value: String(fat.nfat), kind: 'count', description: 'Number of architecture slices' })
  const regions = [{ name: 'Universal header', offset: 0, length: 8 + fat.nfat * 20, kind: 'header' }]
  const slices = []
  for (let i = 0; i < fat.nfat; i++) {
    const entry = 8 + i * 20
    const cputype = view.getInt32(entry, fat.littleEndian)
    const cpusubtype = view.getInt32(entry + 4, fat.littleEndian)
    const offset = view.getUint32(entry + 8, fat.littleEndian)
    const size = view.getUint32(entry + 12, fat.littleEndian)
    slices.push({ arch: cpuName(cputype, cpusubtype), offset, size })
    if (offset < view.byteLength && size > 0) {
      regions.push({ name: `${slices[i].arch} slice`, offset, length: Math.min(size, view.byteLength - offset), kind: 'code' })
    }
  }

  let shown = null
  const sliceDetails = slices.map(slice => {
    const end = Math.min(slice.offset + slice.size, view.byteLength)
    const where = `${slice.arch}: offset ${hex(slice.offset)}, ${slice.size} bytes`
    if (!inBounds(view, slice.offset, 4) || !isThinMachOMagic(view.getUint32(slice.offset, false))) {
      return `${where} (not a readable Mach-O image)`
    }
    try {
      const image = parseMachOImage(view, slice.offset, end)
      if (!shown) shown = image
      return `${where}, ${image.fileType.toLowerCase()}, ${image.symbols.length} symbols`
    } catch (err) {
      return `${where} (${err.message})`
    }
  })

  const summary = [item('Universal Binary', slices.map(s => s.arch).join(', '), [
    ...sliceDetails,
    shown ? `Symbols below are from the ${shown.arch} slice` : 'No readable slices'
  ])]
  if (!shown) return { formatName, summary, fields, regions }
  return {
    formatName,
    summary: [...summary, ...imageSummary(shown)],
    fields,
    regions,
    symbols: sortSymbols(shown.symbols)
  }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'macho',
  name: 'Mach-O binary',
  category: 'executable',
  // Java class files share the universal magic and are detected first
  detect(bytes) {
    if (bytes.length < 4) return false
    const magic = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
    if (magic === FAT_MAGIC) return bytes.length >= 8
    return isThinMachOMagic(magic) || magic === FAT_CIGAM
  },
  parse(bytes) {
    try {
      return parseMachO(dataView(bytes))
    } catch (err) {
      throw new Error('Invalid Mach-O file structure: ' + err.message)
    }
  }
}
