import { dataView, hex, inBounds, item, MAX_SYMBOLS, readCString, sortSymbols } from './shared.js'
import {
  createBudget, field, hexBig, hexString, MAX_TABLE_ENTRIES, readStruct, tableNodes, tileRegions, toNumber
} from './binfields.js'

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

const ELF_TYPES = { 0: 'None', 1: 'Relocatable object', 2: 'Executable', 3: 'Shared object', 4: 'Core dump' }
const OS_ABIS = {
  0: 'UNIX System V', 1: 'HP-UX', 2: 'NetBSD', 3: 'GNU/Linux', 6: 'Solaris', 7: 'AIX', 8: 'IRIX',
  9: 'FreeBSD', 12: 'OpenBSD', 64: 'ARM EABI', 97: 'ARM', 255: 'Standalone'
}

const PT_NAMES = {
  0: 'NULL', 1: 'LOAD', 2: 'DYNAMIC', 3: 'INTERP', 4: 'NOTE', 5: 'SHLIB', 6: 'PHDR', 7: 'TLS',
  0x6474e550: 'GNU_EH_FRAME', 0x6474e551: 'GNU_STACK', 0x6474e552: 'GNU_RELRO', 0x6474e553: 'GNU_PROPERTY',
  0x6474e554: 'GNU_SFRAME', 0x65a3dbe6: 'OPENBSD_RANDOMIZE', 0x65a3dbe7: 'OPENBSD_WXNEEDED'
}
const PT_DESCRIPTIONS = {
  1: 'Loadable segment: mapped into memory',
  2: 'Dynamic linking information',
  3: 'Path of the program interpreter (dynamic loader)',
  4: 'Auxiliary notes (build ID, ABI tag, properties)',
  6: 'The program header table itself',
  7: 'Thread-local storage template',
  0x6474e550: 'Exception-handling frame index',
  0x6474e551: 'Stack permissions; no X flag means a non-executable stack',
  0x6474e552: 'Made read-only after relocation (RELRO)',
  0x6474e553: 'GNU property notes'
}

const SHT_NAMES = {
  0: 'NULL', 1: 'PROGBITS', 2: 'SYMTAB', 3: 'STRTAB', 4: 'RELA', 5: 'HASH', 6: 'DYNAMIC', 7: 'NOTE',
  8: 'NOBITS', 9: 'REL', 10: 'SHLIB', 11: 'DYNSYM', 14: 'INIT_ARRAY', 15: 'FINI_ARRAY', 16: 'PREINIT_ARRAY',
  17: 'GROUP', 18: 'SYMTAB_SHNDX', 19: 'RELR', 0x6ffffff5: 'GNU_ATTRIBUTES', 0x6ffffff6: 'GNU_HASH',
  0x6ffffffd: 'GNU_verdef', 0x6ffffffe: 'GNU_verneed', 0x6fffffff: 'GNU_versym'
}

const SHT_SYMTAB = 2
const SHT_STRTAB = 3
const SHT_RELA = 4
const SHT_HASH = 5
const SHT_DYNAMIC = 6
const SHT_NOTE = 7
const SHT_NOBITS = 8
const SHT_REL = 9
const SHT_DYNSYM = 11
const SHT_GNU_HASH = 0x6ffffff6
const SHT_GNU_VERDEF = 0x6ffffffd
const SHT_GNU_VERNEED = 0x6ffffffe
const SHT_GNU_VERSYM = 0x6fffffff
const TABLE_SECTION_TYPES = new Set([
  SHT_SYMTAB, SHT_STRTAB, SHT_RELA, SHT_HASH, SHT_DYNAMIC, SHT_REL, SHT_DYNSYM, 18, 19,
  SHT_GNU_HASH, SHT_GNU_VERDEF, SHT_GNU_VERNEED, SHT_GNU_VERSYM
])

const SHF_WRITE = 0x1
const SHF_ALLOC = 0x2
const SHF_EXECINSTR = 0x4
const SHF_FLAGS = [
  [0x1, 'W'], [0x2, 'A'], [0x4, 'X'], [0x10, 'M'], [0x20, 'S'], [0x40, 'I'], [0x80, 'L'],
  [0x100, 'O'], [0x200, 'G'], [0x400, 'T'], [0x800, 'C'], [0x80000000, 'E']
]

const SHN_UNDEF = 0
const SHN_ABS = 0xfff1
const SHN_COMMON = 0xfff2
const SHN_XINDEX = 0xffff
const PN_XNUM = 0xffff

const PT_LOAD = 1
const PT_DYNAMIC = 2
const PT_INTERP = 3
const PT_NOTE = 4
const PT_GNU_STACK = 0x6474e551
const PT_GNU_RELRO = 0x6474e552
const PF_X = 1

const DT = {
  NULL: 0, NEEDED: 1, PLTRELSZ: 2, PLTGOT: 3, HASH: 4, STRTAB: 5, SYMTAB: 6, RELA: 7, RELASZ: 8, RELAENT: 9,
  STRSZ: 10, SYMENT: 11, INIT: 12, FINI: 13, SONAME: 14, RPATH: 15, SYMBOLIC: 16, REL: 17, RELSZ: 18, RELENT: 19,
  PLTREL: 20, DEBUG: 21, TEXTREL: 22, JMPREL: 23, BIND_NOW: 24, INIT_ARRAY: 25, FINI_ARRAY: 26, INIT_ARRAYSZ: 27,
  FINI_ARRAYSZ: 28, RUNPATH: 29, FLAGS: 30, PREINIT_ARRAY: 32, PREINIT_ARRAYSZ: 33, SYMTAB_SHNDX: 34,
  RELRSZ: 35, RELR: 36, RELRENT: 37
}
const DT_NAMES = Object.fromEntries(Object.entries(DT).map(([name, tag]) => [tag, name]))
Object.assign(DT_NAMES, {
  0x6ffffef5: 'GNU_HASH', 0x6ffffff0: 'VERSYM', 0x6ffffff9: 'RELACOUNT', 0x6ffffffa: 'RELCOUNT',
  0x6ffffffb: 'FLAGS_1', 0x6ffffffc: 'VERDEF', 0x6ffffffd: 'VERDEFNUM', 0x6ffffffe: 'VERNEED', 0x6fffffff: 'VERNEEDNUM'
})
const DT_FLAGS_1 = 0x6ffffffb
const DT_STRING_TAGS = new Set([DT.NEEDED, DT.SONAME, DT.RPATH, DT.RUNPATH])
const DF_BIND_NOW = 0x8
const DF_1_NOW = 0x1
const DF_1_PIE = 0x08000000
const DF_FLAGS = [[0x1, 'ORIGIN'], [0x2, 'SYMBOLIC'], [0x4, 'TEXTREL'], [0x8, 'BIND_NOW'], [0x10, 'STATIC_TLS']]
const DF_1_FLAGS = [
  [0x1, 'NOW'], [0x2, 'GLOBAL'], [0x4, 'GROUP'], [0x8, 'NODELETE'], [0x10, 'LOADFLTR'], [0x20, 'INITFIRST'],
  [0x40, 'NOOPEN'], [0x80, 'ORIGIN'], [0x100, 'DIRECT'], [0x800, 'INTERPOSE'], [0x1000, 'NODEFLIB'],
  [0x8000000, 'PIE']
]

const MAX_DYNAMIC_ENTRIES = 4096
const MAX_NOTES = 256
const MAX_VERSION_ENTRIES = 4096
const MAX_SUMMARY_LIBRARIES = 200
const MAX_SUMMARY_LINES = 200

const flagLetters = (value, table) => table.filter(([bit]) => (value & bit) !== 0).map(([, letter]) => letter).join('')

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

function symbolKind(type, letter) {
  if (type === 2 || type === 10) return 'function'
  if (type === 1 || type === 5 || type === 6) return 'data'
  if (letter === 'T' || letter === 't') return 'function'
  if ('DdBbRrVvCc'.includes(letter)) return 'data'
  return 'other'
}

// Byte range of a table, clipped to the file; null when nothing of it is in the file
function clippedRegion(view, name, offset, length, kind) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= view.byteLength || !(length > 0)) return null
  return { name, offset, length: Math.min(length, view.byteLength - offset), kind }
}

function sectionRegionKind(section) {
  if (section.flags & SHF_EXECINSTR) return 'code'
  if (TABLE_SECTION_TYPES.has(section.type)) return 'table'
  if (section.type === SHT_NOTE || !(section.flags & SHF_ALLOC)) return 'metadata'
  return 'data'
}

function parseELF(view, bytes) {
  const elfClass = view.byteLength > 5 ? view.getUint8(4) : 0
  const dataEncoding = view.byteLength > 5 ? view.getUint8(5) : 0
  if (elfClass !== 1 && elfClass !== 2) throw new Error(`ELF parsing error: unsupported ELF class ${elfClass}`)
  if (dataEncoding !== 1 && dataEncoding !== 2) throw new Error(`ELF parsing error: unsupported data encoding ${dataEncoding}`)
  const is64Bit = elfClass === 2
  const le = dataEncoding === 1
  const A = is64Bit ? 8 : 4 // width of addresses, offsets and sizes
  const headerSize = is64Bit ? 64 : 52
  if (view.byteLength < headerSize) throw new Error('ELF parsing error: header is truncated')

  const budget = createBudget()
  const warnings = []
  const machine = view.getUint16(18, le)
  const summary = headerSummary(machine, is64Bit, le)
  const fmtAddr = value => hexBig(value)

  // ---------------------------------------------------------------- ELF header
  const identChildren = [
    field('EI_CLASS', 4, 1, is64Bit ? 'ELF64' : 'ELF32', 'header', 'Word size: 1 = 32-bit, 2 = 64-bit'),
    field('EI_DATA', 5, 1, le ? 'Little Endian' : 'Big Endian', 'header', 'Byte order: 1 = little endian, 2 = big endian'),
    field('EI_VERSION', 6, 1, String(view.getUint8(6)), 'header', 'ELF identification version (always 1)'),
    field('EI_OSABI', 7, 1, OS_ABIS[view.getUint8(7)] || String(view.getUint8(7)), 'header', 'Operating system / ABI extensions'),
    field('EI_ABIVERSION', 8, 1, String(view.getUint8(8)), 'header', 'ABI version'),
    field('EI_PAD', 9, 7, undefined, 'padding', 'Unused, should be zero')
  ]
  const headerSpec = [
    ['e_type', 2, 'header', 'Object file type', v => `${ELF_TYPES[v] || 'Unknown'} (${v})`],
    ['e_machine', 2, 'header', 'Target instruction set', v => ELF_MACHINES[v] || hex(v)],
    ['e_version', 4, 'header', 'ELF version (always 1)', v => String(v)],
    ['e_entry', A, 'offset', 'Virtual address where execution starts', fmtAddr],
    ['e_phoff', A, 'offset', 'File offset of the program header table', fmtAddr],
    ['e_shoff', A, 'offset', 'File offset of the section header table', fmtAddr],
    ['e_flags', 4, 'flags', 'Processor-specific flags', fmtAddr],
    ['e_ehsize', 2, 'size', 'Size of this header in bytes'],
    ['e_phentsize', 2, 'size', 'Size of one program header entry'],
    ['e_phnum', 2, 'count', 'Number of program header entries'],
    ['e_shentsize', 2, 'size', 'Size of one section header entry'],
    ['e_shnum', 2, 'count', 'Number of section header entries (0 when the real count is in section 0)'],
    ['e_shstrndx', 2, 'count', 'Index of the section holding section names']
  ]
  const header = readStruct(view, 16, headerSpec, le, budget)
  const h = header.values
  // The magic stays a top-level field of its own, like every format's signature
  const fields = [
    field('Magic', 0, 4, '\\x7FELF', 'magic', 'ELF identification'),
    field('e_ident', 4, 12, `${is64Bit ? 'ELF64' : 'ELF32'}, ${le ? 'little' : 'big'} endian`, 'header',
      'Rest of the identification bytes: how to read the file', identChildren),
    field('ELF header', 16, header.end - 16, ELF_TYPES[h.e_type] || 'unknown type', 'header',
      'File type, machine, entry point and the location of the program and section header tables', header.children)
  ]
  const regions = [{ name: 'ELF header', offset: 0, length: headerSize, kind: 'header' }]
  const symbols = []

  const eType = h.e_type
  const phoff = toNumber(h.e_phoff)
  const phentsize = h.e_phentsize
  let phnum = h.e_phnum
  const shoff = toNumber(h.e_shoff)
  const shentsize = h.e_shentsize
  let shnum = h.e_shnum
  let shstrndx = h.e_shstrndx
  const minShentsize = is64Bit ? 64 : 40
  const minPhentsize = is64Bit ? 56 : 32

  // ---------------------------------------------------------------- section headers
  const shSpec = [
    ['sh_name', 4, 'offset', 'Offset of the name in the section name string table'],
    ['sh_type', 4, 'header', 'Section type', v => SHT_NAMES[v] || hex(v)],
    ['sh_flags', A, 'flags', 'W write, A alloc, X execute, M merge, S strings, I info link, G group, T TLS',
      v => `${hexBig(v)}${flagLetters(toNumber(v), SHF_FLAGS) ? ` (${flagLetters(toNumber(v), SHF_FLAGS)})` : ''}`],
    ['sh_addr', A, 'offset', 'Virtual address when loaded (0 if not loaded)', fmtAddr],
    ['sh_offset', A, 'offset', 'File offset of the section contents', fmtAddr],
    ['sh_size', A, 'size', 'Size of the section in bytes', fmtAddr],
    ['sh_link', 4, 'count', 'Index of a related section (e.g. the string table of a symbol table)'],
    ['sh_info', 4, 'count', 'Extra information, depends on the type'],
    ['sh_addralign', A, 'size', 'Required alignment'],
    ['sh_entsize', A, 'size', 'Size of each entry for tables of fixed-size entries']
  ]
  const readSection = (index) => {
    const offset = shoff + index * shentsize
    const word = (at64, at32) => toNumber(is64Bit ? view.getBigUint64(offset + at64, le) : view.getUint32(offset + at32, le))
    return {
      index,
      name: view.getUint32(offset, le),
      type: view.getUint32(offset + 4, le),
      flags: word(8, 8),
      addr: word(16, 12),
      offset: word(24, 16),
      size: word(32, 20),
      link: view.getUint32(offset + (is64Bit ? 40 : 24), le),
      info: view.getUint32(offset + (is64Bit ? 44 : 28), le),
      addralign: word(48, 32),
      entsize: word(56, 36),
      label: ''
    }
  }

  const sections = []
  let sectionNote = ''
  if (!shoff) {
    sectionNote = 'none (symbols unavailable)'
  } else if (shentsize < minShentsize || !inBounds(view, shoff, minShentsize)) {
    sectionNote = 'unreadable (symbols unavailable)'
  } else {
    // Extended numbering: the real counts live in section header 0
    const first = readSection(0)
    if (shnum === 0) shnum = first.size
    if (shstrndx === SHN_XINDEX) shstrndx = first.link
    if (phnum === PN_XNUM) phnum = first.info
    const fits = Math.floor((view.byteLength - shoff) / shentsize)
    const count = Math.min(shnum, fits, 65536)
    for (let i = 0; i < count; i++) sections.push(readSection(i))
    if (count < shnum) warnings.push(`Section header table truncated: ${count} of ${shnum} entries readable`)
  }

  const shstrtab = sections[shstrndx]
  if (shstrtab && shstrtab.type === SHT_STRTAB) {
    const end = Math.min(shstrtab.offset + shstrtab.size, view.byteLength)
    for (const section of sections) {
      if (section.name < shstrtab.size) section.label = readCString(view, shstrtab.offset + section.name, end)
    }
  }
  const findSection = (name) => sections.find(s => s.label === name)
  const hasFileData = s => s.type !== SHT_NOBITS && s.size > 0 && s.offset < view.byteLength

  // ---------------------------------------------------------------- program headers
  const phSpec = is64Bit
    ? [
        ['p_type', 4, 'header', 'Segment type', v => PT_NAMES[v] || hex(v)],
        ['p_flags', 4, 'flags', 'Permissions: R read, W write, X execute', v => segmentFlags(v)],
        ['p_offset', 8, 'offset', 'File offset of the segment', fmtAddr],
        ['p_vaddr', 8, 'offset', 'Virtual address in memory', fmtAddr],
        ['p_paddr', 8, 'offset', 'Physical address (usually equal to p_vaddr)', fmtAddr],
        ['p_filesz', 8, 'size', 'Bytes taken in the file', fmtAddr],
        ['p_memsz', 8, 'size', 'Bytes taken in memory (larger than p_filesz for .bss)', fmtAddr],
        ['p_align', 8, 'size', 'Alignment in file and memory', fmtAddr]
      ]
    : [
        ['p_type', 4, 'header', 'Segment type', v => PT_NAMES[v] || hex(v)],
        ['p_offset', 4, 'offset', 'File offset of the segment', fmtAddr],
        ['p_vaddr', 4, 'offset', 'Virtual address in memory', fmtAddr],
        ['p_paddr', 4, 'offset', 'Physical address (usually equal to p_vaddr)', fmtAddr],
        ['p_filesz', 4, 'size', 'Bytes taken in the file', fmtAddr],
        ['p_memsz', 4, 'size', 'Bytes taken in memory (larger than p_filesz for .bss)', fmtAddr],
        ['p_flags', 4, 'flags', 'Permissions: R read, W write, X execute', v => segmentFlags(v)],
        ['p_align', 4, 'size', 'Alignment in file and memory', fmtAddr]
      ]
  const segments = []
  if (phoff && phnum && phentsize >= minPhentsize && phoff < view.byteLength) {
    const fits = Math.floor((view.byteLength - phoff) / phentsize)
    const count = Math.min(phnum, fits, 65536)
    for (let i = 0; i < count; i++) {
      const v = readStruct(view, phoff + i * phentsize, phSpec, le, null).values
      segments.push({
        index: i,
        type: v.p_type,
        flags: v.p_flags,
        offset: toNumber(v.p_offset),
        vaddr: toNumber(v.p_vaddr),
        filesz: toNumber(v.p_filesz),
        memsz: toNumber(v.p_memsz)
      })
    }
    if (count < phnum) warnings.push(`Program header table truncated: ${count} of ${phnum} entries readable`)
    const nodes = tableNodes(view, phoff, count, phentsize, budget, (i, at) => {
      const s = segments[i]
      const { children } = readStruct(view, at, phSpec, le, budget)
      budget.left--
      return field(`[${i}] ${PT_NAMES[s.type] || hex(s.type)}`, at, phentsize,
        `${segmentFlags(s.flags)}, offset ${hex(s.offset)}, ${hex(s.filesz)} bytes`, 'header',
        PT_DESCRIPTIONS[s.type] || 'Program header', children)
    }, 'program headers')
    if (nodes.length) {
      fields.push(field('Program header table', phoff, count * phentsize, `${count} entries`, 'header',
        'Segments: how the file is mapped into memory at run time', nodes))
      regions.push({ name: 'Program header table', offset: phoff, length: count * phentsize, kind: 'header' })
    }
  }

  // Virtual address -> file offset through the loadable segments
  const loads = segments.filter(s => s.type === PT_LOAD)
  const addressToOffset = (address) => {
    for (const s of loads) {
      if (address >= s.vaddr && address < s.vaddr + s.filesz) {
        const offset = s.offset + (address - s.vaddr)
        return offset < view.byteLength ? offset : null
      }
    }
    return null
  }
  const segmentOf = type => segments.find(s => s.type === type)

  // ---------------------------------------------------------------- interpreter
  let interpreter = ''
  const interpSegment = segmentOf(PT_INTERP)
  const interpSection = findSection('.interp')
  const interpRange = interpSection && hasFileData(interpSection)
    ? { offset: interpSection.offset, size: interpSection.size }
    : interpSegment && { offset: interpSegment.offset, size: interpSegment.filesz }
  if (interpRange && interpRange.size > 0 && inBounds(view, interpRange.offset, 1)) {
    interpreter = readCString(view, interpRange.offset, interpRange.offset + interpRange.size)
    const length = Math.min(interpRange.size, view.byteLength - interpRange.offset)
    if (budget.left-- > 0) {
      fields.push(field('Interpreter', interpRange.offset, length, interpreter, 'string',
        'Program that loads this executable and its libraries'))
    }
  }

  // ---------------------------------------------------------------- dynamic section
  const dynamic = { needed: [], soname: '', rpath: '', runpath: '', flags: 0, flags1: 0, bindNow: false, tags: [] }
  const dynSegment = segmentOf(PT_DYNAMIC)
  const dynSection = sections.find(s => s.type === SHT_DYNAMIC)
  const dynRange = dynSection && hasFileData(dynSection)
    ? { offset: dynSection.offset, size: dynSection.size }
    : dynSegment && dynSegment.filesz > 0 ? { offset: dynSegment.offset, size: dynSegment.filesz } : null
  if (dynRange && inBounds(view, dynRange.offset, 2 * A)) {
    const entrySize = 2 * A
    const limit = Math.min(Math.floor(dynRange.size / entrySize), Math.floor((view.byteLength - dynRange.offset) / entrySize), MAX_DYNAMIC_ENTRIES)
    for (let i = 0; i < limit; i++) {
      const at = dynRange.offset + i * entrySize
      const tag = toNumber(is64Bit ? view.getBigInt64(at, le) : view.getInt32(at, le))
      const value = toNumber(is64Bit ? view.getBigUint64(at + 8, le) : view.getUint32(at + 4, le))
      dynamic.tags.push({ tag, value, at })
      if (tag === DT.NULL) break
    }
    // Strings come from DT_STRTAB (an address), or from the section named by sh_link
    const strtabAddress = dynamic.tags.find(t => t.tag === DT.STRTAB)
    const strtabSize = dynamic.tags.find(t => t.tag === DT.STRSZ)
    let strStart = strtabAddress ? addressToOffset(strtabAddress.value) : null
    let strEnd = strStart !== null && strtabSize ? Math.min(strStart + strtabSize.value, view.byteLength) : view.byteLength
    if (strStart === null && dynSection && sections[dynSection.link]) {
      const linked = sections[dynSection.link]
      strStart = linked.offset
      strEnd = Math.min(linked.offset + linked.size, view.byteLength)
    }
    const dynString = value => (strStart === null || strStart + value >= strEnd ? '' : readCString(view, strStart + value, strEnd))
    const nodes = []
    for (const entry of dynamic.tags) {
      const { tag, value } = entry
      let shown = hex(value)
      if (DT_STRING_TAGS.has(tag)) {
        const text = dynString(value)
        shown = text || `string at ${hex(value)} (unreadable)`
        if (tag === DT.NEEDED && text) dynamic.needed.push(text)
        else if (tag === DT.SONAME) dynamic.soname = text
        else if (tag === DT.RPATH) dynamic.rpath = text
        else if (tag === DT.RUNPATH) dynamic.runpath = text
      } else if (tag === DT.FLAGS) {
        dynamic.flags = value
        shown = decodeNames(value, DF_FLAGS) || hex(value)
      } else if (tag === DT_FLAGS_1) {
        dynamic.flags1 = value
        shown = decodeNames(value, DF_1_FLAGS) || hex(value)
      } else if (tag === DT.BIND_NOW) {
        dynamic.bindNow = true
      }
      if (nodes.length < MAX_TABLE_ENTRIES && budget.left > 0) {
        budget.left--
        nodes.push(field(DT_NAMES[tag] || `Tag ${hex(tag >>> 0)}`, entry.at, entrySize, shown, DT_STRING_TAGS.has(tag) ? 'string' : 'data'))
      }
    }
    if ((dynamic.flags & DF_BIND_NOW) || (dynamic.flags1 & DF_1_NOW)) dynamic.bindNow = true
    if (nodes.length) {
      const last = nodes[nodes.length - 1]
      fields.push(field('Dynamic section', dynRange.offset, last.offset + last.length - dynRange.offset, `${dynamic.tags.length} entries`, 'table',
        'Libraries to load and tables the dynamic linker uses', nodes))
    }
  }

  // ---------------------------------------------------------------- notes
  const notes = []
  const noteRanges = sections.length
    ? sections.filter(s => s.type === SHT_NOTE && hasFileData(s)).map(s => ({ offset: s.offset, size: s.size, align: s.addralign, name: s.label }))
    : segments.filter(s => s.type === PT_NOTE && s.filesz > 0).map(s => ({ offset: s.offset, size: s.filesz, align: 4, name: '(PT_NOTE)' }))
  const seenNoteRanges = new Set()
  for (const range of noteRanges) {
    if (seenNoteRanges.has(range.offset) || notes.length >= MAX_NOTES) continue
    seenNoteRanges.add(range.offset)
    const align = range.align === 8 ? 8 : 4
    const end = Math.min(range.offset + range.size, view.byteLength)
    const nodes = []
    let at = range.offset
    while (at + 12 <= end && notes.length < MAX_NOTES) {
      const namesz = view.getUint32(at, le)
      const descsz = view.getUint32(at + 4, le)
      const type = view.getUint32(at + 8, le)
      const nameAt = at + 12
      const descAt = nameAt + alignUp(namesz, 4)
      if (descAt + descsz > end) break
      const next = Math.min(descAt + alignUp(descsz, align), end)
      const owner = readCString(view, nameAt, nameAt + namesz)
      const note = { owner, type, descAt, descsz, meaning: null }
      note.meaning = describeNote(view, note, le, is64Bit)
      notes.push(note)
      if (budget.left > 5) {
        budget.left -= 6
        nodes.push(field(`${owner || '(no owner)'} ${note.meaning.type}`, at, next - at, note.meaning.value, 'data', note.meaning.description, [
          field('namesz', at, 4, String(namesz), 'size', 'Length of the owner name'),
          field('descsz', at + 4, 4, String(descsz), 'size', 'Length of the note data'),
          field('type', at + 8, 4, `${note.meaning.type} (${type})`, 'header', 'Note type, interpreted per owner'),
          namesz ? field('name', nameAt, namesz, owner, 'string', 'Owner of the note') : null,
          descsz ? field('desc', descAt, descsz, note.meaning.value, 'data', 'Note data') : null
        ].filter(Boolean)))
      }
      at = next
    }
    if (nodes.length) {
      fields.push(field(`Notes ${range.name}`, range.offset, end - range.offset, `${nodes.length} note${nodes.length === 1 ? '' : 's'}`, 'data',
        'Auxiliary information such as the build ID and the target ABI', nodes))
    }
  }

  // ---------------------------------------------------------------- section header table node and regions
  if (sections.length) {
    const nodes = tableNodes(view, shoff, sections.length, shentsize, budget, (i, at) => {
      const s = sections[i]
      const { children } = readStruct(view, at, shSpec, le, budget)
      budget.left--
      return field(`[${i}] ${s.label || (i === 0 ? '(null)' : '(unnamed)')}`, at, shentsize,
        `${SHT_NAMES[s.type] || hex(s.type)}, ${s.type === SHT_NOBITS ? 'no file data' : `offset ${hex(s.offset)}`}, ${hex(s.size)} bytes`,
        'header', 'Section header', children)
    }, 'section headers')
    fields.push(field('Section header table', shoff, sections.length * shentsize, `${sections.length} entries`, 'header',
      'Sections: the linker\'s view of the file (code, data, symbols, debug info)', nodes))
    regions.push({ name: 'Section header table', offset: shoff, length: sections.length * shentsize, kind: 'table' })
    for (const s of sections) {
      if (s.index === 0 || !hasFileData(s)) continue
      const region = clippedRegion(view, s.label || `Section ${s.index}`, s.offset, s.size, sectionRegionKind(s))
      if (region) regions.push(region)
    }
  } else {
    for (const s of loads) {
      const region = clippedRegion(view, `LOAD segment ${s.index} (${segmentFlags(s.flags)})`, s.offset, s.filesz, s.flags & PF_X ? 'code' : 'data')
      if (region) regions.push(region)
    }
  }
  fields.sort((a, b) => a.offset - b.offset)

  // ---------------------------------------------------------------- symbols
  const versions = readVersions(view, sections, le)
  const symtab = sections.find(s => s.type === SHT_SYMTAB && s.size > 0)
  const dynsym = sections.find(s => s.type === SHT_DYNSYM && s.size > 0)
  // nm shows .symtab when present and falls back to .dynsym for stripped binaries
  const shown = symtab || dynsym
  const importLibraries = new Map() // import name -> library, from symbol versions
  const dynamicImports = new Set()
  const isArm = machine === 0x28

  const readTable = (table, collect) => {
    const strtab = sections[table.link]
    const minEntsize = is64Bit ? 24 : 16
    const entsize = table.entsize >= minEntsize && table.entsize <= 256 ? table.entsize : minEntsize
    const symEnd = Math.min(table.offset + table.size, view.byteLength)
    const total = table.offset < symEnd ? Math.floor((symEnd - table.offset) / entsize) : 0
    const strStart = strtab ? strtab.offset : 0
    const strEnd = strtab ? Math.min(strtab.offset + strtab.size, view.byteLength) : 0
    if (!strtab || strtab.type !== SHT_STRTAB || strStart >= strEnd) return { total, read: 0 }
    const versioned = table === dynsym && versions
    let read = 0
    for (let i = 1; i < Math.min(total, MAX_SYMBOLS); i++) {
      const entry = table.offset + i * entsize
      const nameIndex = view.getUint32(entry, le)
      const symInfo = view.getUint8(entry + (is64Bit ? 4 : 12))
      const shndx = view.getUint16(entry + (is64Bit ? 6 : 14), le)
      const type = symInfo & 0xf
      const bind = symInfo >> 4
      if (type === 3 || type === 4) continue // STT_SECTION, STT_FILE
      if (!nameIndex || strStart + nameIndex >= strEnd) continue
      let name = readCString(view, strStart + nameIndex, strEnd)
      if (!name) continue
      let library = ''
      if (versioned) {
        const v = versions.forSymbol(i)
        if (v && v.name !== name) {
          if (shndx === SHN_UNDEF) {
            library = v.file
            name = `${name}@${v.name}`
          } else {
            name = `${name}${v.hidden ? '@' : '@@'}${v.name}`
          }
        }
      }
      collect(name, { entry, type, bind, shndx, library })
      read++
    }
    return { total, read }
  }

  if (dynsym) {
    readTable(dynsym, (name, s) => {
      if (s.shndx !== SHN_UNDEF) return
      dynamicImports.add(name.split('@')[0])
      if (s.library) importLibraries.set(name, s.library)
    })
  }

  if (shown) {
    const strtab = sections[shown.link]
    const symbolInfo = readTable(shown, (name, s) => {
      const letter = elfSymbolLetter(s.bind, s.type, s.shndx, sections)
      const symbol = { name, type: letter, kind: symbolKind(s.type, letter) }
      if (s.shndx === SHN_UNDEF) {
        const library = s.library || importLibraries.get(name)
        if (library) {
          symbol.library = library
          symbol.note = library
          symbol.reason = `Imported from ${library}: its code is not in this file`
        } else {
          symbol.reason = 'Undefined here: resolved from another file at link or load time'
        }
        symbols.push(symbol)
        return
      }
      const value = is64Bit ? view.getBigUint64(s.entry + 8, le) : view.getUint32(s.entry + 4, le)
      const size = toNumber(is64Bit ? view.getBigUint64(s.entry + 16, le) : view.getUint32(s.entry + 8, le))
      symbol.address = hexBig(value)
      if (size > 0) symbol.size = size
      const located = symbolOffset(toNumber(value), s, sections, eType, addressToOffset, isArm && s.type === 2, view.byteLength)
      if (typeof located === 'number') symbol.offset = located
      else symbol.reason = located
      symbols.push(symbol)
    })
    const symtabName = shown.label || (shown.type === SHT_SYMTAB ? '.symtab' : '.dynsym')
    const strtabName = strtab ? strtab.label || `section ${shown.link}` : 'missing'
    summary.push(item('Symbol table', `${symtabName} (${symbolInfo.read} symbols)`, [
      `Read from ${symtabName}, names from ${strtabName}`,
      shown.type === SHT_DYNSYM ? 'No static symbol table (.symtab); showing dynamic symbols only' : '',
      symbolInfo.total > MAX_SYMBOLS ? `Only the first ${MAX_SYMBOLS} of ${symbolInfo.total} entries were read` : '',
      'Letters follow nm: T/t code, D/d data, B/b bss, R/r read-only, U undefined, W/w V/v weak; lowercase is local'
    ]))
  } else if (sectionNote) {
    summary.push(item('Section headers', sectionNote))
  } else {
    summary.push(item('Symbol table', 'none (stripped)'))
  }

  // ---------------------------------------------------------------- first-look facts
  // Older linkers do not set DF_1_PIE; an interpreter without a soname then marks an executable
  const isPie = eType === 3 && (Boolean(dynamic.flags1 & DF_1_PIE) || (Boolean(interpreter) && !dynamic.soname))
  const typeText = eType === 1 ? 'Relocatable object'
    : eType === 2 ? 'Executable'
      : eType === 3 ? (isPie ? 'Position-independent executable (PIE)' : 'Shared object')
        : eType === 4 ? 'Core dump' : `Unknown (${eType})`
  const linked = eType === 2 || eType === 3
  summary.push(item('Type', typeText, [
    linked ? `Linkage: ${dynRange || interpreter ? 'dynamic' : 'static'}` : '',
    eType === 3 && !isPie ? 'ELF type DYN without the PIE flag: a library' : '',
    eType === 3 && !isPie && interpreter ? 'Has a program interpreter, so it can also be run directly' : '',
    isPie ? (dynamic.flags1 & DF_1_PIE ? 'DT_FLAGS_1 has the PIE flag' : 'ELF type DYN with a program interpreter') : ''
  ]))
  if (h.e_entry !== undefined && toNumber(h.e_entry) !== 0) summary.push(item('Entry point', hexBig(h.e_entry)))
  if (interpreter) summary.push(item('Interpreter', interpreter))
  const buildId = notes.find(n => n.owner === 'GNU' && n.type === 3)
  if (buildId) summary.push(item('Build ID', buildId.meaning.value))
  const abiTag = notes.find(n => n.owner === 'GNU' && n.type === 1)
  if (abiTag && abiTag.meaning.value) summary.push(item('ABI tag', abiTag.meaning.value))
  if (eType !== 4) {
    const debug = sections.some(s => s.label.startsWith('.debug_info') || s.label.startsWith('.zdebug_info'))
    summary.push(item('Stripped', sections.length === 0 ? 'unknown (no section headers)' : symtab ? 'no' : 'yes', [
      sections.length && !symtab ? 'No .symtab: only dynamic symbols remain' : '',
      sections.length ? `Debug info: ${debug ? 'yes (DWARF sections present)' : 'no'}` : ''
    ]))
  }

  // Libraries
  const perLibrary = new Map()
  for (const library of importLibraries.values()) perLibrary.set(library, (perLibrary.get(library) || 0) + 1)
  for (const library of dynamic.needed.slice(0, MAX_SUMMARY_LIBRARIES)) {
    const count = perLibrary.get(library) || 0
    summary.push(item('Needed', library, [count ? `${count} versioned import${count === 1 ? '' : 's'} resolved to this library` : ''], 'Libraries'))
  }
  if (dynamic.needed.length > MAX_SUMMARY_LIBRARIES) {
    summary.push(item('Needed', `${dynamic.needed.length - MAX_SUMMARY_LIBRARIES} more`, null, 'Libraries'))
  }
  if (dynamic.soname) summary.push(item('Soname', dynamic.soname, ['Name that programs linking against this library record'], 'Libraries'))
  if (dynamic.rpath) summary.push(item('RPATH', dynamic.rpath, ['Library search path, searched before LD_LIBRARY_PATH'], 'Libraries'))
  if (dynamic.runpath) summary.push(item('RUNPATH', dynamic.runpath, ['Library search path, searched after LD_LIBRARY_PATH'], 'Libraries'))

  // Security
  if (linked) {
    const stack = segmentOf(PT_GNU_STACK)
    summary.push(item('NX stack', stack ? (stack.flags & PF_X ? 'no (executable stack)' : 'yes') : 'unknown (no PT_GNU_STACK)', [
      stack ? 'From the flags of the PT_GNU_STACK program header' : 'Without PT_GNU_STACK the loader decides; on x86 Linux the stack is then executable'
    ], 'Security'))
    summary.push(item('PIE', eType === 2 ? 'no (fixed load address)' : isPie ? 'yes' : 'n/a (shared library, always relocatable)', [
      'Position-independent executables can be loaded at a random address (ASLR)'
    ], 'Security'))
    const relro = segmentOf(PT_GNU_RELRO)
    summary.push(item('RELRO', relro ? (dynamic.bindNow ? 'full' : 'partial') : 'none', [
      'Relocation read-only: data the loader writes once is made read-only afterwards',
      relro ? 'PT_GNU_RELRO present' : 'No PT_GNU_RELRO program header',
      relro && dynamic.bindNow ? 'Symbols are bound at load time (BIND_NOW), so the GOT is read-only too' : '',
      relro && !dynamic.bindNow ? 'Lazy binding: the PLT part of the GOT stays writable' : ''
    ], 'Security'))
  }
  // Hardening evidence comes from what the file imports. A statically linked
  // program carries libc inside, so there the definitions count instead.
  const isStatic = linked && !dynRange && !interpreter
  const referenced = new Set(dynamicImports)
  for (const s of symbols) {
    if (s.type === 'U' || s.type === 'w' || s.type === 'v' || isStatic) referenced.add(s.name.split('@')[0])
  }
  if (referenced.size) {
    const canary = ['__stack_chk_fail', '__stack_chk_guard', '__intel_security_cookie'].filter(n => referenced.has(n))
    summary.push(item('Stack canary', canary.length ? 'yes' : 'no evidence', [
      canary.length ? `References ${canary.join(', ')}` : 'No reference to __stack_chk_fail',
      'Stack protectors detect overwritten return addresses'
    ], 'Security'))
    const fortified = [...referenced].filter(n => /^__\w+_chk$/.test(n) && n !== '__stack_chk_fail' && n !== '__stack_chk_guard').sort()
    summary.push(item('FORTIFY', fortified.length ? `yes (${fortified.length} checked function${fortified.length === 1 ? '' : 's'})` : 'no evidence', [
      fortified.length ? fortified.slice(0, 40).join(', ') : 'No calls to checked variants such as __memcpy_chk',
      '_FORTIFY_SOURCE replaces risky libc calls with bounds-checked ones'
    ], 'Security'))
  }
  for (const note of notes) {
    const security = note.meaning.security
    if (security) summary.push(item(security.label, security.value, security.details, 'Security'))
  }

  // Sections and segments
  if (sections.length > 1) {
    summary.push(item('Sections', `${sections.length - 1}`, sections.slice(1, MAX_SUMMARY_LINES).map(s => {
      const flags = flagLetters(s.flags, SHF_FLAGS)
      return `${s.label || '(unnamed)'}  ${SHT_NAMES[s.type] || hex(s.type)}  ${hex(s.size)} bytes${flags ? `  [${flags}]` : ''}`
    }), 'Sections'))
  }
  if (segments.length) {
    summary.push(item('Segments', `${segments.length}`, segments.slice(0, MAX_SUMMARY_LINES).map(s =>
      `${PT_NAMES[s.type] || hex(s.type)}  ${segmentFlags(s.flags)}  offset ${hex(s.offset)}  ${hex(s.filesz)} bytes`
    ), 'Sections'))
  }

  return {
    summary,
    fields,
    regions: tileRegions(regions, view.byteLength, 'Not in any section', bytes),
    symbols: sortSymbols(symbols),
    warnings
  }
}

function symbolOffset(value, s, sections, eType, addressToOffset, thumb, fileSize) {
  if (s.shndx === SHN_ABS) return 'Absolute value, not an address in the file'
  if (s.shndx === SHN_COMMON) return 'Common symbol: allocated by the linker, no bytes in this file'
  if (s.shndx >= 0xff00) return 'Special section index, no bytes in the file'
  const section = sections[s.shndx]
  // ARM Thumb functions have the low bit of their address set
  const address = thumb ? value - (value % 2) : value
  if (section) {
    if (section.type === SHT_NOBITS) return `In ${section.label || 'a NOBITS section'}: zero-initialised at run time, no bytes in the file`
    const delta = eType === 1 ? address : address - section.addr
    if (delta >= 0 && delta < Math.max(section.size, 1) && section.offset + delta < fileSize) return section.offset + delta
  }
  const viaSegment = eType === 1 ? null : addressToOffset(address)
  if (viaSegment !== null) return viaSegment
  return 'Address is not backed by bytes in this file'
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment
}

function segmentFlags(flags) {
  return `${flags & 4 ? 'R' : '-'}${flags & 2 ? 'W' : '-'}${flags & 1 ? 'X' : '-'}`
}

function decodeNames(value, table) {
  return table.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name).join(' ')
}

const X86_FEATURES = [[1, 'IBT'], [2, 'SHSTK']]
const AARCH64_FEATURES = [[1, 'BTI'], [2, 'PAC']]

function describeNote(view, note, le, is64Bit) {
  const { owner, type, descAt, descsz } = note
  if (owner === 'GNU') {
    if (type === 3) return { type: 'NT_GNU_BUILD_ID', value: hexString(view, descAt, Math.min(descsz, 64)), description: 'Unique build ID, used to find matching debug symbols' }
    if (type === 1 && descsz >= 16) {
      const os = ['Linux', 'GNU', 'Solaris', 'FreeBSD'][view.getUint32(descAt, le)] || 'unknown OS'
      const version = [4, 8, 12].map(o => view.getUint32(descAt + o, le)).join('.')
      return { type: 'NT_GNU_ABI_TAG', value: `${os} ${version}`, description: 'Oldest kernel ABI this binary supports' }
    }
    if (type === 5) return describeProperties(view, descAt, descsz, le, is64Bit)
    if (type === 4) return { type: 'NT_GNU_GOLD_VERSION', value: readCString(view, descAt, descAt + descsz), description: 'Version of the gold linker' }
  }
  if (owner === 'Go' && type === 4) return { type: 'Go build ID', value: readCString(view, descAt, descAt + descsz), description: 'Build ID written by the Go toolchain' }
  if (owner === 'stapsdt') return { type: 'SystemTap probe', value: '', description: 'Static tracing probe location' }
  return { type: `type ${type}`, value: '', description: 'Note' }
}

function describeProperties(view, start, size, le, is64Bit) {
  const align = is64Bit ? 8 : 4
  const end = start + size
  const found = []
  let security = null
  let at = start
  for (let i = 0; i < 64 && at + 8 <= end; i++) {
    const prType = view.getUint32(at, le)
    const dataSize = view.getUint32(at + 4, le)
    if (at + 8 + dataSize > end) break
    if ((prType === 0xc0000002 || prType === 0xc0000000) && dataSize >= 4) {
      const x86 = prType === 0xc0000002
      const names = decodeNames(view.getUint32(at + 8, le), x86 ? X86_FEATURES : AARCH64_FEATURES)
      found.push(`${x86 ? 'x86' : 'AArch64'} features: ${names || 'none'}`)
      security = {
        label: x86 ? 'CET' : 'BTI / PAC',
        value: names ? names.split(' ').join(', ') : 'not enabled',
        details: [x86
          ? 'Intel control-flow enforcement: IBT checks indirect branch targets, SHSTK keeps a shadow stack'
          : 'Branch target identification and pointer authentication']
      }
    }
    at += alignUp(8 + dataSize, align)
  }
  return { type: 'NT_GNU_PROPERTY_TYPE_0', value: found.join('; '), description: 'Properties such as control-flow protection features', security }
}

// Symbol versioning: .gnu.version holds one index per dynamic symbol. The
// index names an entry of .gnu.version_r (a version required from a library,
// which tells us the library) or of .gnu.version_d (a version this file defines).
function readVersions(view, sections, le) {
  const versym = sections.find(s => s.type === SHT_GNU_VERSYM && s.size > 0)
  if (!versym) return null
  const byIndex = new Map()
  const readStringFrom = (section, offset) => {
    if (!section) return ''
    const end = Math.min(section.offset + section.size, view.byteLength)
    return offset < section.size ? readCString(view, section.offset + offset, end) : ''
  }
  const verneed = sections.find(s => s.type === SHT_GNU_VERNEED)
  if (verneed) {
    const strings = sections[verneed.link]
    let at = verneed.offset
    for (let n = 0; n < MAX_VERSION_ENTRIES && inBounds(view, at, 16) && at < verneed.offset + verneed.size; n++) {
      const count = view.getUint16(at + 2, le)
      const file = readStringFrom(strings, view.getUint32(at + 4, le))
      let aux = at + view.getUint32(at + 8, le)
      for (let j = 0; j < Math.min(count, MAX_VERSION_ENTRIES) && inBounds(view, aux, 16); j++) {
        const other = view.getUint16(aux + 6, le)
        byIndex.set(other & 0x7fff, { name: readStringFrom(strings, view.getUint32(aux + 8, le)), file, hidden: false })
        const next = view.getUint32(aux + 12, le)
        if (!next) break
        aux += next
      }
      const next = view.getUint32(at + 12, le)
      if (!next) break
      at += next
    }
  }
  const verdef = sections.find(s => s.type === SHT_GNU_VERDEF)
  if (verdef) {
    const strings = sections[verdef.link]
    let at = verdef.offset
    for (let n = 0; n < MAX_VERSION_ENTRIES && inBounds(view, at, 20) && at < verdef.offset + verdef.size; n++) {
      const flags = view.getUint16(at + 2, le)
      const index = view.getUint16(at + 4, le)
      const auxAt = at + view.getUint32(at + 12, le)
      // The base definition (VER_FLG_BASE) names the file itself, which nm does not print
      if (!(flags & 1) && inBounds(view, auxAt, 8)) {
        byIndex.set(index, { name: readStringFrom(strings, view.getUint32(auxAt, le)), file: '', hidden: false })
      }
      const next = view.getUint32(at + 16, le)
      if (!next) break
      at += next
    }
  }
  const versymEnd = Math.min(versym.offset + versym.size, view.byteLength)
  return {
    forSymbol(index) {
      const at = versym.offset + index * 2
      if (at + 2 > versymEnd) return null
      const raw = view.getUint16(at, le)
      const v = byIndex.get(raw & 0x7fff)
      if (!v || !v.name) return null
      return raw & 0x8000 ? { ...v, hidden: true } : v
    }
  }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'elf',
  name: 'Linux ELF Executable',
  category: 'executable',
  detect: bytes => bytes.length >= 4 && bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46,
  parse(bytes) {
    try {
      return parseELF(dataView(bytes), bytes)
    } catch (err) {
      if (err.message.startsWith('ELF parsing error')) throw err
      throw new Error(`ELF parsing error: ${err.message}`)
    }
  }
}
