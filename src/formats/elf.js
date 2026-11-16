import { dataView, hex, inBounds, item, MAX_SYMBOLS, readCString, sortSymbols } from './shared.js'

const ELF_MACHINES = {
  0x02: 'SPARC',
  0x03: 'Intel 80386 (x86)',
  0x08: 'MIPS',
  0x14: 'PowerPC',
  0x15: 'PowerPC 64-bit',
  0x16: 'IBM S/390',
  0x28: 'ARM',
  0x2B: 'SPARC V9',
  0x32: 'IA-64',
  0x3E: 'AMD x86-64',
  0xB7: 'AArch64',
  0xF3: 'RISC-V',
  0xF7: 'eBPF',
  0x102: 'LoongArch'
}

const SHT_SYMTAB = 2
const SHT_STRTAB = 3
const SHT_NOBITS = 8
const SHT_DYNSYM = 11
const SHF_WRITE = 0x1
const SHF_ALLOC = 0x2
const SHF_EXECINSTR = 0x4
const SHN_UNDEF = 0
const SHN_ABS = 0xfff1
const SHN_COMMON = 0xfff2
const SHN_XINDEX = 0xffff

function headerSummary(machine, is64Bit, littleEndian) {
  const machineName = ELF_MACHINES[machine]
  return [
    item('Architecture', machineName || `Unknown (0x${machine.toString(16)})`, [
      'Processor architecture for this binary',
      'Determines the instruction set and register layout',
      'Affects binary compatibility and performance',
      machineName ? `Common in ${machineName.includes('x86') ? 'desktop/server' : 'mobile/embedded'} systems` : ''
    ]),
    item('Class', is64Bit ? 'ELF64' : 'ELF32', [
      is64Bit ? '64-bit format, supports > 4GB address space' : '32-bit format, limited to 4GB address space',
      is64Bit ? 'Larger pointer size (8 bytes)' : 'Smaller pointer size (4 bytes)',
      is64Bit ? 'Better for large applications and modern systems' : 'Common in older or embedded systems',
      `Memory model: ${is64Bit ? 'LP64 (longs and pointers are 64-bit)' : 'ILP32 (ints, longs, and pointers are 32-bit)'}`
    ]),
    item('Endianness', littleEndian ? 'Little Endian' : 'Big Endian', [
      littleEndian ? 'Least significant byte stored first (x86/ARM)' : 'Most significant byte stored first (older SPARC/PowerPC)',
      'Affects how multi-byte values are stored in memory',
      littleEndian ? 'Common in x86, ARM, and most modern processors' : 'Used in older RISC architectures',
      `Example: 0x1234 stored as ${littleEndian ? '34 12' : '12 34'}`
    ])
  ]
}

function elfSymbolLetter(bind, type, shndx, sections) {
  if (type === 10) return 'i' // STT_GNU_IFUNC
  if (bind === 10) return 'u' // STB_GNU_UNIQUE
  if (bind === 2) { // STB_WEAK
    const letter = type === 1 ? 'V' : 'W'
    return shndx === SHN_UNDEF ? letter.toLowerCase() : letter
  }
  let letter
  if (shndx === SHN_UNDEF) return 'U'
  if (shndx === SHN_ABS) letter = 'A'
  else if (shndx === SHN_COMMON) letter = 'C'
  else {
    const section = sections[shndx]
    if (!section) letter = '?'
    else if (section.flags & SHF_EXECINSTR) letter = 'T'
    else if (section.type === SHT_NOBITS && (section.flags & SHF_ALLOC)) letter = 'B'
    else if (section.flags & SHF_WRITE) letter = 'D'
    else if (section.flags & SHF_ALLOC) letter = 'R'
    else letter = 'N'
  }
  return bind === 0 ? letter.toLowerCase() : letter
}

// Byte range of a table, clipped to the file; null when nothing of it is in the file
function clippedRegion(view, name, offset, length, kind) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= view.byteLength || !(length > 0)) return null
  return { name, offset, length: Math.min(length, view.byteLength - offset), kind }
}

function parseELF(view) {
  const elfClass = view.byteLength > 5 ? view.getUint8(4) : 0
  const dataEncoding = view.byteLength > 5 ? view.getUint8(5) : 0
  if (elfClass !== 1 && elfClass !== 2) throw new Error(`ELF parsing error: unsupported ELF class ${elfClass}`)
  if (dataEncoding !== 1 && dataEncoding !== 2) throw new Error(`ELF parsing error: unsupported data encoding ${dataEncoding}`)
  const is64Bit = elfClass === 2
  const le = dataEncoding === 1
  const headerSize = is64Bit ? 64 : 52
  if (view.byteLength < headerSize) throw new Error('ELF parsing error: header is truncated')

  const machine = view.getUint16(18, le)
  const summary = headerSummary(machine, is64Bit, le)
  const fields = [
    { name: 'Magic', offset: 0, length: 4, value: '\\x7FELF', kind: 'magic', description: 'ELF identification' },
    { name: 'EI_CLASS', offset: 4, length: 1, value: is64Bit ? 'ELF64' : 'ELF32', kind: 'header' },
    { name: 'EI_DATA', offset: 5, length: 1, value: le ? 'Little Endian' : 'Big Endian', kind: 'header' },
    { name: 'e_machine', offset: 18, length: 2, value: ELF_MACHINES[machine] || hex(machine), kind: 'header' }
  ]
  const regions = [{ name: 'ELF header', offset: 0, length: headerSize, kind: 'header' }]
  const symbols = []
  const result = () => ({ summary, fields, regions, symbols: sortSymbols(symbols) })

  const readAddr = (offset) => is64Bit ? Number(view.getBigUint64(offset, le)) : view.getUint32(offset, le)
  const shoff = readAddr(is64Bit ? 40 : 32)
  const shentsize = view.getUint16(is64Bit ? 58 : 46, le)
  let shnum = view.getUint16(is64Bit ? 60 : 48, le)
  let shstrndx = view.getUint16(is64Bit ? 62 : 50, le)
  const minShentsize = is64Bit ? 64 : 40

  if (!shoff) {
    summary.push(item('Section headers', 'none (symbols unavailable)'))
    return result()
  }
  if (shentsize < minShentsize || !inBounds(view, shoff, minShentsize)) {
    summary.push(item('Section headers', 'unreadable (symbols unavailable)'))
    return result()
  }

  const readSection = (index) => {
    const offset = shoff + index * shentsize
    return {
      name: view.getUint32(offset, le),
      type: view.getUint32(offset + 4, le),
      flags: is64Bit ? Number(view.getBigUint64(offset + 8, le)) : view.getUint32(offset + 8, le),
      offset: readAddr(offset + (is64Bit ? 24 : 16)),
      size: readAddr(offset + (is64Bit ? 32 : 20)),
      link: view.getUint32(offset + (is64Bit ? 40 : 24), le),
      entsize: readAddr(offset + (is64Bit ? 56 : 36))
    }
  }

  // Extended numbering: the real counts live in section header 0
  const first = readSection(0)
  if (shnum === 0) shnum = first.size
  if (shstrndx === SHN_XINDEX) shstrndx = first.link

  const fits = Math.floor((view.byteLength - shoff) / shentsize)
  const count = Math.min(shnum, fits, 65536)
  const sections = []
  for (let i = 0; i < count; i++) sections.push(readSection(i))
  const sectionTable = clippedRegion(view, 'Section header table', shoff, count * shentsize, 'table')
  if (sectionTable) regions.push(sectionTable)

  const shstrtab = sections[shstrndx]
  const sectionName = (section) => {
    if (!shstrtab || shstrtab.type !== SHT_STRTAB) return ''
    const end = Math.min(shstrtab.offset + shstrtab.size, view.byteLength)
    return section.name < shstrtab.size ? readCString(view, shstrtab.offset + section.name, end) : ''
  }

  // nm shows .symtab when present and falls back to .dynsym for stripped binaries
  const symtab = sections.find(s => s.type === SHT_SYMTAB && s.size > 0) ||
    sections.find(s => s.type === SHT_DYNSYM && s.size > 0)
  if (!symtab) {
    summary.push(item('Symbol table', 'none (stripped)'))
    return result()
  }

  const strtab = sections[symtab.link]
  const minEntsize = is64Bit ? 24 : 16
  const entsize = symtab.entsize >= minEntsize && symtab.entsize <= 256 ? symtab.entsize : minEntsize
  const symEnd = Math.min(symtab.offset + symtab.size, view.byteLength)
  const total = symtab.offset < symEnd ? Math.floor((symEnd - symtab.offset) / entsize) : 0
  const strStart = strtab ? strtab.offset : 0
  const strEnd = strtab ? Math.min(strtab.offset + strtab.size, view.byteLength) : 0

  let symbolCount = 0
  if (strtab && strtab.type === SHT_STRTAB && strStart < strEnd) {
    for (let i = 1; i < Math.min(total, MAX_SYMBOLS); i++) {
      const entry = symtab.offset + i * entsize
      const nameIndex = view.getUint32(entry, le)
      const symInfo = view.getUint8(entry + (is64Bit ? 4 : 12))
      const shndx = view.getUint16(entry + (is64Bit ? 6 : 14), le)
      const type = symInfo & 0xf
      const bind = symInfo >> 4
      if (type === 3 || type === 4) continue // STT_SECTION, STT_FILE
      if (!nameIndex || strStart + nameIndex >= strEnd) continue
      const name = readCString(view, strStart + nameIndex, strEnd)
      if (!name) continue

      const symbol = { name, type: elfSymbolLetter(bind, type, shndx, sections) }
      if (shndx !== SHN_UNDEF) {
        symbol.address = hex(is64Bit ? view.getBigUint64(entry + 8, le) : view.getUint32(entry + 4, le))
      }
      symbols.push(symbol)
      symbolCount++
    }
  }

  const symtabName = sectionName(symtab) || (symtab.type === SHT_SYMTAB ? '.symtab' : '.dynsym')
  const strtabName = strtab ? sectionName(strtab) || `section ${symtab.link}` : 'missing'
  summary.push(item('Symbol table', `${symtabName} (${symbolCount} symbols)`, [
    `Read from ${symtabName}, names from ${strtabName}`,
    symtab.type === SHT_DYNSYM ? 'No static symbol table (.symtab); showing dynamic symbols only' : '',
    total > MAX_SYMBOLS ? `Only the first ${MAX_SYMBOLS} of ${total} entries were read` : '',
    'Letters follow nm: T/t code, D/d data, B/b bss, R/r read-only, U undefined, W/w V/v weak; lowercase is local'
  ]))
  const symbolRegion = clippedRegion(view, symtabName, symtab.offset, symtab.size, 'table')
  if (symbolRegion) regions.push(symbolRegion)
  const stringRegion = strtab && clippedRegion(view, strtabName, strtab.offset, strtab.size, 'table')
  if (stringRegion) regions.push(stringRegion)
  return result()
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'elf',
  name: 'Linux ELF Executable',
  category: 'executable',
  detect: bytes => bytes.length >= 4 && bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46,
  parse(bytes) {
    try {
      return parseELF(dataView(bytes))
    } catch (err) {
      if (err.message.startsWith('ELF parsing error')) throw err
      throw new Error(`ELF parsing error: ${err.message}`)
    }
  }
}
