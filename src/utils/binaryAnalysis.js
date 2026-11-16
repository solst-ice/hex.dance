// Every parser returns a Set<string>, in display order: info rows first, then
// symbols sorted by name. Row encodings understood by FunctionList:
//   'title\x00["detail", ...]'   expandable info row
//   'name (X) suffix'            symbol row with an nm-style type letter X
//   anything else                plain info row

const MAX_STRING_LENGTH = 4096
const MAX_SYMBOLS = 2000000
const MAX_LOAD_COMMANDS = 65536
const MAX_FAT_ARCHS = 32
// The Windows loader rejects images with more sections; every export lookup
// walks the section list, so an unbounded count makes parsing quadratic
const MAX_PE_SECTIONS = 96

function inBounds(view, offset, length) {
  return Number.isSafeInteger(offset) && offset >= 0 && offset + length <= view.byteLength
}

const utf8 = new TextDecoder()

function readCString(view, offset, end = view.byteLength) {
  if (!Number.isSafeInteger(offset) || offset < 0) return ''
  const limit = Math.min(end, view.byteLength, offset + MAX_STRING_LENGTH)
  if (offset >= limit) return ''
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, limit - offset)
  const terminator = bytes.indexOf(0)
  return utf8.decode(terminator === -1 ? bytes : bytes.subarray(0, terminator))
}

function readFixedString(view, offset, length) {
  return readCString(view, offset, offset + length)
}

function hex(value) {
  return `0x${value.toString(16).toUpperCase()}`
}

function infoRow(title, details) {
  const lines = details.filter(Boolean)
  return lines.length ? `${title}\x00${JSON.stringify(lines)}` : title
}

// Sorted by name ignoring case and leading underscores, so `_start`, `main`
// and `__libc_start_main` sit where a reader would look for them.
function compareSymbols(a, b) {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1
  if (a.row !== b.row) return a.row < b.row ? -1 : 1
  return 0
}

function emit(infoRows, symbols) {
  const result = new Set(infoRows)
  const rows = symbols.map(({ name, letter, suffix }) => ({
    key: name.replace(/^_+/, '').toLowerCase(),
    row: suffix ? `${name} (${letter}) ${suffix}` : `${name} (${letter})`
  }))
  rows.sort(compareSymbols)
  for (const { row } of rows) result.add(row)
  return result
}

// ---------------------------------------------------------------- PE

function isPEFile(view) {
  if (view.byteLength < 0x40 || view.getUint16(0, true) !== 0x5A4D) return false
  const peOffset = view.getUint32(0x3C, true)
  if (!inBounds(view, peOffset, 24)) return false
  return view.getUint32(peOffset, true) === 0x00004550
}

const PE_MACHINES = {
  0x14c: 'x86',
  0x8664: 'x64',
  0x1c0: 'ARM',
  0x1c4: 'ARMv7 (Thumb-2)',
  0xaa64: 'ARM64'
}

const PE_FILE_FLAGS = [
  [0x0001, 'Relocations stripped'],
  [0x0002, 'Executable image'],
  [0x0020, 'Large address aware'],
  [0x0100, '32-bit machine'],
  [0x0200, 'Debug info stripped'],
  [0x1000, 'System file'],
  [0x2000, 'DLL']
]

const PE_SECTION_FLAGS = [
  [0x20, 'Code'],
  [0x40, 'Initialized Data'],
  [0x80, 'Uninitialized Data'],
  [0x200, 'Link Info'],
  [0x1000000, 'Extended Relocations'],
  [0x2000000, 'Discardable'],
  [0x4000000, 'Not Cached'],
  [0x8000000, 'Not Paged'],
  [0x10000000, 'Shared'],
  [0x20000000, 'Executable'],
  [0x40000000, 'Readable'],
  [0x80000000, 'Writable']
]

function decodeFlags(value, table) {
  return table.filter(([bit]) => (value & bit) !== 0).map(([, label]) => label)
}

function rvaToFileOffset(view, rva, sections) {
  for (const section of sections) {
    // VirtualSize may legally be 0, in which case only the raw size describes the section
    const span = Math.max(section.virtualSize, section.rawSize)
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      const delta = rva - section.virtualAddress
      if (delta >= section.rawSize) return null
      const offset = section.rawAddress + delta
      return offset < view.byteLength ? offset : null
    }
  }
  return null
}

function sectionForRva(rva, sections) {
  return sections.find(s => rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize))
}

function parsePEExports(view) {
  const peOffset = view.getUint32(0x3C, true)
  const fileHeader = peOffset + 4
  const machine = view.getUint16(fileHeader, true)
  const declaredSections = view.getUint16(fileHeader + 2, true)
  const timeDateStamp = view.getUint32(fileHeader + 4, true)
  const symbolTableOffset = view.getUint32(fileHeader + 8, true)
  const numberOfSymbols = view.getUint32(fileHeader + 12, true)
  const optionalHeaderSize = view.getUint16(fileHeader + 16, true)
  const characteristics = view.getUint16(fileHeader + 18, true)

  const info = [
    `Architecture: ${PE_MACHINES[machine] || `Unknown (${hex(machine)})`}`,
    `Timestamp: ${new Date(timeDateStamp * 1000).toISOString()}`,
    infoRow(`Characteristics: ${hex(characteristics)}`, decodeFlags(characteristics, PE_FILE_FLAGS))
  ]
  const exports = []

  const optionalHeaderOffset = fileHeader + 20
  const sectionHeadersOffset = optionalHeaderOffset + optionalHeaderSize

  // Long section names ("/4") point into the COFF string table that follows the symbol table
  const stringTableOffset = symbolTableOffset ? symbolTableOffset + numberOfSymbols * 18 : 0
  const sectionName = (raw) => {
    const match = /^\/(\d+)$/.exec(raw)
    if (!match || !stringTableOffset || !inBounds(view, stringTableOffset, 4)) return raw
    const offset = stringTableOffset + Number(match[1])
    return inBounds(view, offset, 1) ? readCString(view, offset) || raw : raw
  }

  const sections = []
  for (let i = 0; i < Math.min(declaredSections, MAX_PE_SECTIONS); i++) {
    const offset = sectionHeadersOffset + i * 40
    if (!inBounds(view, offset, 40)) break
    const section = {
      name: sectionName(readFixedString(view, offset, 8)),
      virtualSize: view.getUint32(offset + 8, true),
      virtualAddress: view.getUint32(offset + 12, true),
      rawSize: view.getUint32(offset + 16, true),
      rawAddress: view.getUint32(offset + 20, true),
      characteristics: view.getUint32(offset + 36, true)
    }
    sections.push(section)
    info.push(infoRow(`Section ${i + 1}: ${section.name || '(unnamed)'}`, [
      `Virtual Size: ${hex(section.virtualSize)} bytes`,
      `Virtual Address: ${hex(section.virtualAddress)}`,
      `Raw Size: ${hex(section.rawSize)} bytes`,
      `Raw Address: ${hex(section.rawAddress)}`,
      `Characteristics: ${decodeFlags(section.characteristics, PE_SECTION_FLAGS).join(', ') || 'None'}`
    ]))
  }
  if (sections.length < declaredSections) {
    info.push(`Section table truncated: ${sections.length} of ${declaredSections} sections readable`)
  }

  if (!inBounds(view, optionalHeaderOffset, 2)) return emit(info, exports)
  const isPE32Plus = view.getUint16(optionalHeaderOffset, true) === 0x20B
  const dataDirectoryOffset = optionalHeaderOffset + (isPE32Plus ? 112 : 96)
  if (!inBounds(view, dataDirectoryOffset, 8) || dataDirectoryOffset + 8 > sectionHeadersOffset ||
      view.getUint32(dataDirectoryOffset - 4, true) < 1) { // NumberOfRvaAndSizes
    return emit(info, exports)
  }
  const exportRVA = view.getUint32(dataDirectoryOffset, true)
  const exportSize = view.getUint32(dataDirectoryOffset + 4, true)
  if (!exportRVA || !exportSize) return emit(info, exports)

  const exportOffset = rvaToFileOffset(view, exportRVA, sections)
  if (exportOffset === null || !inBounds(view, exportOffset, 40)) {
    info.push('Export Directory: unreadable (outside file data)')
    return emit(info, exports)
  }

  const nameOffset = rvaToFileOffset(view, view.getUint32(exportOffset + 12, true), sections)
  const dllName = nameOffset === null ? '' : readCString(view, nameOffset)
  const ordinalBase = view.getUint32(exportOffset + 16, true)
  const numberOfFunctions = view.getUint32(exportOffset + 20, true)
  const numberOfNames = view.getUint32(exportOffset + 24, true)
  const functionsOffset = rvaToFileOffset(view, view.getUint32(exportOffset + 28, true), sections)
  const namesOffset = rvaToFileOffset(view, view.getUint32(exportOffset + 32, true), sections)
  const ordinalsOffset = rvaToFileOffset(view, view.getUint32(exportOffset + 36, true), sections)

  const namedOrdinals = new Set()
  if (namesOffset !== null && ordinalsOffset !== null && functionsOffset !== null) {
    const count = Math.min(
      numberOfNames,
      MAX_SYMBOLS,
      Math.floor((view.byteLength - namesOffset) / 4),
      Math.floor((view.byteLength - ordinalsOffset) / 2)
    )
    for (let i = 0; i < count; i++) {
      const nameRVA = view.getUint32(namesOffset + i * 4, true)
      const symbolNameOffset = rvaToFileOffset(view, nameRVA, sections)
      const name = symbolNameOffset === null ? '' : readCString(view, symbolNameOffset)
      if (!name) continue
      const index = view.getUint16(ordinalsOffset + i * 2, true)
      namedOrdinals.add(index)
      const ordinal = `ordinal ${index + ordinalBase}`
      if (!inBounds(view, functionsOffset + index * 4, 4)) {
        exports.push({ name, letter: 'T', suffix: ordinal })
        continue
      }
      const functionRVA = view.getUint32(functionsOffset + index * 4, true)
      if (functionRVA >= exportRVA && functionRVA < exportRVA + exportSize) {
        const forwarderOffset = rvaToFileOffset(view, functionRVA, sections)
        const target = forwarderOffset === null ? '?' : readCString(view, forwarderOffset)
        exports.push({ name, letter: 'I', suffix: `-> ${target}, ${ordinal}` })
      } else {
        const section = sectionForRva(functionRVA, sections)
        const letter = section && !(section.characteristics & 0x20000020) ? 'D' : 'T'
        exports.push({ name, letter, suffix: `RVA ${hex(functionRVA)}, ${ordinal}` })
      }
    }
  }

  info.push(infoRow(`Export Directory: ${dllName || '(unnamed)'}`, [
    `DLL Name: ${dllName || '(none)'}`,
    `Ordinal Base: ${ordinalBase}`,
    `Number of Functions: ${numberOfFunctions}`,
    `Number of Names: ${numberOfNames}`,
    numberOfFunctions > namedOrdinals.size && numberOfFunctions <= MAX_SYMBOLS
      ? `Exported by ordinal only (or unused slots): ${numberOfFunctions - namedOrdinals.size}`
      : ''
  ]))

  return emit(info, exports)
}

// ---------------------------------------------------------------- Mach-O

const MH_MAGIC = 0xfeedface
const MH_CIGAM = 0xcefaedfe
const MH_MAGIC_64 = 0xfeedfacf
const MH_CIGAM_64 = 0xcffaedfe
const FAT_MAGIC = 0xcafebabe
const FAT_CIGAM = 0xbebafeca

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

function isMachOFile(view) {
  if (view.byteLength < 4) return false
  if (isThinMachOMagic(view.getUint32(0, false))) return view.byteLength >= 28
  return readFatHeader(view) !== null
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
      const suffix = letter === 'C' ? `size ${value}` : defined ? `@ ${hex(value)}` : ''
      symbols.push({ name, letter, suffix })
    }
  }

  return {
    arch: cpuName(cputype, cpusubtype),
    fileType: MACHO_FILE_TYPES[filetype] || `Unknown (${filetype})`,
    is64Bit,
    littleEndian,
    hasSymtab: symtabs.length > 0,
    symbols
  }
}

function machOImageInfo(image) {
  return [
    `Architecture: ${image.arch}`,
    `File Type: ${image.fileType}`,
    `Class: Mach-O ${image.is64Bit ? '64-bit' : '32-bit'}, ${image.littleEndian ? 'little' : 'big'} endian`,
    image.hasSymtab ? '' : 'Symbol table: none'
  ].filter(Boolean)
}

function parseMachOSymbols(view) {
  try {
    const fat = readFatHeader(view)
    if (!fat) {
      const image = parseMachOImage(view, 0, view.byteLength)
      return emit(machOImageInfo(image), image.symbols)
    }

    const slices = []
    for (let i = 0; i < fat.nfat; i++) {
      const entry = 8 + i * 20
      const cputype = view.getInt32(entry, fat.littleEndian)
      const cpusubtype = view.getInt32(entry + 4, fat.littleEndian)
      const offset = view.getUint32(entry + 8, fat.littleEndian)
      const size = view.getUint32(entry + 12, fat.littleEndian)
      slices.push({ arch: cpuName(cputype, cpusubtype), offset, size })
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

    const info = [infoRow(`Universal Binary: ${slices.map(s => s.arch).join(', ')}`, [
      ...sliceDetails,
      shown ? `Symbols below are from the ${shown.arch} slice` : 'No readable slices'
    ])]
    if (!shown) return new Set(info)
    return emit([...info, ...machOImageInfo(shown)], shown.symbols)
  } catch (err) {
    throw new Error('Invalid Mach-O file structure: ' + err.message)
  }
}

// ---------------------------------------------------------------- ELF

function isELFFile(view) {
  return view.byteLength >= 4 && view.getUint32(0, false) === 0x7F454C46
}

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

function elfInfoRows(machine, is64Bit, littleEndian) {
  const machineName = ELF_MACHINES[machine]
  return [
    infoRow(`Architecture: ${machineName || `Unknown (0x${machine.toString(16)})`}`, [
      'Processor architecture for this binary',
      'Determines the instruction set and register layout',
      'Affects binary compatibility and performance',
      machineName ? `Common in ${machineName.includes('x86') ? 'desktop/server' : 'mobile/embedded'} systems` : ''
    ]),
    infoRow(`Class: ${is64Bit ? 'ELF64' : 'ELF32'}`, [
      is64Bit ? '64-bit format, supports > 4GB address space' : '32-bit format, limited to 4GB address space',
      is64Bit ? 'Larger pointer size (8 bytes)' : 'Smaller pointer size (4 bytes)',
      is64Bit ? 'Better for large applications and modern systems' : 'Common in older or embedded systems',
      `Memory model: ${is64Bit ? 'LP64 (longs and pointers are 64-bit)' : 'ILP32 (ints, longs, and pointers are 32-bit)'}`
    ]),
    infoRow(`Endianness: ${littleEndian ? 'Little Endian' : 'Big Endian'}`, [
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

function parseELFSymbols(view) {
  const elfClass = view.byteLength > 5 ? view.getUint8(4) : 0
  const dataEncoding = view.byteLength > 5 ? view.getUint8(5) : 0
  if (elfClass !== 1 && elfClass !== 2) throw new Error(`ELF parsing error: unsupported ELF class ${elfClass}`)
  if (dataEncoding !== 1 && dataEncoding !== 2) throw new Error(`ELF parsing error: unsupported data encoding ${dataEncoding}`)
  const is64Bit = elfClass === 2
  const le = dataEncoding === 1
  if (view.byteLength < (is64Bit ? 64 : 52)) throw new Error('ELF parsing error: header is truncated')

  const machine = view.getUint16(18, le)
  const info = elfInfoRows(machine, is64Bit, le)
  const symbols = []

  const readAddr = (offset) => is64Bit ? Number(view.getBigUint64(offset, le)) : view.getUint32(offset, le)
  const shoff = readAddr(is64Bit ? 40 : 32)
  const shentsize = view.getUint16(is64Bit ? 58 : 46, le)
  let shnum = view.getUint16(is64Bit ? 60 : 48, le)
  let shstrndx = view.getUint16(is64Bit ? 62 : 50, le)
  const minShentsize = is64Bit ? 64 : 40

  if (!shoff) {
    info.push('Section headers: none (symbols unavailable)')
    return emit(info, symbols)
  }
  if (shentsize < minShentsize || !inBounds(view, shoff, minShentsize)) {
    info.push('Section headers: unreadable (symbols unavailable)')
    return emit(info, symbols)
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
    info.push('Symbol table: none (stripped)')
    return emit(info, symbols)
  }

  const strtab = sections[symtab.link]
  const minEntsize = is64Bit ? 24 : 16
  const entsize = symtab.entsize >= minEntsize && symtab.entsize <= 256 ? symtab.entsize : minEntsize
  const symEnd = Math.min(symtab.offset + symtab.size, view.byteLength)
  const total = symtab.offset < symEnd ? Math.floor((symEnd - symtab.offset) / entsize) : 0
  const strStart = strtab ? strtab.offset : 0
  const strEnd = strtab ? Math.min(strtab.offset + strtab.size, view.byteLength) : 0

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

      const letter = elfSymbolLetter(bind, type, shndx, sections)
      const defined = shndx !== SHN_UNDEF
      const value = is64Bit ? view.getBigUint64(entry + 8, le) : view.getUint32(entry + 4, le)
      symbols.push({ name, letter, suffix: defined ? `@ ${hex(value)}` : '' })
    }
  }

  const symtabName = sectionName(symtab) || (symtab.type === SHT_SYMTAB ? '.symtab' : '.dynsym')
  const strtabName = strtab ? sectionName(strtab) || `section ${symtab.link}` : 'missing'
  info.push(infoRow(`Symbol table: ${symtabName} (${symbols.length} symbols)`, [
    `Read from ${symtabName}, names from ${strtabName}`,
    symtab.type === SHT_DYNSYM ? 'No static symbol table (.symtab); showing dynamic symbols only' : '',
    total > MAX_SYMBOLS ? `Only the first ${MAX_SYMBOLS} of ${total} entries were read` : '',
    'Letters follow nm: T/t code, D/d data, B/b bss, R/r read-only, U undefined, W/w V/v weak; lowercase is local'
  ]))
  return emit(info, symbols)
}

export function analyzeBinary(buffer) {
  const view = new DataView(buffer)

  if (isPEFile(view)) {
    try {
      return parsePEExports(view)
    } catch (err) {
      throw new Error(`PE parsing error: ${err.message}`)
    }
  }

  if (isMachOFile(view)) {
    return parseMachOSymbols(view)
  }

  if (isELFFile(view)) {
    try {
      return parseELFSymbols(view)
    } catch (err) {
      if (err.message.startsWith('ELF parsing error')) throw err
      throw new Error(`ELF parsing error: ${err.message}`)
    }
  }

  return new Set()
}
