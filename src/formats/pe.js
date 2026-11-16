import { dataView, decodeFlags, hex, inBounds, item, MAX_SYMBOLS, readCString, readFixedString, sortSymbols } from './shared.js'
import { createBudget, field, hexBig, MAX_TABLE_ENTRIES, readStruct, tableNodes, tileRegions } from './binfields.js'

// The Windows loader rejects images with more sections; every RVA lookup
// walks the section list, so an unbounded count makes parsing quadratic
const MAX_PE_SECTIONS = 96
const MAX_IMPORT_DLLS = 4096
const MAX_IMPORTS_PER_DLL = 65536
const MAX_DEBUG_ENTRIES = 64
const MAX_SUMMARY_LIBRARIES = 500
const MAX_SUMMARY_LINES = 300

const PE_MACHINES = {
  0x14c: 'x86',
  0x8664: 'x64',
  0x1c0: 'ARM',
  0x1c4: 'ARMv7 (Thumb-2)',
  0xaa64: 'ARM64',
  0xa641: 'ARM64EC',
  0x200: 'IA-64',
  0x5064: 'RISC-V 64-bit',
  0xebc: 'EFI byte code'
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

const DLL_CHARACTERISTICS = [
  [0x0020, 'High entropy VA'],
  [0x0040, 'Dynamic base (ASLR)'],
  [0x0080, 'Force integrity'],
  [0x0100, 'NX compatible (DEP)'],
  [0x0200, 'No isolation'],
  [0x0400, 'No SEH'],
  [0x0800, 'No bind'],
  [0x1000, 'AppContainer'],
  [0x2000, 'WDM driver'],
  [0x4000, 'Control Flow Guard'],
  [0x8000, 'Terminal server aware']
]

const SUBSYSTEMS = {
  1: 'Native (driver or system process)',
  2: 'Windows GUI',
  3: 'Windows console',
  5: 'OS/2 console',
  7: 'POSIX console',
  8: 'Native Windows 9x driver',
  9: 'Windows CE GUI',
  10: 'EFI application',
  11: 'EFI boot service driver',
  12: 'EFI runtime driver',
  13: 'EFI ROM',
  14: 'Xbox',
  16: 'Windows boot application'
}

const DATA_DIRECTORIES = [
  ['Export table', 'Functions and data this image exports'],
  ['Import table', 'DLLs and functions this image imports'],
  ['Resource table', 'Icons, dialogs, version information'],
  ['Exception table', 'Unwind information for structured exception handling'],
  ['Certificate table', 'Authenticode signature; a file offset, not an RVA'],
  ['Base relocation table', 'Fix-ups applied when the image is not loaded at its preferred base'],
  ['Debug', 'Debug directory: PDB path and other debug records'],
  ['Architecture', 'Reserved, must be zero'],
  ['Global pointer', 'RVA of the global pointer register value'],
  ['TLS table', 'Thread-local storage and TLS callbacks'],
  ['Load config table', 'Security cookie, SEH and Control Flow Guard tables'],
  ['Bound import', 'Pre-bound import addresses'],
  ['IAT', 'Import address table: filled in by the loader'],
  ['Delay import descriptor', 'DLLs loaded on first use'],
  ['CLR runtime header', '.NET metadata'],
  ['Reserved', 'Must be zero']
]

const DEBUG_TYPES = {
  1: 'COFF', 2: 'CodeView', 3: 'FPO', 4: 'Misc', 5: 'Exception', 6: 'Fixup', 9: 'Borland', 11: 'CLSID',
  12: 'VC feature', 13: 'POGO', 14: 'ILTCG', 16: 'Repro', 20: 'Extended DLL characteristics'
}

const CERTIFICATE_TYPES = { 1: 'X.509', 2: 'PKCS #7 (Authenticode)', 3: 'Reserved', 4: 'PKCS #1 (TS stack signed)' }

const CLR_FLAGS = [
  [0x1, 'IL only'],
  [0x2, '32-bit required'],
  [0x8, 'Strong-name signed'],
  [0x10, 'Native entry point'],
  [0x20000, '32-bit preferred']
]

const sectionFlagsText = (value) => decodeFlags(value, PE_SECTION_FLAGS).join(', ') || 'None'
const isCodeSection = section => (section.characteristics & 0x20000020) !== 0

function peHeaderOffset(view) {
  if (view.byteLength < 0x40 || view.getUint16(0, true) !== 0x5A4D) return null
  const peOffset = view.getUint32(0x3C, true)
  if (!inBounds(view, peOffset, 24) || view.getUint32(peOffset, true) !== 0x00004550) return null
  return peOffset
}

function dosHeaderSpec() {
  const word = (name, description) => [name, 2, 'data', description, v => hex(v)]
  return [
    word('e_cblp', 'Bytes on the last 512-byte page of the DOS program'),
    word('e_cp', 'Pages in the DOS program'),
    word('e_crlc', 'DOS relocations'),
    word('e_cparhdr', 'Size of the DOS header in 16-byte paragraphs'),
    word('e_minalloc', 'Minimum extra paragraphs needed'),
    word('e_maxalloc', 'Maximum extra paragraphs needed'),
    word('e_ss', 'Initial SS value'),
    word('e_sp', 'Initial SP value'),
    word('e_csum', 'Checksum'),
    word('e_ip', 'Initial IP value'),
    word('e_cs', 'Initial CS value'),
    word('e_lfarlc', 'File offset of the DOS relocation table'),
    word('e_ovno', 'Overlay number'),
    ['e_res', 8, 'padding', 'Reserved'],
    word('e_oemid', 'OEM identifier'),
    word('e_oeminfo', 'OEM information'),
    ['e_res2', 20, 'padding', 'Reserved'],
    ['e_lfanew', 4, 'offset', 'File offset of the PE header', v => hex(v)]
  ]
}

function coffHeaderSpec() {
  return [
    ['Machine', 2, 'header', 'Target CPU', v => PE_MACHINES[v] || hex(v)],
    ['NumberOfSections', 2, 'count', 'Entries in the section table'],
    ['TimeDateStamp', 4, 'data', 'Link time (seconds since 1970); a hash in reproducible builds', v => `${hex(v)} (${new Date(v * 1000).toISOString()})`],
    ['PointerToSymbolTable', 4, 'offset', 'File offset of the COFF symbol table (0 for most images)', v => hex(v)],
    ['NumberOfSymbols', 4, 'count', 'Entries in the COFF symbol table'],
    ['SizeOfOptionalHeader', 2, 'size', 'Size of the optional header that follows'],
    ['Characteristics', 2, 'flags', 'Image flags', v => `${hex(v)} (${decodeFlags(v, PE_FILE_FLAGS).join(', ') || 'none'})`]
  ]
}

function optionalHeaderSpecs(isPE32Plus) {
  const P = isPE32Plus ? 8 : 4
  const standard = [
    ['Magic', 2, 'magic', '0x10B for PE32, 0x20B for PE32+ (64-bit)', v => `${hex(v)} (${v === 0x20B ? 'PE32+' : v === 0x10B ? 'PE32' : v === 0x107 ? 'ROM' : 'unknown'})`],
    ['MajorLinkerVersion', 1, 'data', 'Linker major version', v => String(v)],
    ['MinorLinkerVersion', 1, 'data', 'Linker minor version', v => String(v)],
    ['SizeOfCode', 4, 'size', 'Total size of code sections', v => hex(v)],
    ['SizeOfInitializedData', 4, 'size', 'Total size of initialised data sections', v => hex(v)],
    ['SizeOfUninitializedData', 4, 'size', 'Total size of uninitialised data (.bss)', v => hex(v)],
    ['AddressOfEntryPoint', 4, 'offset', 'RVA where execution starts (0 for many DLLs)', v => hex(v)],
    ['BaseOfCode', 4, 'offset', 'RVA of the start of the code section', v => hex(v)]
  ]
  if (!isPE32Plus) standard.push(['BaseOfData', 4, 'offset', 'RVA of the start of the data section', v => hex(v)])
  const windows = [
    ['ImageBase', P, 'offset', 'Preferred load address', v => hexBig(v)],
    ['SectionAlignment', 4, 'size', 'Alignment of sections in memory', v => hex(v)],
    ['FileAlignment', 4, 'size', 'Alignment of section data in the file', v => hex(v)],
    ['MajorOperatingSystemVersion', 2, 'data', 'Required OS major version', v => String(v)],
    ['MinorOperatingSystemVersion', 2, 'data', 'Required OS minor version', v => String(v)],
    ['MajorImageVersion', 2, 'data', 'Image major version', v => String(v)],
    ['MinorImageVersion', 2, 'data', 'Image minor version', v => String(v)],
    ['MajorSubsystemVersion', 2, 'data', 'Subsystem major version', v => String(v)],
    ['MinorSubsystemVersion', 2, 'data', 'Subsystem minor version', v => String(v)],
    ['Win32VersionValue', 4, 'data', 'Reserved, must be zero', v => hex(v)],
    ['SizeOfImage', 4, 'size', 'Size of the image in memory', v => hex(v)],
    ['SizeOfHeaders', 4, 'size', 'Size of all headers, rounded up to FileAlignment', v => hex(v)],
    ['CheckSum', 4, 'checksum', 'Image checksum (checked only for drivers and boot DLLs)', v => hex(v)],
    ['Subsystem', 2, 'header', 'Environment the image runs in', v => SUBSYSTEMS[v] || String(v)],
    ['DllCharacteristics', 2, 'flags', 'Security and loader flags', v => `${hex(v)} (${decodeFlags(v, DLL_CHARACTERISTICS).join(', ') || 'none'})`],
    ['SizeOfStackReserve', P, 'size', 'Stack reserved for the main thread', v => hexBig(v)],
    ['SizeOfStackCommit', P, 'size', 'Stack committed at start', v => hexBig(v)],
    ['SizeOfHeapReserve', P, 'size', 'Heap reserved for the process heap', v => hexBig(v)],
    ['SizeOfHeapCommit', P, 'size', 'Heap committed at start', v => hexBig(v)],
    ['LoaderFlags', 4, 'flags', 'Reserved, must be zero', v => hex(v)],
    ['NumberOfRvaAndSizes', 4, 'count', 'Number of data directory entries that follow']
  ]
  return { standard, windows }
}

const SECTION_HEADER_SPEC = [
  ['VirtualSize', 4, 'size', 'Size in memory', v => hex(v)],
  ['VirtualAddress', 4, 'offset', 'RVA of the section in memory', v => hex(v)],
  ['SizeOfRawData', 4, 'size', 'Size of the data in the file', v => hex(v)],
  ['PointerToRawData', 4, 'offset', 'File offset of the data', v => hex(v)],
  ['PointerToRelocations', 4, 'offset', 'File offset of COFF relocations (0 for images)', v => hex(v)],
  ['PointerToLinenumbers', 4, 'offset', 'File offset of COFF line numbers (deprecated)', v => hex(v)],
  ['NumberOfRelocations', 2, 'count', 'COFF relocation count'],
  ['NumberOfLinenumbers', 2, 'count', 'COFF line-number count'],
  ['Characteristics', 4, 'flags', 'Section flags', v => `${hex(v)} (${sectionFlagsText(v)})`]
]

const IMPORT_DESCRIPTOR_SPEC = [
  ['OriginalFirstThunk', 4, 'offset', 'RVA of the import lookup table (names or ordinals)', v => hex(v)],
  ['TimeDateStamp', 4, 'data', '0, or -1 when bound', v => hex(v)],
  ['ForwarderChain', 4, 'data', 'Index of the first forwarder, or -1', v => hex(v)],
  ['Name', 4, 'offset', 'RVA of the DLL name', v => hex(v)],
  ['FirstThunk', 4, 'offset', 'RVA of the import address table, overwritten by the loader', v => hex(v)]
]

const DELAY_DESCRIPTOR_SPEC = [
  ['Attributes', 4, 'flags', '1: the fields below are RVAs (older files store virtual addresses)', v => hex(v)],
  ['DllNameRVA', 4, 'offset', 'DLL name', v => hex(v)],
  ['ModuleHandleRVA', 4, 'offset', 'Where the loaded module handle is stored', v => hex(v)],
  ['ImportAddressTableRVA', 4, 'offset', 'Delay-load import address table', v => hex(v)],
  ['ImportNameTableRVA', 4, 'offset', 'Delay-load name table', v => hex(v)],
  ['BoundImportAddressTableRVA', 4, 'offset', 'Optional bound table', v => hex(v)],
  ['UnloadInformationTableRVA', 4, 'offset', 'Optional copy of the IAT for unloading', v => hex(v)],
  ['TimeDateStamp', 4, 'data', 'Timestamp of the bound DLL, or 0', v => hex(v)]
]

const DEBUG_ENTRY_SPEC = [
  ['Characteristics', 4, 'flags', 'Reserved', v => hex(v)],
  ['TimeDateStamp', 4, 'data', 'Time the debug data was created', v => hex(v)],
  ['MajorVersion', 2, 'data', 'Major version', v => String(v)],
  ['MinorVersion', 2, 'data', 'Minor version', v => String(v)],
  ['Type', 4, 'header', 'Kind of debug information', v => DEBUG_TYPES[v] || String(v)],
  ['SizeOfData', 4, 'size', 'Size of the debug data', v => hex(v)],
  ['AddressOfRawData', 4, 'offset', 'RVA of the debug data', v => hex(v)],
  ['PointerToRawData', 4, 'offset', 'File offset of the debug data', v => hex(v)]
]

// Rich header: undocumented linker metadata between the DOS stub and the PE
// header, XOR-masked with a key that follows the "Rich" marker.
function findRichHeader(view, peOffset) {
  const end = Math.min(peOffset, view.byteLength) - 8
  for (let at = 0x80; at <= end; at += 4) {
    if (view.getUint32(at, true) !== 0x68636952) continue // "Rich"
    const key = view.getUint32(at + 4, true)
    for (let start = at - 16; start >= 0x40; start -= 4) {
      if ((view.getUint32(start, true) ^ key) === 0x536E6144) { // "DanS"
        const entries = []
        for (let e = start + 16; e + 8 <= at && entries.length < 512; e += 8) {
          const compid = (view.getUint32(e, true) ^ key) >>> 0
          entries.push({ offset: e, product: compid >>> 16, build: compid & 0xffff, count: (view.getUint32(e + 4, true) ^ key) >>> 0 })
        }
        return { start, end: at + 8, key, entries }
      }
    }
    return null
  }
  return null
}

function parsePE(view, bytes) {
  const budget = createBudget()
  const warnings = []
  const fileSize = view.byteLength
  const peOffset = view.getUint32(0x3C, true)
  const fileHeader = peOffset + 4
  const coff = readStruct(view, fileHeader, coffHeaderSpec(), true, budget)
  const {
    Machine: machine, NumberOfSections: declaredSections, TimeDateStamp: timeDateStamp,
    PointerToSymbolTable: symbolTableOffset, NumberOfSymbols: numberOfSymbols,
    SizeOfOptionalHeader: optionalHeaderSize, Characteristics: characteristics
  } = coff.values

  const summary = [
    item('Architecture', PE_MACHINES[machine] || `Unknown (${hex(machine)})`),
    item('Timestamp', new Date(timeDateStamp * 1000).toISOString()),
    item('Characteristics', hex(characteristics), decodeFlags(characteristics, PE_FILE_FLAGS))
  ]
  const dos = readStruct(view, 2, dosHeaderSpec(), true, budget)
  const fields = [
    field('DOS signature', 0, 2, 'MZ', 'magic', 'MS-DOS executable header magic (e_magic)'),
    field('DOS header', 2, 0x3E, `PE header at ${hex(peOffset)}`, 'header', 'Legacy MS-DOS header; only e_lfanew matters today', dos.children),
    field('PE signature', peOffset, 4, 'PE\\0\\0', 'magic', 'Start of the PE header'),
    field('COFF file header', fileHeader, 20, PE_MACHINES[machine] || hex(machine), 'header', 'Machine, section count, timestamp and image flags', coff.children)
  ]
  const regions = [{ name: 'DOS header', offset: 0, length: 0x40, kind: 'header' }]
  const symbols = []
  const contentFields = []

  // ---------------------------------------------------------------- DOS stub and Rich header
  const rich = peOffset > 0x40 ? findRichHeader(view, peOffset) : null
  if (peOffset > 0x40) {
    const stubChildren = []
    if (rich) {
      const entries = rich.entries.slice(0, MAX_TABLE_ENTRIES).map(e =>
        field(`Product ${e.product}, build ${e.build}`, e.offset, 8, `${e.count} object${e.count === 1 ? '' : 's'}`, 'data',
          'A tool (compiler, linker, assembler) that produced some of the linked objects'))
      budget.left -= entries.length + 1
      stubChildren.push(field('Rich header', rich.start, rich.end - rich.start, `${rich.entries.length} entries, key ${hex(rich.key >>> 0)}`, 'metadata',
        'Undocumented Microsoft linker record of the build tools, XOR-masked', entries))
      regions.push({ name: 'DOS stub', offset: 0x40, length: rich.start - 0x40, kind: 'code' })
      regions.push({ name: 'Rich header', offset: rich.start, length: rich.end - rich.start, kind: 'metadata' })
    } else {
      regions.push({ name: 'DOS stub', offset: 0x40, length: peOffset - 0x40, kind: 'code' })
    }
    fields.push(field('DOS stub', 0x40, peOffset - 0x40, rich ? 'with Rich header' : undefined, 'data',
      'Small DOS program that prints "This program cannot be run in DOS mode"', stubChildren))
  }

  // ---------------------------------------------------------------- optional header
  const optionalHeaderOffset = fileHeader + 20
  const sectionHeadersOffset = optionalHeaderOffset + optionalHeaderSize
  const optEnd = Math.min(sectionHeadersOffset, fileSize)
  const magic = optionalHeaderSize >= 2 && inBounds(view, optionalHeaderOffset, 2) ? view.getUint16(optionalHeaderOffset, true) : 0
  const isPE32Plus = magic === 0x20B
  const specs = optionalHeaderSpecs(isPE32Plus)
  const std = readStruct(view, optionalHeaderOffset, specs.standard, true, budget, optEnd)
  const win = readStruct(view, std.end, specs.windows, true, budget, optEnd)
  const opt = { ...std.values, ...win.values }
  const directories = []
  const dirCount = Math.min(opt.NumberOfRvaAndSizes ?? 0, 16)
  const dirChildren = []
  for (let i = 0; i < dirCount; i++) {
    const at = win.end + i * 8
    if (at + 8 > optEnd) break
    const rva = view.getUint32(at, true)
    const size = view.getUint32(at + 4, true)
    directories.push({ rva, size })
    if (budget.left > 2) {
      budget.left -= 3
      const [name, description] = DATA_DIRECTORIES[i]
      dirChildren.push(field(`[${i}] ${name}`, at, 8, rva || size ? `${i === 4 ? 'offset' : 'RVA'} ${hex(rva)}, ${hex(size)} bytes` : 'empty', 'header', description, [
        field(i === 4 ? 'FileOffset' : 'VirtualAddress', at, 4, hex(rva), 'offset', i === 4 ? 'File offset of the certificate table' : 'RVA of the table'),
        field('Size', at + 4, 4, hex(size), 'size', 'Size of the table in bytes')
      ]))
    }
  }
  const optChildren = []
  if (std.children.length) optChildren.push(field('Standard fields', optionalHeaderOffset, std.end - optionalHeaderOffset, undefined, 'header', 'Fields common to all COFF images', std.children))
  if (win.children.length) optChildren.push(field('Windows-specific fields', std.end, win.end - std.end, undefined, 'header', 'Load address, alignment, versions, subsystem and security flags', win.children))
  if (dirChildren.length) optChildren.push(field('Data directories', win.end, dirChildren.length * 8, `${dirChildren.length} entries`, 'table', 'Location and size of the tables the loader uses', dirChildren))
  if (optionalHeaderSize && optEnd > optionalHeaderOffset) {
    fields.push(field('Optional header', optionalHeaderOffset, optEnd - optionalHeaderOffset, isPE32Plus ? 'PE32+' : magic === 0x10B ? 'PE32' : hex(magic), 'header',
      'Entry point, image base, subsystem and data directories', optChildren))
  }

  // ---------------------------------------------------------------- section table
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
    summary.push(item(`Section ${i + 1}`, section.name || '(unnamed)', [
      `Virtual Size: ${hex(section.virtualSize)} bytes`,
      `Virtual Address: ${hex(section.virtualAddress)}`,
      `Raw Size: ${hex(section.rawSize)} bytes`,
      `Raw Address: ${hex(section.rawAddress)}`,
      `Characteristics: ${sectionFlagsText(section.characteristics)}`
    ], 'Sections'))
    if (section.rawSize > 0 && section.rawAddress < fileSize) {
      regions.push({
        name: section.name || `Section ${i + 1}`,
        offset: section.rawAddress,
        length: Math.min(section.rawSize, fileSize - section.rawAddress),
        kind: isCodeSection(section) ? 'code' : 'data'
      })
    }
  }
  if (sections.length) {
    const nodes = tableNodes(view, sectionHeadersOffset, sections.length, 40, budget, (i, at) => {
      const s = sections[i]
      const { children } = readStruct(view, at + 8, SECTION_HEADER_SPEC, true, budget)
      budget.left -= 2
      return field(`[${i}] ${s.name || '(unnamed)'}`, at, 40, `RVA ${hex(s.virtualAddress)}, raw ${hex(s.rawAddress)}, ${hex(s.rawSize)} bytes`, 'header',
        sectionFlagsText(s.characteristics), [field('Name', at, 8, s.name, 'string', 'Section name, or "/n": offset n into the COFF string table'), ...children])
    }, 'section headers')
    fields.push(field('Section table', sectionHeadersOffset, sections.length * 40, `${sections.length} sections`, 'header', 'Where each section lives in the file and in memory', nodes))
  }
  const headerEnd = Math.min(sectionHeadersOffset + sections.length * 40, fileSize)
  regions.push({ name: 'PE headers', offset: peOffset, length: headerEnd - peOffset, kind: 'header' })
  if (sections.length < declaredSections) {
    warnings.push(`Section table truncated: ${sections.length} of ${declaredSections} sections readable`)
  }

  const sizeOfHeaders = opt.SizeOfHeaders ?? 0
  const rvaToFileOffset = (rva) => {
    for (const section of sections) {
      // VirtualSize may legally be 0, in which case only the raw size describes the section
      const span = Math.max(section.virtualSize, section.rawSize)
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        const delta = rva - section.virtualAddress
        if (delta >= section.rawSize) return null
        const offset = section.rawAddress + delta
        return offset < fileSize ? offset : null
      }
    }
    // The headers are mapped at RVA 0
    return rva >= 0 && rva < sizeOfHeaders && rva < fileSize ? rva : null
  }
  const sectionForRva = rva => sections.find(s => rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize))
  const stringAt = (rva) => {
    const offset = rvaToFileOffset(rva)
    return offset === null ? '' : readCString(view, offset)
  }
  const directory = index => (directories[index] && (directories[index].rva || directories[index].size) ? directories[index] : null)

  // ---------------------------------------------------------------- first-look facts
  if (opt.Subsystem !== undefined) summary.push(item('Subsystem', SUBSYSTEMS[opt.Subsystem] || `Unknown (${opt.Subsystem})`))
  if (opt.AddressOfEntryPoint !== undefined) {
    const entry = opt.AddressOfEntryPoint
    const section = sectionForRva(entry)
    summary.push(item('Entry point', entry ? `RVA ${hex(entry)}` : 'none', [
      entry && section ? `In section ${section.name || '(unnamed)'}` : '',
      entry && opt.ImageBase !== undefined ? `Virtual address ${hexBig(BigInt(opt.ImageBase) + BigInt(entry))}` : '',
      entry ? '' : 'DLLs without initialisation code have no entry point'
    ]))
  }
  if (opt.ImageBase !== undefined) summary.push(item('Image base', hexBig(opt.ImageBase)))
  if (opt.MajorLinkerVersion !== undefined && opt.MinorLinkerVersion !== undefined) {
    summary.push(item('Linker version', `${opt.MajorLinkerVersion}.${opt.MinorLinkerVersion}`, [
      `Format: ${isPE32Plus ? 'PE32+ (64-bit)' : magic === 0x10B ? 'PE32 (32-bit)' : 'unknown'}`,
      opt.MajorOperatingSystemVersion !== undefined ? `Required OS version: ${opt.MajorOperatingSystemVersion}.${opt.MinorOperatingSystemVersion}` : '',
      opt.MajorSubsystemVersion !== undefined ? `Subsystem version: ${opt.MajorSubsystemVersion}.${opt.MinorSubsystemVersion}` : ''
    ]))
  }

  const dllFlags = opt.DllCharacteristics
  if (dllFlags !== undefined) {
    const relocStripped = Boolean(characteristics & 0x1)
    const yes = bit => Boolean(dllFlags & bit)
    summary.push(item('ASLR', yes(0x40) ? (relocStripped ? 'requested, but relocations are stripped' : 'yes') : 'no', [
      'DYNAMIC_BASE: the image can be loaded at a random address',
      relocStripped ? 'Without relocations the loader cannot move the image' : ''
    ], 'Security'))
    if (isPE32Plus) {
      summary.push(item('High-entropy VA', yes(0x20) ? 'yes' : 'no', ['64-bit ASLR using the full address space'], 'Security'))
    }
    summary.push(item('DEP', yes(0x100) ? 'yes' : 'no', ['NX_COMPAT: data pages are not executable'], 'Security'))
    summary.push(item('Control Flow Guard', yes(0x4000) ? 'yes' : 'no', ['GUARD_CF: indirect calls are checked against a table of valid targets'], 'Security'))
    const others = decodeFlags(dllFlags & ~0x4160, DLL_CHARACTERISTICS)
    summary.push(item('DLL characteristics', hex(dllFlags), others.length ? ['Other flags:', ...others] : ['No other flags'], 'Security'))
  }

  // ---------------------------------------------------------------- exports
  const exportDir = directory(0)
  if (exportDir && exportDir.rva && exportDir.size) {
    const { rva: exportRVA, size: exportSize } = exportDir
    const exportOffset = rvaToFileOffset(exportRVA)
    if (exportOffset === null || !inBounds(view, exportOffset, 40)) {
      summary.push(item('Export Directory', 'unreadable (outside file data)'))
    } else {
      const exportStruct = readStruct(view, exportOffset, [
        ['Characteristics', 4, 'flags', 'Reserved, must be zero', v => hex(v)],
        ['TimeDateStamp', 4, 'data', 'Time the export data was created', v => hex(v)],
        ['MajorVersion', 2, 'data', 'Major version', v => String(v)],
        ['MinorVersion', 2, 'data', 'Minor version', v => String(v)],
        ['Name', 4, 'offset', 'RVA of the DLL name', v => `${hex(v)} (${stringAt(v) || '?'})`],
        ['Base', 4, 'count', 'Ordinal of the first entry in the address table'],
        ['NumberOfFunctions', 4, 'count', 'Entries in the export address table'],
        ['NumberOfNames', 4, 'count', 'Entries in the name pointer table'],
        ['AddressOfFunctions', 4, 'offset', 'RVA of the export address table', v => hex(v)],
        ['AddressOfNames', 4, 'offset', 'RVA of the name pointer table', v => hex(v)],
        ['AddressOfNameOrdinals', 4, 'offset', 'RVA of the ordinal table', v => hex(v)]
      ], true, budget)
      const ev = exportStruct.values
      const dllName = stringAt(ev.Name)
      const ordinalBase = ev.Base
      const numberOfFunctions = ev.NumberOfFunctions
      const numberOfNames = ev.NumberOfNames
      const functionsOffset = rvaToFileOffset(ev.AddressOfFunctions)
      const namesOffset = rvaToFileOffset(ev.AddressOfNames)
      const ordinalsOffset = rvaToFileOffset(ev.AddressOfNameOrdinals)
      contentFields.push(field('Export directory', exportOffset, 40, dllName || '(unnamed)', 'table', 'Header of the export tables', exportStruct.children))

      const namedOrdinals = new Set()
      if (namesOffset !== null && ordinalsOffset !== null && functionsOffset !== null) {
        const count = Math.min(
          numberOfNames,
          MAX_SYMBOLS,
          Math.floor((fileSize - namesOffset) / 4),
          Math.floor((fileSize - ordinalsOffset) / 2)
        )
        for (let i = 0; i < count; i++) {
          const name = stringAt(view.getUint32(namesOffset + i * 4, true))
          if (!name) continue
          const index = view.getUint16(ordinalsOffset + i * 2, true)
          namedOrdinals.add(index)
          const ordinal = `ordinal ${index + ordinalBase}`
          if (!inBounds(view, functionsOffset + index * 4, 4)) {
            symbols.push({ name, type: 'T', note: ordinal, kind: 'function', reason: 'Its export address table entry is outside the file' })
            continue
          }
          const functionRVA = view.getUint32(functionsOffset + index * 4, true)
          if (functionRVA >= exportRVA && functionRVA < exportRVA + exportSize) {
            const forwarderOffset = rvaToFileOffset(functionRVA)
            const target = forwarderOffset === null ? '?' : readCString(view, forwarderOffset)
            const symbol = { name, type: 'I', note: `-> ${target}, ${ordinal}`, kind: 'function' }
            if (forwarderOffset !== null) {
              symbol.offset = forwarderOffset
              symbol.size = target.length + 1
            } else {
              symbol.reason = 'Forwarder string is outside the file'
            }
            symbols.push(symbol)
          } else {
            const section = sectionForRva(functionRVA)
            const isData = Boolean(section && !isCodeSection(section))
            const symbol = { name, type: isData ? 'D' : 'T', address: hex(functionRVA), note: ordinal, kind: isData ? 'data' : 'function' }
            const offset = rvaToFileOffset(functionRVA)
            if (offset !== null) symbol.offset = offset
            else symbol.reason = section ? `In ${section.name || 'a section'} past its data in the file (zero-filled in memory)` : 'RVA is outside every section'
            symbols.push(symbol)
          }
        }
      }

      summary.push(item('Export Directory', dllName || '(unnamed)', [
        `DLL Name: ${dllName || '(none)'}`,
        `Ordinal Base: ${ordinalBase}`,
        `Number of Functions: ${numberOfFunctions}`,
        `Number of Names: ${numberOfNames}`,
        numberOfFunctions > namedOrdinals.size && numberOfFunctions <= MAX_SYMBOLS
          ? `Exported by ordinal only (or unused slots): ${numberOfFunctions - namedOrdinals.size}`
          : ''
      ]))
    }
  }

  // ---------------------------------------------------------------- imports
  const pointerSize = isPE32Plus ? 8 : 4
  const libraries = [] // { name, functions: [], delay }
  let importCount = 0

  // Walks an import lookup table; `toRva` converts entries (RVAs, or VAs in old delay-load tables)
  const readThunks = (tableRva, library, toRva) => {
    const tableOffset = rvaToFileOffset(tableRva)
    if (tableOffset === null) return
    for (let i = 0; i < MAX_IMPORTS_PER_DLL && importCount < MAX_SYMBOLS; i++) {
      const at = tableOffset + i * pointerSize
      if (!inBounds(view, at, pointerSize)) break
      const raw = isPE32Plus ? view.getBigUint64(at, true) : BigInt(view.getUint32(at, true))
      if (!raw) break
      const byOrdinal = (raw >> BigInt(pointerSize * 8 - 1)) === 1n
      const suffix = library.delay ? ', delay-loaded' : ''
      const symbol = { name: '', type: 'U', kind: 'function', library: library.name }
      if (byOrdinal) {
        const ordinal = Number(raw & 0xffffn)
        symbol.name = `${library.name}#${ordinal}`
        symbol.note = `${library.name}, ordinal ${ordinal}${suffix}`
        symbol.offset = at
        symbol.size = pointerSize
      } else {
        const hintOffset = rvaToFileOffset(toRva(Number(raw & 0x7fffffffn)))
        const name = hintOffset === null || !inBounds(view, hintOffset, 3) ? '' : readCString(view, hintOffset + 2)
        if (!name) continue
        symbol.name = name
        symbol.note = `${library.name}${suffix}`
        // The hint/name entry: a 2-byte hint into the DLL's export names, then the name
        symbol.offset = hintOffset
        symbol.size = 2 + name.length + 1
      }
      library.functions.push(symbol.name)
      symbols.push(symbol)
      importCount++
    }
  }

  const readDescriptors = (dir, entrySize, spec, delay) => {
    const start = rvaToFileOffset(dir.rva)
    if (start === null) return
    const nodes = []
    let at = start
    for (let i = 0; i < MAX_IMPORT_DLLS && inBounds(view, at, entrySize); i++) {
      const values = readStruct(view, at, spec, true, null).values
      const nameRva = delay ? values.DllNameRVA : values.Name
      const table = delay ? values.ImportNameTableRVA : values.OriginalFirstThunk || values.FirstThunk
      at += entrySize
      if (!nameRva && !table) break
      // Version 1 delay descriptors hold RVAs; older ones hold virtual addresses
      const base = Number(opt.ImageBase ?? 0)
      const toRva = !delay || values.Attributes & 1 ? v => v : v => v - base
      const library = { name: stringAt(toRva(nameRva)) || '(unnamed)', functions: [], delay }
      libraries.push(library)
      readThunks(toRva(table), library, toRva)
      if (nodes.length < MAX_TABLE_ENTRIES && budget.left > spec.length) {
        const { children } = readStruct(view, at - entrySize, spec, true, budget)
        budget.left--
        nodes.push(field(library.name, at - entrySize, entrySize, `${library.functions.length} imports`, 'header', delay ? 'Delay-load descriptor' : 'Import descriptor', children))
      }
    }
    if (nodes.length) {
      contentFields.push(field(delay ? 'Delay import directory' : 'Import directory', start, at - start, `${nodes.length} DLLs`, 'table',
        delay ? 'DLLs loaded the first time one of their functions is called' : 'One descriptor per imported DLL, ending with an empty one', nodes))
    }
  }
  const importDir = directory(1)
  if (importDir && importDir.rva) readDescriptors(importDir, 20, IMPORT_DESCRIPTOR_SPEC, false)
  const delayDir = directory(13)
  if (delayDir && delayDir.rva) readDescriptors(delayDir, 32, DELAY_DESCRIPTOR_SPEC, true)

  for (const library of libraries.slice(0, MAX_SUMMARY_LIBRARIES)) {
    const count = library.functions.length
    summary.push(item(library.name, `${count} function${count === 1 ? '' : 's'}${library.delay ? ', delay-loaded' : ''}`,
      count > MAX_SUMMARY_LINES
        ? [...library.functions.slice(0, MAX_SUMMARY_LINES), `… and ${count - MAX_SUMMARY_LINES} more`]
        : library.functions,
      'Imports'))
  }
  if (libraries.length > MAX_SUMMARY_LIBRARIES) {
    summary.push(item('More DLLs', String(libraries.length - MAX_SUMMARY_LIBRARIES), null, 'Imports'))
  }

  // ---------------------------------------------------------------- debug directory
  const debugDir = directory(6)
  if (debugDir && debugDir.rva && debugDir.size) {
    const start = rvaToFileOffset(debugDir.rva)
    if (start !== null) {
      const count = Math.min(Math.floor(debugDir.size / 28), MAX_DEBUG_ENTRIES)
      const types = []
      let pdbPath = ''
      const nodes = tableNodes(view, start, count, 28, budget, (i, at) => {
        const { children, values } = readStruct(view, at, DEBUG_ENTRY_SPEC, true, budget)
        const { Type: type, SizeOfData: sizeOfData, PointerToRawData: pointer } = values
        types.push(DEBUG_TYPES[type] || `type ${type}`)
        let path = ''
        if (type === 2 && sizeOfData >= 24 && inBounds(view, pointer, 24)) {
          const end = Math.min(pointer + sizeOfData, fileSize)
          const signature = view.getUint32(pointer, true)
          if (signature === 0x53445352) path = readCString(view, pointer + 24, end) // RSDS: GUID and age, then the path
          else if (signature === 0x3031424E) path = readCString(view, pointer + 16, end) // NB10
          if (path && !pdbPath) {
            pdbPath = path
            if (budget.left-- > 0) {
              contentFields.push(field('CodeView record', pointer, end - pointer, path, 'metadata', 'Debug record naming the PDB file that holds this image\'s symbols'))
            }
          }
        }
        budget.left--
        return field(DEBUG_TYPES[type] || `Type ${type}`, at, 28, path || `${hex(sizeOfData)} bytes`, 'header', 'Debug directory entry', children)
      }, 'debug entries')
      if (nodes.length) {
        const last = nodes[nodes.length - 1]
        contentFields.push(field('Debug directory', start, last.offset + last.length - start, types.join(', '), 'table', 'Pointers to debug information', nodes))
      }
      summary.push(item('PDB path', pdbPath || 'none', [
        pdbPath ? 'The PDB file the linker wrote; the path can reveal the build machine\'s folders' : 'No CodeView record',
        types.length ? `Debug records: ${types.join(', ')}` : ''
      ]))
    }
  }

  // ---------------------------------------------------------------- .NET
  const clrDir = directory(14)
  if (clrDir && clrDir.rva) {
    const at = rvaToFileOffset(clrDir.rva)
    if (at !== null && inBounds(view, at, 24)) {
      const clr = readStruct(view, at, [
        ['cb', 4, 'size', 'Size of this header'],
        ['MajorRuntimeVersion', 2, 'data', 'Minimum CLR major version', v => String(v)],
        ['MinorRuntimeVersion', 2, 'data', 'Minimum CLR minor version', v => String(v)],
        ['MetaDataRVA', 4, 'offset', 'RVA of the metadata root', v => hex(v)],
        ['MetaDataSize', 4, 'size', 'Size of the metadata', v => hex(v)],
        ['Flags', 4, 'flags', 'Runtime flags', v => `${hex(v)} (${decodeFlags(v, CLR_FLAGS).join(', ') || 'none'})`],
        ['EntryPointToken', 4, 'data', 'Metadata token or RVA of the managed entry point', v => hex(v)]
      ], true, budget)
      contentFields.push(field('CLR header', at, clr.end - at, '.NET', 'header', 'Marks a .NET assembly and locates its metadata', clr.children))
      let runtime = ''
      const metadata = clr.values.MetaDataRVA !== undefined ? rvaToFileOffset(clr.values.MetaDataRVA) : null
      if (metadata !== null && inBounds(view, metadata, 16) && view.getUint32(metadata, true) === 0x424A5342) { // BSJB
        const length = view.getUint32(metadata + 12, true)
        runtime = readCString(view, metadata + 16, metadata + 16 + Math.min(length, 256))
      }
      summary.push(item('.NET assembly', runtime ? `yes, metadata version ${runtime}` : 'yes', [
        'Contains managed code: a .NET decompiler shows more than a disassembler',
        ...decodeFlags(clr.values.Flags || 0, CLR_FLAGS)
      ]))
    }
  }

  // ---------------------------------------------------------------- certificate, COFF symbols, overlay
  const certDir = directory(4)
  let certificate = null
  if (certDir && certDir.rva && certDir.size) {
    const at = certDir.rva // a file offset, not an RVA
    if (inBounds(view, at, 8)) {
      const length = Math.min(certDir.size, fileSize - at)
      const type = view.getUint16(at + 6, true)
      certificate = { length, type }
      const cert = readStruct(view, at, [
        ['dwLength', 4, 'size', 'Length of this certificate entry', v => hex(v)],
        ['wRevision', 2, 'data', '0x200 for WIN_CERT_REVISION_2_0', v => hex(v)],
        ['wCertificateType', 2, 'header', 'Kind of certificate', v => CERTIFICATE_TYPES[v] || hex(v)]
      ], true, budget)
      if (length > 8) cert.children.push(field('bCertificate', at + 8, length - 8, undefined, 'data', 'The signature (for Authenticode: a PKCS #7 SignedData blob)'))
      contentFields.push(field('Certificate table', at, length, CERTIFICATE_TYPES[type] || hex(type), 'metadata', 'Authenticode signature, appended after the image', cert.children))
      regions.push({ name: 'Certificate table', offset: at, length, kind: 'metadata' })
    } else {
      warnings.push('Certificate table points outside the file')
    }
  }
  if (dllFlags !== undefined) {
    summary.push(item('Authenticode signature', certificate ? `present (${CERTIFICATE_TYPES[certificate.type] || hex(certificate.type)}, ${certificate.length} bytes)` : 'none', [
      certificate ? 'Presence only: the signature and its certificate chain are not verified here' : 'No certificate table in the data directories'
    ], 'Security'))
  }

  const hasCoffSymbols = Boolean(symbolTableOffset && numberOfSymbols && symbolTableOffset < fileSize)
  if (hasCoffSymbols) {
    const length = Math.min(numberOfSymbols * 18, fileSize - symbolTableOffset)
    regions.push({ name: 'COFF symbol table', offset: symbolTableOffset, length, kind: 'table' })
    if (inBounds(view, stringTableOffset, 4)) {
      const stringsLength = view.getUint32(stringTableOffset, true)
      if (stringsLength >= 4) regions.push({ name: 'COFF string table', offset: stringTableOffset, length: Math.min(stringsLength, fileSize - stringTableOffset), kind: 'table' })
    }
    summary.push(item('COFF symbol table', `${numberOfSymbols} entries`, ['Left in by the linker (common with MinGW); its symbols are not listed in the Symbols tab']))
  }

  const lastSectionEnd = sections.reduce((max, s) => (s.rawSize && s.rawAddress < fileSize ? Math.max(max, Math.min(s.rawAddress + s.rawSize, fileSize)) : max), 0)
  const firstSectionStart = sections.reduce((min, s) => (s.rawSize && s.rawAddress ? Math.min(min, s.rawAddress) : min), Infinity)
  const tiled = tileRegions(regions, fileSize, 'Unmapped bytes', bytes)
  let overlay = 0
  for (const region of tiled) {
    if (region.name !== 'Unmapped bytes') continue
    if (lastSectionEnd && region.offset >= lastSectionEnd) {
      region.name = 'Overlay'
      region.kind = 'data'
      overlay += region.length
    } else if (region.offset >= headerEnd && region.offset < firstSectionStart) {
      region.name = 'Header padding'
    }
  }
  if (lastSectionEnd) {
    summary.push(item('Overlay', overlay ? `${overlay} bytes` : 'none', [
      'Data after the last section that the loader does not map; installers and self-extracting archives keep payloads here',
      certificate || hasCoffSymbols ? 'Not counting the certificate table and COFF symbols' : ''
    ]))
  }
  if (rich) {
    summary.push(item('Rich header', `present (${rich.entries.length} entries)`, [
      'Built with Microsoft tools; each entry is a tool build and how many objects it produced',
      ...rich.entries.slice(0, 40).map(e => `product ${e.product}, build ${e.build}: ${e.count}`)
    ]))
  }

  fields.push(...contentFields)
  fields.sort((a, b) => a.offset - b.offset)
  return { summary, fields, regions: tiled, symbols: sortSymbols(symbols), warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'pe',
  name: 'Windows PE Executable',
  category: 'executable',
  detect: bytes => bytes.length >= 2 && bytes[0] === 0x4D && bytes[1] === 0x5A,
  parse(bytes) {
    const view = dataView(bytes)
    if (peHeaderOffset(view) === null) {
      return {
        summary: [item('PE header', 'not found (MS-DOS executable or truncated file)')],
        fields: [{ name: 'DOS signature', offset: 0, length: 2, value: 'MZ', kind: 'magic' }]
      }
    }
    try {
      return parsePE(view, bytes)
    } catch (err) {
      throw new Error(`PE parsing error: ${err.message}`)
    }
  }
}
