import { dataView, decodeFlags, hex, inBounds, item, MAX_SYMBOLS, readCString, readFixedString, sortSymbols } from './shared.js'
import { createBudget, field, hexBig, hexString, MAX_TABLE_ENTRIES, readStruct, tileRegions, toNumber } from './binfields.js'

const MAX_LOAD_COMMANDS = 65536
const MAX_FAT_ARCHS = 32
const MAX_SECTIONS = 4096
const MAX_SUMMARY_LINES = 200

const MH_MAGIC = 0xfeedface
const MH_CIGAM = 0xcefaedfe
const MH_MAGIC_64 = 0xfeedfacf
const MH_CIGAM_64 = 0xcffaedfe
const FAT_MAGIC = 0xcafebabe
const FAT_CIGAM = 0xbebafeca

// Byte order is reported by the Class summary item, not in the name
const MAGIC_NAMES = {
  [MH_MAGIC]: 'Mach-O 32-bit',
  [MH_MAGIC_64]: 'Mach-O 64-bit',
  [MH_CIGAM]: 'Mach-O 32-bit',
  [MH_CIGAM_64]: 'Mach-O 64-bit',
  [FAT_MAGIC]: 'Universal Binary',
  [FAT_CIGAM]: 'Universal Binary'
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
  3: 'Fixed VM shared library',
  4: 'Core dump',
  5: 'Preloaded executable',
  6: 'Dynamic library',
  7: 'Dynamic linker',
  8: 'Bundle',
  9: 'Dynamic library stub',
  10: 'Debug symbols (dSYM)',
  11: 'Kernel extension',
  12: 'Fileset'
}

const MH_FLAGS = [
  [0x1, 'NOUNDEFS'], [0x2, 'INCRLINK'], [0x4, 'DYLDLINK'], [0x8, 'BINDATLOAD'], [0x10, 'PREBOUND'],
  [0x20, 'SPLIT_SEGS'], [0x80, 'TWOLEVEL'], [0x100, 'FORCE_FLAT'], [0x200, 'NOMULTIDEFS'],
  [0x400, 'NOFIXPREBINDING'], [0x800, 'PREBINDABLE'], [0x1000, 'ALLMODSBOUND'], [0x2000, 'SUBSECTIONS_VIA_SYMBOLS'],
  [0x4000, 'CANONICAL'], [0x8000, 'WEAK_DEFINES'], [0x10000, 'BINDS_TO_WEAK'], [0x20000, 'ALLOW_STACK_EXECUTION'],
  [0x40000, 'ROOT_SAFE'], [0x80000, 'SETUID_SAFE'], [0x100000, 'NO_REEXPORTED_DYLIBS'], [0x200000, 'PIE'],
  [0x400000, 'DEAD_STRIPPABLE_DYLIB'], [0x800000, 'HAS_TLV_DESCRIPTORS'], [0x1000000, 'NO_HEAP_EXECUTION'],
  [0x2000000, 'APP_EXTENSION_SAFE'], [0x4000000, 'NLIST_OUTOFSYNC_WITH_DYLDINFO'], [0x8000000, 'SIM_SUPPORT'],
  [0x80000000, 'DYLIB_IN_CACHE']
]
const MH_TWOLEVEL = 0x80
const MH_ALLOW_STACK_EXECUTION = 0x20000
const MH_PIE = 0x200000
const MH_NO_HEAP_EXECUTION = 0x1000000

const LC = {
  SEGMENT: 0x1, SYMTAB: 0x2, THREAD: 0x4, UNIXTHREAD: 0x5, DYSYMTAB: 0xb, LOAD_DYLIB: 0xc, ID_DYLIB: 0xd,
  LOAD_DYLINKER: 0xe, ID_DYLINKER: 0xf, SEGMENT_64: 0x19, UUID: 0x1b, CODE_SIGNATURE: 0x1d, SEGMENT_SPLIT_INFO: 0x1e,
  LAZY_LOAD_DYLIB: 0x20, ENCRYPTION_INFO: 0x21, DYLD_INFO: 0x22, VERSION_MIN_MACOSX: 0x24, VERSION_MIN_IPHONEOS: 0x25,
  FUNCTION_STARTS: 0x26, DYLD_ENVIRONMENT: 0x27, DATA_IN_CODE: 0x29, SOURCE_VERSION: 0x2a, DYLIB_CODE_SIGN_DRS: 0x2b,
  ENCRYPTION_INFO_64: 0x2c, LINKER_OPTION: 0x2d, LINKER_OPTIMIZATION_HINT: 0x2e, VERSION_MIN_TVOS: 0x2f,
  VERSION_MIN_WATCHOS: 0x30, NOTE: 0x31, BUILD_VERSION: 0x32, ATOM_INFO: 0x36,
  LOAD_WEAK_DYLIB: 0x80000018, RPATH: 0x8000001c, REEXPORT_DYLIB: 0x8000001f, DYLD_INFO_ONLY: 0x80000022,
  LOAD_UPWARD_DYLIB: 0x80000023, MAIN: 0x80000028, DYLD_EXPORTS_TRIE: 0x80000033, DYLD_CHAINED_FIXUPS: 0x80000034,
  FILESET_ENTRY: 0x80000035
}
const LC_NAMES = Object.fromEntries(Object.entries(LC).map(([name, cmd]) => [cmd, `LC_${name}`]))
const LC_DESCRIPTIONS = {
  [LC.SEGMENT]: 'A segment: a range of the file mapped into memory, with its sections',
  [LC.SEGMENT_64]: 'A segment: a range of the file mapped into memory, with its sections',
  [LC.SYMTAB]: 'Location of the symbol and string tables',
  [LC.DYSYMTAB]: 'How the symbol table splits into local, exported and undefined symbols',
  [LC.LOAD_DYLIB]: 'A dynamic library this file links against',
  [LC.LOAD_WEAK_DYLIB]: 'A library that may be missing at run time',
  [LC.REEXPORT_DYLIB]: 'A library whose symbols this one re-exports',
  [LC.LAZY_LOAD_DYLIB]: 'A library loaded on first use',
  [LC.LOAD_UPWARD_DYLIB]: 'A library in an upward (circular) dependency',
  [LC.ID_DYLIB]: 'This library\'s own install name and versions',
  [LC.LOAD_DYLINKER]: 'The dynamic linker that loads this file',
  [LC.UUID]: 'Unique build identifier, used to match debug symbols',
  [LC.CODE_SIGNATURE]: 'Location of the code signature',
  [LC.MAIN]: 'Entry point of the program',
  [LC.UNIXTHREAD]: 'Initial thread state; holds the entry point of older executables',
  [LC.ENCRYPTION_INFO]: 'Range encrypted by the App Store (FairPlay)',
  [LC.ENCRYPTION_INFO_64]: 'Range encrypted by the App Store (FairPlay)',
  [LC.RPATH]: 'A run-path search directory for @rpath library names',
  [LC.BUILD_VERSION]: 'Target platform, minimum OS version and SDK',
  [LC.VERSION_MIN_MACOSX]: 'Minimum macOS version and SDK',
  [LC.VERSION_MIN_IPHONEOS]: 'Minimum iOS version and SDK',
  [LC.VERSION_MIN_TVOS]: 'Minimum tvOS version and SDK',
  [LC.VERSION_MIN_WATCHOS]: 'Minimum watchOS version and SDK',
  [LC.SOURCE_VERSION]: 'Version of the sources the binary was built from',
  [LC.DYLD_INFO]: 'Compressed rebase, bind and export information',
  [LC.DYLD_INFO_ONLY]: 'Compressed rebase, bind and export information',
  [LC.FUNCTION_STARTS]: 'Compressed table of function start addresses',
  [LC.DATA_IN_CODE]: 'Data embedded in code sections (jump tables)',
  [LC.DYLD_EXPORTS_TRIE]: 'Trie of exported symbols',
  [LC.DYLD_CHAINED_FIXUPS]: 'Chained fixups: pointers the loader rebases and binds',
  [LC.LINKER_OPTION]: 'Linker options embedded by the compiler',
  [LC.NOTE]: 'Arbitrary data owned by a tool'
}

const DYLIB_KINDS = {
  [LC.LOAD_DYLIB]: 'Linked',
  [LC.LOAD_WEAK_DYLIB]: 'Weak',
  [LC.REEXPORT_DYLIB]: 'Re-exported',
  [LC.LAZY_LOAD_DYLIB]: 'Lazy',
  [LC.LOAD_UPWARD_DYLIB]: 'Upward'
}
const LINKEDIT_COMMANDS = new Set([
  LC.CODE_SIGNATURE, LC.SEGMENT_SPLIT_INFO, LC.FUNCTION_STARTS, LC.DATA_IN_CODE, LC.DYLIB_CODE_SIGN_DRS,
  LC.LINKER_OPTIMIZATION_HINT, LC.DYLD_EXPORTS_TRIE, LC.DYLD_CHAINED_FIXUPS, LC.ATOM_INFO
])
const PLATFORMS = {
  1: 'macOS', 2: 'iOS', 3: 'tvOS', 4: 'watchOS', 5: 'bridgeOS', 6: 'Mac Catalyst', 7: 'iOS Simulator',
  8: 'tvOS Simulator', 9: 'watchOS Simulator', 10: 'DriverKit', 11: 'visionOS', 12: 'visionOS Simulator'
}
const VERSION_MIN_PLATFORMS = {
  [LC.VERSION_MIN_MACOSX]: 'macOS', [LC.VERSION_MIN_IPHONEOS]: 'iOS', [LC.VERSION_MIN_TVOS]: 'tvOS', [LC.VERSION_MIN_WATCHOS]: 'watchOS'
}
const TOOLS = { 1: 'clang', 2: 'swift', 3: 'ld', 4: 'lld', 1024: 'Metal' }
const VM_PROT = v => `${v & 1 ? 'r' : '-'}${v & 2 ? 'w' : '-'}${v & 4 ? 'x' : '-'}`

const CS_FLAGS = [
  [0x2, 'ad-hoc'], [0x100, 'hard'], [0x200, 'kill'], [0x800, 'restrict'], [0x1000, 'enforcement'],
  [0x2000, 'library validation'], [0x10000, 'hardened runtime'], [0x20000, 'linker-signed']
]

const versionText = v => `${v >>> 16}.${(v >> 8) & 0xff}.${v & 0xff}`.replace(/\.0$/, '')
const dylibVersion = v => `${v >>> 16}.${(v >> 8) & 0xff}.${v & 0xff}`

function sourceVersion(value) {
  const v = BigInt(value)
  return [v >> 40n, (v >> 30n) & 0x3ffn, (v >> 20n) & 0x3ffn, (v >> 10n) & 0x3ffn, v & 0x3ffn].join('.')
}

// nm letter for a section, as Apple's nm and llvm-nm assign it: only
// __TEXT,__text, __DATA,__data and __DATA,__bss have letters of their own.
function machOSectionLetter(section) {
  if (section.segname === '__TEXT' && section.sectname === '__text') return 'T'
  if (section.segname === '__DATA' && section.sectname === '__data') return 'D'
  if (section.segname === '__DATA' && section.sectname === '__bss') return 'B'
  return 'S'
}

const isCodeSection = section => (section.flags & 0x80000400) !== 0

const isZerofill = section => [0x1, 0xc, 0x12].includes(section.flags & 0xff)

function sectionKind(section) {
  if (isCodeSection(section)) return 'code'
  if (section.segname === '__DWARF') return 'metadata'
  return 'data'
}

// Parses one thin Mach-O image starting at `base`. Offsets inside the image
// (symoff, stroff, section offsets) are relative to `base`, which matters for fat slices.
function parseMachOImage(view, base, end, budget) {
  const magic = view.getUint32(base, false)
  const le = magic === MH_CIGAM || magic === MH_CIGAM_64
  const is64Bit = magic === MH_MAGIC_64 || magic === MH_CIGAM_64
  const headerSize = is64Bit ? 32 : 28
  if (base + headerSize > end) throw new Error('Mach-O header is truncated')
  const u32 = at => view.getUint32(at, le)

  const cputype = view.getInt32(base + 4, le)
  const cpusubtype = view.getInt32(base + 8, le)
  const filetype = u32(base + 12)
  const ncmds = u32(base + 16)
  const sizeofcmds = u32(base + 20)
  const flags = u32(base + 24)
  const arch = cpuName(cputype, cpusubtype)

  const header = readStruct(view, base, [
    ['magic', 4, 'magic', 'Mach-O magic; byte order and 32/64-bit', v => hex(v >>> 0)],
    ['cputype', 4, 'header', 'CPU type', () => arch],
    ['cpusubtype', 4, 'header', 'CPU subtype (low byte) and capability bits', v => hex(v >>> 0)],
    ['filetype', 4, 'header', 'Kind of file', v => MACHO_FILE_TYPES[v] || String(v)],
    ['ncmds', 4, 'count', 'Number of load commands'],
    ['sizeofcmds', 4, 'size', 'Total size of the load commands', v => hex(v)],
    ['flags', 4, 'flags', 'Header flags', v => `${hex(v >>> 0)} (${decodeFlags(v, MH_FLAGS).join(' ') || 'none'})`],
    ['reserved', is64Bit ? 4 : 0, 'padding', 'Reserved']
  ], le, budget, end)

  const image = {
    arch, is64Bit, littleEndian: le, filetype,
    fileType: MACHO_FILE_TYPES[filetype] || `Unknown (${filetype})`,
    flags,
    headerFields: header.children,
    commandNodes: [],
    regions: [{ name: 'Mach header', offset: base, length: headerSize, kind: 'header' }],
    extraFields: [],
    sections: [null], // n_sect is 1-based
    segments: [],
    dylibs: [], // ordinal order, for two-level namespace imports
    linked: [], // { kind, path, current, compat }
    rpaths: [],
    symtabs: [],
    uuid: '', platform: '', minos: '', sdk: '', tools: [], installName: '', dylinker: '',
    entry: null, codeSignature: null, encryption: null, sourceVersion: '',
    hasSymtab: false, symbols: [], headerEnd: base + headerSize
  }

  const textSegment = () => image.segments.find(s => s.segname === '__TEXT')
  let cmdOffset = base + headerSize
  const cmdLimit = Math.min(end, base + headerSize + sizeofcmds)
  let commandsRead = 0
  for (let i = 0; i < Math.min(ncmds, MAX_LOAD_COMMANDS); i++) {
    if (cmdOffset + 8 > end) break
    const cmd = u32(cmdOffset)
    const cmdsize = u32(cmdOffset + 4)
    if (cmdsize < 8 || cmdOffset + cmdsize > end) break
    const at = cmdOffset
    const cmdEnd = at + cmdsize
    const name = LC_NAMES[cmd] || `LC ${hex(cmd >>> 0)}`
    const wantNode = image.commandNodes.length < MAX_TABLE_ENTRIES && budget.left > 0
    const nodeBudget = wantNode ? budget : null
    const children = [
      field('cmd', at, 4, name, 'header', 'Load command type'),
      field('cmdsize', at + 4, 4, String(cmdsize), 'size', 'Size of this command, including what follows it')
    ]
    let value = ''
    const struct = (spec) => {
      const r = readStruct(view, at + 8, spec, le, nodeBudget, cmdEnd)
      children.push(...r.children)
      return r
    }
    const cmdString = (offsetField, label, description) => {
      const offset = u32(at + 8 + offsetField)
      if (offset < 8 || offset >= cmdsize) return ''
      const text = readCString(view, at + offset, cmdEnd)
      if (nodeBudget) children.push(field(label, at + offset, cmdEnd - at - offset, text, 'string', description))
      return text
    }

    if ((cmd === LC.SEGMENT || cmd === LC.SEGMENT_64) && cmdsize >= (is64Bit ? 72 : 56)) {
      const seg64 = cmd === LC.SEGMENT_64
      const A = seg64 ? 8 : 4
      const r = struct([
        ['segname', 16, 'string', 'Segment name', o => readFixedString(view, o, 16)],
        ['vmaddr', A, 'offset', 'Address in memory', v => hexBig(v)],
        ['vmsize', A, 'size', 'Size in memory', v => hexBig(v)],
        ['fileoff', A, 'offset', 'Offset in the file (from the start of this image)', v => hexBig(v)],
        ['filesize', A, 'size', 'Bytes taken in the file', v => hexBig(v)],
        ['maxprot', 4, 'flags', 'Maximum protection', v => VM_PROT(v)],
        ['initprot', 4, 'flags', 'Initial protection', v => VM_PROT(v)],
        ['nsects', 4, 'count', 'Number of sections that follow'],
        ['flags', 4, 'flags', 'Segment flags', v => hex(v)]
      ])
      const segname = readFixedString(view, at + 8, 16)
      const segment = {
        segname,
        vmaddr: toNumber(r.values.vmaddr ?? 0),
        vmsize: toNumber(r.values.vmsize ?? 0),
        fileoff: toNumber(r.values.fileoff ?? 0),
        filesize: toNumber(r.values.filesize ?? 0),
        initprot: r.values.initprot ?? 0
      }
      image.segments.push(segment)
      value = `${segname || '(unnamed)'} ${VM_PROT(segment.initprot)}`
      const headerLength = seg64 ? 72 : 56
      const sectionLength = seg64 ? 80 : 68
      const nsects = r.values.nsects ?? 0
      const fits = Math.floor((cmdsize - headerLength) / sectionLength)
      for (let s = 0; s < Math.min(nsects, fits) && image.sections.length <= MAX_SECTIONS; s++) {
        const sectAt = at + headerLength + s * sectionLength
        const sr = readStruct(view, sectAt, [
          ['sectname', 16, 'string', 'Section name', o => readFixedString(view, o, 16)],
          ['segname', 16, 'string', 'Segment the section belongs to', o => readFixedString(view, o, 16)],
          ['addr', A, 'offset', 'Address in memory', v => hexBig(v)],
          ['size', A, 'size', 'Size in bytes', v => hexBig(v)],
          ['offset', 4, 'offset', 'Offset in the file (from the start of this image)', v => hex(v)],
          ['align', 4, 'size', 'Alignment as a power of two', v => `2^${v}`],
          ['reloff', 4, 'offset', 'Offset of relocation entries', v => hex(v)],
          ['nreloc', 4, 'count', 'Number of relocation entries'],
          ['flags', 4, 'flags', 'Section type (low byte) and attributes', v => hex(v >>> 0)],
          ['reserved1', 4, 'data', 'Index into the indirect symbol table, for stubs and pointers'],
          ['reserved2', 4, 'data', 'Size of a stub, for stub sections'],
          ['reserved3', seg64 ? 4 : 0, 'padding', 'Reserved']
        ], le, nodeBudget && budget.left > 13 ? budget : null, cmdEnd)
        const section = {
          sectname: readFixedString(view, sectAt, 16),
          segname: readFixedString(view, sectAt + 16, 16),
          addr: toNumber(sr.values.addr ?? 0),
          size: toNumber(sr.values.size ?? 0),
          offset: sr.values.offset ?? 0,
          flags: sr.values.flags ?? 0
        }
        image.sections.push(section)
        if (sr.children.length) {
          children.push(field(`${section.segname},${section.sectname}`, sectAt, sectionLength, `${hex(section.size)} bytes`, 'header', 'Section header', sr.children))
        }
        if (section.offset && section.size && !isZerofill(section)) {
          image.regions.push({ name: `${section.segname},${section.sectname}`, offset: base + section.offset, length: section.size, kind: sectionKind(section) })
        }
      }
    } else if (cmd === LC.SYMTAB && cmdsize >= 24) {
      const r = struct([
        ['symoff', 4, 'offset', 'Offset of the symbol table', v => hex(v)],
        ['nsyms', 4, 'count', 'Number of symbols'],
        ['stroff', 4, 'offset', 'Offset of the string table', v => hex(v)],
        ['strsize', 4, 'size', 'Size of the string table', v => hex(v)]
      ])
      image.symtabs.push(r.values)
      value = `${r.values.nsyms} symbols`
    } else if (cmd === LC.DYSYMTAB && cmdsize >= 80) {
      const names = ['ilocalsym', 'nlocalsym', 'iextdefsym', 'nextdefsym', 'iundefsym', 'nundefsym', 'tocoff', 'ntoc',
        'modtaboff', 'nmodtab', 'extrefsymoff', 'nextrefsyms', 'indirectsymoff', 'nindirectsyms', 'extreloff', 'nextrel', 'locreloff', 'nlocrel']
      const r = struct(names.map(n => [n, 4, n.includes('off') ? 'offset' : 'count', '', n.includes('off') ? v => hex(v) : undefined]))
      value = `${r.values.nlocalsym ?? 0} local, ${r.values.nextdefsym ?? 0} exported, ${r.values.nundefsym ?? 0} undefined`
      if (r.values.nindirectsyms && r.values.indirectsymoff) {
        image.regions.push({ name: 'Indirect symbol table', offset: base + r.values.indirectsymoff, length: r.values.nindirectsyms * 4, kind: 'table' })
      }
    } else if (DYLIB_KINDS[cmd] || cmd === LC.ID_DYLIB) {
      const r = struct([
        ['name.offset', 4, 'offset', 'Offset of the path within this command', v => hex(v)],
        ['timestamp', 4, 'data', 'Build time of the library (usually unused)', v => hex(v)],
        ['current_version', 4, 'data', 'Current version', v => dylibVersion(v)],
        ['compatibility_version', 4, 'data', 'Oldest compatible version', v => dylibVersion(v)]
      ])
      const path = cmdString(0, 'name', 'Install name of the library')
      value = path
      if (cmd === LC.ID_DYLIB) {
        image.installName = path
      } else {
        image.dylibs.push(path)
        image.linked.push({ kind: DYLIB_KINDS[cmd], path, current: r.values.current_version, compat: r.values.compatibility_version })
      }
    } else if (cmd === LC.LOAD_DYLINKER || cmd === LC.ID_DYLINKER || cmd === LC.DYLD_ENVIRONMENT) {
      struct([['name.offset', 4, 'offset', 'Offset of the string within this command', v => hex(v)]])
      value = cmdString(0, 'name', cmd === LC.DYLD_ENVIRONMENT ? 'Environment variable for the dynamic linker' : 'Path of the dynamic linker')
      if (cmd === LC.LOAD_DYLINKER) image.dylinker = value
    } else if (cmd === LC.RPATH) {
      struct([['path.offset', 4, 'offset', 'Offset of the path within this command', v => hex(v)]])
      value = cmdString(0, 'path', 'Run-path search directory')
      image.rpaths.push(value)
    } else if (cmd === LC.UUID && cmdsize >= 24) {
      const uuid = formatUuid(hexString(view, at + 8, 16))
      if (nodeBudget) children.push(field('uuid', at + 8, 16, uuid, 'data', '128-bit unique identifier'))
      image.uuid = uuid
      value = uuid
    } else if (VERSION_MIN_PLATFORMS[cmd] && cmdsize >= 16) {
      const r = struct([
        ['version', 4, 'data', 'Minimum OS version', v => versionText(v)],
        ['sdk', 4, 'data', 'SDK version', v => versionText(v)]
      ])
      image.platform = VERSION_MIN_PLATFORMS[cmd]
      image.minos = versionText(r.values.version)
      image.sdk = versionText(r.values.sdk)
      value = `${image.platform} ${image.minos}`
    } else if (cmd === LC.BUILD_VERSION && cmdsize >= 24) {
      const r = struct([
        ['platform', 4, 'header', 'Target platform', v => PLATFORMS[v] || String(v)],
        ['minos', 4, 'data', 'Minimum OS version', v => versionText(v)],
        ['sdk', 4, 'data', 'SDK version', v => versionText(v)],
        ['ntools', 4, 'count', 'Number of tool entries that follow']
      ])
      image.platform = PLATFORMS[r.values.platform] || `platform ${r.values.platform}`
      image.minos = versionText(r.values.minos)
      image.sdk = versionText(r.values.sdk)
      for (let t = 0; t < Math.min(r.values.ntools, 16); t++) {
        const toolAt = at + 24 + t * 8
        if (toolAt + 8 > cmdEnd) break
        const tool = u32(toolAt)
        const version = versionText(u32(toolAt + 4))
        image.tools.push(`${TOOLS[tool] || `tool ${tool}`} ${version}`)
        if (nodeBudget) children.push(field('tool', toolAt, 8, `${TOOLS[tool] || tool} ${version}`, 'data', 'Tool that built the file, and its version'))
      }
      value = `${image.platform} ${image.minos}`
    } else if (cmd === LC.MAIN && cmdsize >= 24) {
      const r = struct([
        ['entryoff', 8, 'offset', 'File offset of main() (from the start of this image)', v => hexBig(v)],
        ['stacksize', 8, 'size', 'Initial stack size, or 0 for the default', v => hexBig(v)]
      ])
      const entryoff = toNumber(r.values.entryoff)
      const text = textSegment()
      image.entry = { fileOffset: entryoff, address: text ? text.vmaddr - text.fileoff + entryoff : null }
      value = `offset ${hex(entryoff)}`
    } else if ((cmd === LC.UNIXTHREAD || cmd === LC.THREAD) && cmdsize >= 16) {
      const r = struct([
        ['flavor', 4, 'data', 'Thread state flavor'],
        ['count', 4, 'count', 'Size of the thread state in 32-bit words']
      ])
      const pc = threadEntry(view, at + 16, cmdEnd, cputype, r.values.flavor, le)
      if (pc !== null && cmd === LC.UNIXTHREAD) {
        image.entry = { address: pc, fileOffset: null }
        value = `pc ${hexBig(pc)}`
      }
    } else if (LINKEDIT_COMMANDS.has(cmd) && cmdsize >= 16) {
      const r = struct([
        ['dataoff', 4, 'offset', 'Offset of the data in __LINKEDIT', v => hex(v)],
        ['datasize', 4, 'size', 'Size of the data', v => hex(v)]
      ])
      const { dataoff, datasize } = r.values
      value = `${hex(datasize ?? 0)} bytes at ${hex(dataoff ?? 0)}`
      if (dataoff && datasize) {
        const label = name.replace(/^LC_/, '').toLowerCase().replace(/_/g, ' ')
        image.regions.push({ name: label[0].toUpperCase() + label.slice(1), offset: base + dataoff, length: datasize, kind: cmd === LC.CODE_SIGNATURE ? 'metadata' : 'table' })
        if (cmd === LC.CODE_SIGNATURE) image.codeSignature = { offset: base + dataoff, size: datasize, ...readCodeSignature(view, base + dataoff, Math.min(base + dataoff + datasize, end)) }
      }
    } else if ((cmd === LC.ENCRYPTION_INFO || cmd === LC.ENCRYPTION_INFO_64) && cmdsize >= 20) {
      const r = struct([
        ['cryptoff', 4, 'offset', 'Offset of the encrypted range', v => hex(v)],
        ['cryptsize', 4, 'size', 'Size of the encrypted range', v => hex(v)],
        ['cryptid', 4, 'data', 'Encryption system; 0 means not encrypted']
      ])
      image.encryption = r.values
      value = r.values.cryptid ? 'encrypted' : 'not encrypted'
    } else if ((cmd === LC.DYLD_INFO || cmd === LC.DYLD_INFO_ONLY) && cmdsize >= 48) {
      const parts = ['rebase', 'bind', 'weak_bind', 'lazy_bind', 'export']
      const r = struct(parts.flatMap(p => [
        [`${p}_off`, 4, 'offset', `Offset of the ${p.replace('_', ' ')} information`, v => hex(v)],
        [`${p}_size`, 4, 'size', `Size of the ${p.replace('_', ' ')} information`, v => hex(v)]
      ]))
      for (const p of parts) {
        const off = r.values[`${p}_off`]
        const size = r.values[`${p}_size`]
        if (off && size) image.regions.push({ name: `Dyld ${p.replace('_', ' ')} info`, offset: base + off, length: size, kind: 'table' })
      }
    } else if (cmd === LC.SOURCE_VERSION && cmdsize >= 16) {
      const r = struct([['version', 8, 'data', 'A.B.C.D.E source version', v => sourceVersion(v)]])
      image.sourceVersion = sourceVersion(r.values.version)
      value = image.sourceVersion
    }

    if (wantNode) {
      budget.left--
      image.commandNodes.push(field(name, at, cmdsize, value, 'header', LC_DESCRIPTIONS[cmd] || 'Load command', children))
    }
    commandsRead++
    cmdOffset += cmdsize
  }
  if (commandsRead < ncmds) {
    const rest = Math.max(0, cmdLimit - cmdOffset)
    if (rest > 0) image.commandNodes.push(field(`${ncmds - commandsRead} more load commands`, cmdOffset, rest, undefined, 'data', 'Not decoded'))
  }
  image.headerEnd = Math.min(cmdOffset, end)
  if (cmdOffset > base + headerSize) {
    image.regions.push({ name: 'Load commands', offset: base + headerSize, length: cmdOffset - base - headerSize, kind: 'header' })
  }

  readSymbols(view, base, end, image)
  return image
}

function formatUuid(raw) {
  const h = raw.toUpperCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// Entry point from an LC_UNIXTHREAD register state (older executables)
function threadEntry(view, stateAt, end, cputype, flavor, le) {
  const read64 = index => (stateAt + index * 8 + 8 <= end ? view.getBigUint64(stateAt + index * 8, le) : null)
  const read32 = index => (stateAt + index * 4 + 4 <= end ? view.getUint32(stateAt + index * 4, le) : null)
  if (cputype === (7 | CPU_ARCH_ABI64) && flavor === 4) return read64(16) // rip
  if (cputype === (12 | CPU_ARCH_ABI64) && flavor === 6) return read64(32) // pc
  if (cputype === 7 && flavor === 1) return read32(10) // eip
  if (cputype === 12 && flavor === 1) return read32(15) // pc
  return null
}

// Code signature: a big-endian SuperBlob of blobs. The CodeDirectory carries
// the signing flags; a CMS blob means the code is signed with a certificate.
function readCodeSignature(view, start, end) {
  if (!inBounds(view, start, 12) || start + 12 > end || view.getUint32(start, false) !== 0xfade0cc0) return { kind: 'unrecognised format' }
  const count = Math.min(view.getUint32(start + 8, false), 64)
  let flags = null
  let identifier = ''
  let cms = false
  let entitlements = false
  for (let i = 0; i < count; i++) {
    const indexAt = start + 12 + i * 8
    if (indexAt + 8 > end) break
    const type = view.getUint32(indexAt, false)
    const blobAt = start + view.getUint32(indexAt + 4, false)
    if (blobAt + 8 > end) continue
    const magic = view.getUint32(blobAt, false)
    if (magic === 0xfade0c02 && flags === null && blobAt + 24 <= end) {
      flags = view.getUint32(blobAt + 12, false)
      const identOffset = view.getUint32(blobAt + 20, false)
      if (identOffset) identifier = readCString(view, blobAt + identOffset, end)
    } else if (magic === 0xfade0b01 && type === 0x10000) {
      cms = view.getUint32(blobAt + 4, false) > 8
    } else if (magic === 0xfade7171 || magic === 0xfade7172) {
      entitlements = true
    }
  }
  const flagNames = flags === null ? [] : decodeFlags(flags, CS_FLAGS)
  return {
    kind: cms ? 'signed with a certificate' : flags !== null && flags & 0x2 ? 'ad-hoc' : flags !== null ? 'no certificate' : 'no code directory',
    identifier,
    flagNames,
    hardened: flags !== null && Boolean(flags & 0x10000),
    entitlements
  }
}

const N_ARM_THUMB_DEF = 0x0008

function readSymbols(view, base, end, image) {
  const { is64Bit, littleEndian } = image
  const entrySize = is64Bit ? 16 : 12
  const twoLevel = (image.flags & MH_TWOLEVEL) !== 0
  for (const { symoff, nsyms, stroff, strsize } of image.symtabs) {
    if (symoff === undefined || stroff === undefined) continue
    image.hasSymtab = true
    const symStart = base + symoff
    const strStart = base + stroff
    const strEnd = Math.min(strStart + strsize, end)
    if (nsyms) image.regions.push({ name: 'Symbol table', offset: symStart, length: nsyms * entrySize, kind: 'table' })
    if (strsize) image.regions.push({ name: 'String table', offset: strStart, length: strsize, kind: 'table' })
    if (symStart >= end || strStart >= end) continue
    const count = Math.min(nsyms, MAX_SYMBOLS, Math.floor((end - symStart) / entrySize))

    for (let j = 0; j < count; j++) {
      const entry = symStart + j * entrySize
      const strx = view.getUint32(entry, littleEndian)
      const type = view.getUint8(entry + 4)
      const sect = view.getUint8(entry + 5)
      const desc = view.getUint16(entry + 6, littleEndian)
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
          letter = image.sections[sect] ? machOSectionLetter(image.sections[sect]) : 'S'
          break
        default: continue
      }
      if (!isExternal) letter = letter.toLowerCase()

      const defined = letter !== 'U' && letter !== 'u' && letter !== 'I' && letter !== 'i'
      const symbol = { name, type: letter }
      if (letter === 'C') {
        symbol.note = `size ${value}`
        symbol.kind = 'data'
        symbol.reason = 'Common symbol: allocated by the linker, no bytes in this file'
      } else if (letter === 'U' || letter === 'u') {
        symbol.kind = 'other'
        const ordinal = (desc >> 8) & 0xff
        const library = twoLevel && ordinal > 0 && ordinal <= image.dylibs.length ? image.dylibs[ordinal - 1] : ''
        if (library) {
          symbol.library = library
          symbol.note = library
          symbol.reason = `Imported from ${library}: its code is not in this file`
        } else {
          symbol.reason = ordinal === 0xff && twoLevel ? 'Looked up dynamically in all loaded images' : 'Undefined here: resolved at link or load time'
        }
      } else if (defined) {
        symbol.address = hex(value)
        const section = (type & 0x0e) === 0xe ? image.sections[sect] : null
        symbol.kind = section ? (isCodeSection(section) ? 'function' : 'data') : 'other'
        if ((type & 0x0e) === 0x2) symbol.reason = 'Absolute value, not an address in the file'
        else if (!section) symbol.reason = 'No section header describes this symbol\'s section'
        else if (isZerofill(section)) symbol.reason = `In ${section.segname},${section.sectname}: zero-filled at run time, no bytes in the file`
        else {
          let address = Number(value)
          if (desc & N_ARM_THUMB_DEF) address -= address % 2
          const delta = address - section.addr
          if (delta >= 0 && delta < Math.max(section.size, 1) && base + section.offset + delta < end) symbol.offset = base + section.offset + delta
          else {
            // Symbols such as __mh_execute_header sit outside their section but inside a segment
            const segment = image.segments.find(g => address >= g.vmaddr && address < g.vmaddr + g.filesize)
            const offset = segment ? base + segment.fileoff + (address - segment.vmaddr) : -1
            if (segment && offset < end) symbol.offset = offset
            else symbol.reason = 'Address is not backed by bytes in this file'
          }
        }
      }
      image.symbols.push(symbol)
    }
  }
}

function imageFields(image, base) {
  const nodes = []
  if (image.headerFields.length) {
    const last = image.headerFields[image.headerFields.length - 1]
    nodes.push(field('Mach header', base, last.offset + last.length - base, `${image.arch} ${image.fileType.toLowerCase()}`, 'header',
      'CPU, file type, load command count and flags', image.headerFields))
  }
  if (image.commandNodes.length) {
    const first = image.commandNodes[0]
    const last = image.commandNodes[image.commandNodes.length - 1]
    nodes.push(field('Load commands', first.offset, last.offset + last.length - first.offset, `${image.commandNodes.length} commands`, 'header',
      'Instructions for the loader: segments, libraries, entry point, signatures', image.commandNodes))
  }
  return nodes
}

function imageSummary(image, prefix = '') {
  const summary = [
    item('Architecture', image.arch),
    item('File Type', image.fileType),
    item('Class', `Mach-O ${image.is64Bit ? '64-bit' : '32-bit'}, ${image.littleEndian ? 'little' : 'big'} endian`)
  ]
  if (!image.hasSymtab) summary.push(item('Symbol table', 'none'))
  if (prefix) return summary
  const flagNames = decodeFlags(image.flags, MH_FLAGS)
  summary.push(item('Header flags', flagNames.join(' ') || 'none', ['Flags from the Mach header']))
  if (image.uuid) summary.push(item('UUID', image.uuid))
  if (image.platform) {
    summary.push(item('Minimum OS', `${image.platform} ${image.minos}`, [
      image.sdk ? `Built with the ${image.sdk} SDK` : '',
      image.tools.length ? `Tools: ${image.tools.join(', ')}` : ''
    ]))
  }
  if (image.sdk) summary.push(item('SDK', image.sdk))
  if (image.entry) {
    summary.push(item('Entry point', image.entry.address !== null ? hexBig(image.entry.address) : `file offset ${hex(image.entry.fileOffset)}`, [
      image.entry.fileOffset !== null ? `File offset ${hex(image.entry.fileOffset)} (LC_MAIN)` : 'From the initial thread state (LC_UNIXTHREAD)'
    ]))
  }
  if (image.dylinker) summary.push(item('Dynamic linker', image.dylinker))
  if (image.sourceVersion && image.sourceVersion !== '0.0.0.0.0') summary.push(item('Source version', image.sourceVersion))

  if (image.installName) summary.push(item('Install name', image.installName, ['The name programs linking against this library record'], 'Libraries'))
  for (const lib of image.linked.slice(0, MAX_SUMMARY_LINES)) {
    summary.push(item(lib.kind, lib.path, [
      `Current version ${dylibVersion(lib.current ?? 0)}, compatible with ${dylibVersion(lib.compat ?? 0)}`
    ], 'Libraries'))
  }
  for (const rpath of image.rpaths.slice(0, MAX_SUMMARY_LINES)) summary.push(item('RPATH', rpath, ['Searched for @rpath/ library names'], 'Libraries'))

  if (image.filetype === 2) {
    summary.push(item('PIE', image.flags & MH_PIE ? 'yes' : 'no', ['MH_PIE: the executable is loaded at a random address (ASLR)'], 'Security'))
  }
  const sig = image.codeSignature
  summary.push(item('Code signature', sig ? `present, ${sig.kind}` : 'none', sig ? [
    `${sig.size} bytes at file offset ${hex(sig.offset)}`,
    sig.identifier ? `Identifier: ${sig.identifier}` : '',
    sig.flagNames && sig.flagNames.length ? `Flags: ${sig.flagNames.join(', ')}` : '',
    sig.entitlements ? 'Has entitlements' : '',
    'Presence only: the signature is not verified here'
  ] : ['No LC_CODE_SIGNATURE load command'], 'Security'))
  if (sig && sig.flagNames) summary.push(item('Hardened runtime', sig.hardened ? 'yes' : 'no', ['Restricts code injection and debugging unless entitled'], 'Security'))
  if (image.encryption) {
    summary.push(item('Encrypted', image.encryption.cryptid ? 'yes (App Store encryption)' : 'no', [
      `Range ${hex(image.encryption.cryptoff ?? 0)} + ${hex(image.encryption.cryptsize ?? 0)} bytes`
    ], 'Security'))
  }
  if (image.flags & MH_ALLOW_STACK_EXECUTION) summary.push(item('Executable stack', 'allowed (MH_ALLOW_STACK_EXECUTION)', null, 'Security'))
  if (image.flags & MH_NO_HEAP_EXECUTION) summary.push(item('Heap execution', 'disabled (MH_NO_HEAP_EXECUTION)', null, 'Security'))

  if (image.segments.length) {
    summary.push(item('Segments', String(image.segments.length), image.segments.slice(0, MAX_SUMMARY_LINES).map(s =>
      `${s.segname || '(unnamed)'}  ${VM_PROT(s.initprot)}  vm ${hex(s.vmaddr)}  file ${hex(s.fileoff)} + ${hex(s.filesize)}`
    ), 'Sections'))
  }
  if (image.sections.length > 1) {
    summary.push(item('Sections', String(image.sections.length - 1), image.sections.slice(1, MAX_SUMMARY_LINES).map(s =>
      `${s.segname},${s.sectname}  ${hex(s.size)} bytes${isZerofill(s) ? ' (zero-fill)' : ''}`
    ), 'Sections'))
  }
  return summary
}

// Tiles one image's regions inside its own byte range
function sliceRegions(image, start, end, gapName, bytes) {
  const local = image.regions.map(r => ({ ...r, offset: r.offset - start }))
  return tileRegions(local, end - start, gapName, bytes ? bytes.subarray(start, end) : null).map(r => ({ ...r, offset: r.offset + start }))
}

function parseMachO(view, bytes) {
  const magic = view.getUint32(0, false)
  const formatName = MAGIC_NAMES[magic] || 'Mach-O binary'
  const budget = createBudget()

  const fat = readFatHeader(view)
  if (!fat) {
    const fields = [field('Magic', 0, 4, hex(magic), 'magic', formatName)]
    if (!isThinMachOMagic(magic) || view.byteLength < 28) return { formatName, fields }
    const image = parseMachOImage(view, 0, view.byteLength, budget)
    const [header, ...rest] = imageFields(image, 0)
    if (header) {
      // The magic is a top-level field like every format's signature; the rest of the header follows it
      const headerChildren = header.children.slice(1)
      if (headerChildren.length) fields.push(field('Mach header', 4, header.length - 4, header.value, 'header', header.description, headerChildren))
    }
    fields.push(...rest)
    return {
      formatName: `${formatName} ${image.fileType.toLowerCase()}`,
      summary: imageSummary(image),
      fields,
      regions: sliceRegions(image, 0, view.byteLength, 'Other data', bytes),
      symbols: sortSymbols(image.symbols)
    }
  }

  const fields = [field('Magic', 0, 4, hex(magic), 'magic', formatName)]
  const archNodes = []
  const slices = []
  for (let i = 0; i < fat.nfat; i++) {
    const entry = 8 + i * 20
    const cputype = view.getInt32(entry, fat.littleEndian)
    const cpusubtype = view.getInt32(entry + 4, fat.littleEndian)
    const offset = view.getUint32(entry + 8, fat.littleEndian)
    const size = view.getUint32(entry + 12, fat.littleEndian)
    const align = view.getUint32(entry + 16, fat.littleEndian)
    const arch = cpuName(cputype, cpusubtype)
    slices.push({ arch, offset, size })
    archNodes.push(field(`[${i}] ${arch}`, entry, 20, `offset ${hex(offset)}, ${size} bytes`, 'header', 'Where one architecture\'s image lives in the file', [
      field('cputype', entry, 4, arch, 'header', 'CPU type'),
      field('cpusubtype', entry + 4, 4, hex(cpusubtype >>> 0), 'header', 'CPU subtype'),
      field('offset', entry + 8, 4, hex(offset), 'offset', 'File offset of the slice'),
      field('size', entry + 12, 4, String(size), 'size', 'Size of the slice'),
      field('align', entry + 16, 4, `2^${align}`, 'size', 'Alignment of the slice as a power of two')
    ]))
  }
  fields.push(field('Fat header', 4, 4 + fat.nfat * 20, `${fat.nfat} architectures`, 'header', 'Universal binary: one Mach-O image per architecture', [
    field('nfat_arch', 4, 4, String(fat.nfat), 'count', 'Number of architecture slices'),
    ...archNodes
  ]))
  const regions = [{ name: 'Universal header', offset: 0, length: 8 + fat.nfat * 20, kind: 'header' }]

  let shown = null
  const sliceDetails = slices.map(slice => {
    const end = Math.min(slice.offset + slice.size, view.byteLength)
    const where = `${slice.arch}: offset ${hex(slice.offset)}, ${slice.size} bytes`
    if (!inBounds(view, slice.offset, 4) || !isThinMachOMagic(view.getUint32(slice.offset, false))) {
      if (slice.offset < view.byteLength && slice.size > 0) regions.push({ name: `${slice.arch} slice`, offset: slice.offset, length: end - slice.offset, kind: 'other' })
      return `${where} (not a readable Mach-O image)`
    }
    try {
      const image = parseMachOImage(view, slice.offset, end, budget)
      if (!shown) shown = image
      const nodes = imageFields(image, slice.offset)
      if (nodes.length) fields.push(field(`${slice.arch} slice`, slice.offset, end - slice.offset, image.fileType, 'data', 'Mach-O image for one architecture', nodes))
      regions.push(...sliceRegions(image, slice.offset, end, `${slice.arch}: other data`, bytes).map(r => (
        r.name.startsWith(`${slice.arch}:`) ? r : { ...r, name: `${slice.arch}: ${r.name}` }
      )))
      return `${where}, ${image.fileType.toLowerCase()}, ${image.symbols.length} symbols`
    } catch (err) {
      return `${where} (${err.message})`
    }
  })

  const summary = [item('Universal Binary', slices.map(s => s.arch).join(', '), [
    ...sliceDetails,
    shown ? `Symbols below are from the ${shown.arch} slice` : 'No readable slices'
  ])]
  const tiled = tileRegions(regions, view.byteLength, 'Padding', bytes)
  if (!shown) return { formatName, summary, fields, regions: tiled }
  return {
    formatName,
    summary: [...summary, ...imageSummary(shown)],
    fields,
    regions: tiled,
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
      return parseMachO(dataView(bytes), bytes)
    } catch (err) {
      throw new Error('Invalid Mach-O file structure: ' + err.message)
    }
  }
}
