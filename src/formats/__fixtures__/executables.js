// Builders for small synthetic executables used by the binary analysis tests.
// Each returns an ArrayBuffer laid out like the real format, with only the
// structures the parsers read.

class Writer {
  constructor(littleEndian = true) {
    this.le = littleEndian
    this.buf = new Uint8Array(1024)
    this.view = new DataView(this.buf.buffer)
    this.length = 0
  }

  get pos() {
    return this.length
  }

  reserve(n) {
    if (this.length + n <= this.buf.length) return
    let size = this.buf.length
    while (size < this.length + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf)
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  advance(n) {
    this.reserve(n)
    const at = this.length
    this.length += n
    return at
  }

  // advance() may replace this.view, so take the offset before touching the view
  u8(v) { const at = this.advance(1); this.view.setUint8(at, v); return this }
  u16(v) { const at = this.advance(2); this.view.setUint16(at, v, this.le); return this }
  u32(v) { const at = this.advance(4); this.view.setUint32(at, v >>> 0, this.le); return this }
  u64(v) { const at = this.advance(8); this.view.setBigUint64(at, BigInt(v), this.le); return this }
  addr(v, is64) { return is64 ? this.u64(v) : this.u32(v) }

  bytes(arr) {
    const at = this.advance(arr.length)
    this.buf.set(arr, at)
    return this
  }

  ascii(s) {
    return this.bytes(Array.from(s, c => c.charCodeAt(0)))
  }

  cstr(s) {
    return this.ascii(s).u8(0)
  }

  fixed(s, n) {
    const at = this.advance(n)
    for (let i = 0; i < s.length && i < n; i++) this.buf[at + i] = s.charCodeAt(i)
    return this
  }

  zeros(n) {
    this.advance(n)
    return this
  }

  align(n) {
    while (this.length % n) this.u8(0)
    return this
  }

  set16(at, v) { this.view.setUint16(at, v, this.le) }
  set32(at, v) { this.view.setUint32(at, v >>> 0, this.le) }
  setAddr(at, v, is64) {
    if (is64) this.view.setBigUint64(at, BigInt(v), this.le)
    else this.view.setUint32(at, v >>> 0, this.le)
  }

  toArrayBuffer() {
    return this.buf.slice(0, this.length).buffer
  }
}

function stringTable(names) {
  const offsets = new Map()
  const w = new Writer()
  w.u8(0)
  for (const name of names) {
    if (offsets.has(name)) continue
    offsets.set(name, w.pos)
    w.cstr(name)
  }
  return { bytes: new Uint8Array(w.toArrayBuffer()), offsets }
}

// ---------------------------------------------------------------- ELF

const ELF_BIND = { local: 0, global: 1, weak: 2 }
const ELF_TYPE = { notype: 0, object: 1, func: 2, section: 3, file: 4 }
const ELF_SPECIAL_SECTION = { undef: 0, abs: 0xfff1, common: 0xfff2 }

export const ELF_SAMPLE_SYMBOLS = [
  { name: 'hello.c', bind: 'local', type: 'file', section: 'abs', value: 0 },
  { name: '', bind: 'local', type: 'section', section: 'text', value: 0x1000 },
  { name: 'helper', bind: 'local', type: 'func', section: 'text', value: 0x1010 },
  { name: 'main', bind: 'global', type: 'func', section: 'text', value: 0x1040 },
  { name: '_start', bind: 'global', type: 'func', section: 'text', value: 0x1000 },
  { name: 'global_counter', bind: 'global', type: 'object', section: 'data', value: 0x3000 },
  { name: 'buffer', bind: 'global', type: 'object', section: 'bss', value: 0x3010 },
  { name: 'completed.0', bind: 'local', type: 'object', section: 'bss', value: 0x3020 },
  { name: 'version_string', bind: 'global', type: 'object', section: 'rodata', value: 0x2000 },
  { name: 'data_start', bind: 'weak', type: 'notype', section: 'data', value: 0x3000 },
  { name: '__gmon_start__', bind: 'weak', type: 'notype', section: 'undef', value: 0 },
  { name: 'printf', bind: 'global', type: 'func', section: 'undef', value: 0 },
  { name: 'malloc', bind: 'global', type: 'func', section: 'undef', value: 0 }
]

/**
 * options:
 *   is64, littleEndian, machine
 *   symbols: [{ name, bind, type, section: text|rodata|data|bss|undef|abs|common, value }]
 *   dynamic: emit the table as SHT_DYNSYM/.dynstr instead of SHT_SYMTAB/.names
 *   symEntsize: override the symbol table's sh_entsize
 *   symOffsetOverride: override the symbol table's sh_offset
 *   noSectionHeaders: e_shoff = 0, e_shnum = 0
 */
export function buildELF({
  is64 = true,
  littleEndian = true,
  machine = 0x3E,
  symbols = ELF_SAMPLE_SYMBOLS,
  dynamic = false,
  symEntsize,
  symOffsetOverride,
  noSectionHeaders = false
} = {}) {
  const w = new Writer(littleEndian)
  const ehsize = is64 ? 64 : 52
  const shentsize = is64 ? 64 : 40
  const symentsize = is64 ? 24 : 16
  w.zeros(ehsize)

  // Section indices
  const TEXT = 1, RODATA = 2, DATA = 3, BSS = 4, STRTAB = 5, SHSTRTAB = 7
  const sectionIndex = { text: TEXT, rodata: RODATA, data: DATA, bss: BSS }

  w.align(16)
  const textOffset = w.pos
  w.zeros(0x60)
  const rodataOffset = w.pos
  w.zeros(0x20)
  const dataOffset = w.pos
  w.zeros(0x20)
  const bssOffset = w.pos

  // The string table deliberately has an unusual name: the parser must find it via sh_link
  const strtabName = dynamic ? '.dynstr' : '.names'
  const symtabName = dynamic ? '.dynsym' : '.symtab'
  const sectionNames = ['.text', '.rodata', '.data', '.bss', strtabName, symtabName, '.shstrtab']
  const shstr = stringTable(sectionNames)
  const strings = stringTable(symbols.map(s => s.name).filter(Boolean))

  const strtabOffset = w.pos
  w.bytes(strings.bytes)
  w.align(8)
  const symtabOffset = w.pos
  w.zeros(symentsize) // index 0 is the null symbol
  for (const sym of symbols) {
    const nameIndex = sym.name ? strings.offsets.get(sym.name) : 0
    const info = (ELF_BIND[sym.bind] << 4) | ELF_TYPE[sym.type]
    const shndx = sym.section in ELF_SPECIAL_SECTION ? ELF_SPECIAL_SECTION[sym.section] : sectionIndex[sym.section]
    if (is64) {
      w.u32(nameIndex).u8(info).u8(0).u16(shndx).u64(sym.value).u64(0)
    } else {
      w.u32(nameIndex).u32(sym.value).u32(0).u8(info).u8(0).u16(shndx)
    }
  }
  const symtabSize = w.pos - symtabOffset
  const shstrtabOffset = w.pos
  w.bytes(shstr.bytes)
  w.align(8)
  const shoff = w.pos

  const header = (name, type, flags, addr, offset, size, link, info, align, entsize) => {
    const nameIndex = name ? shstr.offsets.get(name) : 0
    w.u32(nameIndex).u32(type)
    w.addr(flags, is64).addr(addr, is64).addr(offset, is64).addr(size, is64)
    w.u32(link).u32(info)
    w.addr(align, is64).addr(entsize, is64)
  }
  header('', 0, 0, 0, 0, 0, 0, 0, 0, 0)
  header('.text', 1, 0x6, 0x1000, textOffset, 0x60, 0, 0, 16, 0)
  header('.rodata', 1, 0x2, 0x2000, rodataOffset, 0x20, 0, 0, 8, 0)
  header('.data', 1, 0x3, 0x3000, dataOffset, 0x10, 0, 0, 8, 0)
  header('.bss', 8, 0x3, 0x3010, bssOffset, 0x20, 0, 0, 8, 0)
  header(strtabName, 3, dynamic ? 0x2 : 0, 0, strtabOffset, strings.bytes.length, 0, 0, 1, 0)
  header(symtabName, dynamic ? 11 : 2, dynamic ? 0x2 : 0, 0,
    symOffsetOverride ?? symtabOffset, symtabSize, STRTAB, 1, 8,
    symEntsize ?? symentsize)
  header('.shstrtab', 3, 0, 0, shstrtabOffset, shstr.bytes.length, 0, 0, 1, 0)
  const shnum = 8

  // ELF header
  w.buf.set([0x7F, 0x45, 0x4C, 0x46, is64 ? 2 : 1, littleEndian ? 1 : 2, 1, 0], 0)
  w.set16(16, 3) // ET_DYN
  w.set16(18, machine)
  w.set32(20, 1)
  if (is64) {
    w.setAddr(40, noSectionHeaders ? 0 : shoff, true)
    w.set16(52, ehsize)
    w.set16(58, shentsize)
    w.set16(60, noSectionHeaders ? 0 : shnum)
    w.set16(62, noSectionHeaders ? 0 : SHSTRTAB)
  } else {
    w.set32(32, noSectionHeaders ? 0 : shoff)
    w.set16(40, ehsize)
    w.set16(46, shentsize)
    w.set16(48, noSectionHeaders ? 0 : shnum)
    w.set16(50, noSectionHeaders ? 0 : SHSTRTAB)
  }
  return w.toArrayBuffer()
}

// ---------------------------------------------------------------- Mach-O

export const CPU_TYPE_X86 = 7
export const CPU_TYPE_X86_64 = 0x01000007
export const CPU_TYPE_ARM64 = 0x0100000c

const N_EXT = 0x01
const N_SECT = 0x0e
const N_UNDF = 0x00
const N_STAB_FUN = 0x24

// Mirrors the symbols of a small C program: n_sect 1 is __TEXT,__text,
// 2 is __TEXT,__cstring, 3 is __DATA,__data and 4 is __DATA,__bss.
export const MACHO_SAMPLE_SYMBOLS = [
  { name: '_main', type: N_SECT | N_EXT, sect: 1, value: 0x100003f00 },
  { name: '_compute', type: N_SECT | N_EXT, sect: 1, value: 0x100003e80 },
  { name: '_global_counter', type: N_SECT | N_EXT, sect: 3, value: 0x100008000 },
  { name: '_helper', type: N_SECT, sect: 1, value: 0x100003e60 },
  { name: '_message', type: N_SECT, sect: 2, value: 0x100003f80 },
  { name: '_scratch', type: N_SECT | N_EXT, sect: 4, value: 0x100008010 },
  { name: '_printf', type: N_UNDF | N_EXT, sect: 0, desc: 0x0100, value: 0 },
  { name: '_malloc', type: N_UNDF | N_EXT, sect: 0, desc: 0x0100, value: 0 },
  { name: '__mh_execute_header', type: N_SECT | N_EXT, sect: 1, desc: 0x0010, value: 0x100000000 },
  { name: '_main', type: N_STAB_FUN, sect: 1, value: 0x100003f00 }
]

export const MACHO_SAMPLE_SEGMENTS = [
  { segname: '__TEXT', sections: [
    { sectname: '__text', flags: 0x80000400 },
    { sectname: '__cstring', flags: 0x2 }
  ] },
  { segname: '__DATA', sections: [
    { sectname: '__data', flags: 0 },
    { sectname: '__bss', flags: 0x1 }
  ] }
]

/**
 * options:
 *   is64, cputype, cpusubtype, filetype, flags
 *   segments: [{ segname, vmaddr?, fileoff?, filesize?, sections: [{ sectname, flags, addr?, size?, offset? }] }]
 *   symbols: [{ name, type, sect, desc, value }]
 *   extraCommands: raw { cmd, cmdsize } pairs written before LC_SYMTAB
 *   ncmdsOverride: value stored in the header's ncmds
 *   dylibs: install names of LC_LOAD_DYLIB commands (library ordinals 1, 2, …)
 *   uuid: 16 bytes for LC_UUID
 *   buildVersion: { platform, minos, sdk } as packed versions
 *   entryoff: LC_MAIN entry offset
 *   rpath: LC_RPATH path
 *   encryption: { cryptoff, cryptsize, cryptid }
 *   codeSignature: { identifier, flags } appended after the string table as an
 *     ad-hoc SuperBlob with one CodeDirectory
 *   padTo: zero-fill the file to this size, so sections can point past the tables
 */
export function buildMachO({
  is64 = true,
  cputype = CPU_TYPE_ARM64,
  cpusubtype = 0,
  filetype = 2,
  flags = 0,
  segments = MACHO_SAMPLE_SEGMENTS,
  symbols = MACHO_SAMPLE_SYMBOLS,
  extraCommands = [],
  ncmdsOverride,
  dylibs = [],
  uuid,
  buildVersion,
  entryoff,
  rpath,
  encryption,
  codeSignature,
  padTo = 0
} = {}) {
  const w = new Writer(true)
  const headerSize = is64 ? 32 : 28
  w.u32(is64 ? 0xfeedfacf : 0xfeedface).u32(cputype).u32(cpusubtype).u32(filetype)
  const ncmdsAt = w.pos
  w.u32(0).u32(0).u32(flags)
  if (is64) w.u32(0)

  let ncmds = 0
  for (const segment of segments) {
    const start = w.pos
    w.u32(is64 ? 0x19 : 0x1).u32(0).fixed(segment.segname, 16)
    w.addr(segment.vmaddr || 0, is64).addr(segment.vmsize || 0, is64).addr(segment.fileoff || 0, is64).addr(segment.filesize || 0, is64)
    w.u32(7).u32(5).u32(segment.sections.length).u32(0)
    for (const section of segment.sections) {
      w.fixed(section.sectname, 16).fixed(segment.segname, 16)
      w.addr(section.addr || 0, is64).addr(section.size || 0, is64)
      w.u32(section.offset || 0).u32(0).u32(0).u32(0).u32(section.flags).u32(0).u32(0)
      if (is64) w.u32(0)
    }
    w.set32(start + 4, w.pos - start)
    ncmds++
  }
  const pathCommand = (cmd, path, fixedWords) => {
    const start = w.pos
    const headerLength = 12 + fixedWords.length * 4
    w.u32(cmd).u32(0).u32(headerLength)
    for (const word of fixedWords) w.u32(word)
    w.cstr(path).align(8)
    w.set32(start + 4, w.pos - start)
    ncmds++
  }
  for (const path of dylibs) pathCommand(0xc, path, [2, 0x10000, 0x10000])
  if (rpath) pathCommand(0x8000001c, rpath, [])
  if (uuid) {
    w.u32(0x1b).u32(24).bytes(uuid)
    ncmds++
  }
  if (buildVersion) {
    w.u32(0x32).u32(24).u32(buildVersion.platform).u32(buildVersion.minos).u32(buildVersion.sdk).u32(0)
    ncmds++
  }
  if (entryoff !== undefined) {
    w.u32(0x80000028).u32(24).u64(entryoff).u64(0)
    ncmds++
  }
  if (encryption) {
    w.u32(is64 ? 0x2c : 0x21).u32(is64 ? 24 : 20).u32(encryption.cryptoff).u32(encryption.cryptsize).u32(encryption.cryptid)
    if (is64) w.u32(0)
    ncmds++
  }
  let signatureCmd = null
  if (codeSignature) {
    signatureCmd = w.pos
    w.u32(0x1d).u32(16).u32(0).u32(0)
    ncmds++
  }
  for (const { cmd, cmdsize } of extraCommands) {
    w.u32(cmd).u32(cmdsize)
    ncmds++
  }

  const symtabCmd = w.pos
  w.u32(2).u32(24).u32(0).u32(symbols.length).u32(0).u32(0)
  ncmds++
  const sizeofcmds = w.pos - headerSize

  const strings = stringTable(symbols.map(s => s.name))
  const symoff = w.pos
  for (const sym of symbols) {
    w.u32(strings.offsets.get(sym.name)).u8(sym.type).u8(sym.sect).u16(sym.desc || 0)
    w.addr(sym.value, is64)
  }
  const stroff = w.pos
  w.bytes(strings.bytes)
  w.align(8)

  if (signatureCmd !== null) {
    // SuperBlob and CodeDirectory are big-endian
    const start = w.pos
    const be = new Writer(false)
    const ident = codeSignature.identifier || 'sample'
    const cdLength = 48 + ident.length + 1
    be.u32(0xfade0cc0).u32(20 + cdLength).u32(1).u32(0).u32(20)
    be.u32(0xfade0c02).u32(cdLength).u32(0x20400).u32(codeSignature.flags ?? 0x20002).u32(0).u32(48)
    be.zeros(24).cstr(ident)
    w.bytes(new Uint8Array(be.toArrayBuffer()))
    w.set32(signatureCmd + 8, start)
    w.set32(signatureCmd + 12, w.pos - start)
  }

  if (w.pos < padTo) w.zeros(padTo - w.pos)
  w.set32(symtabCmd + 8, symoff)
  w.set32(symtabCmd + 16, stroff)
  w.set32(symtabCmd + 20, strings.bytes.length)
  w.set32(ncmdsAt, ncmdsOverride ?? ncmds)
  w.set32(ncmdsAt + 4, sizeofcmds)
  return w.toArrayBuffer()
}

/** slices: [{ cputype, cpusubtype, image: ArrayBuffer }] */
export function buildFatMachO(slices, alignment = 0x1000) {
  const w = new Writer(false)
  w.u32(0xcafebabe).u32(slices.length)
  const entries = slices.map(() => {
    const at = w.pos
    w.zeros(20)
    return at
  })
  slices.forEach((slice, i) => {
    w.align(alignment)
    const offset = w.pos
    w.bytes(new Uint8Array(slice.image))
    const at = entries[i]
    w.set32(at, slice.cputype)
    w.set32(at + 4, slice.cpusubtype || 0)
    w.set32(at + 8, offset)
    w.set32(at + 12, slice.image.byteLength)
    w.set32(at + 16, Math.log2(alignment))
  })
  return w.toArrayBuffer()
}

// A minimal Java class file: same 0xCAFEBABE magic, then minor/major version.
export function buildJavaClass(major = 65) {
  const w = new Writer(false)
  w.u32(0xcafebabe).u16(0).u16(major)
  w.u16(3) // constant_pool_count
  w.u8(1).u16(5).ascii('Hello') // CONSTANT_Utf8
  w.u8(7).u16(1) // CONSTANT_Class
  w.u16(0x21).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0)
  return w.toArrayBuffer()
}

// ---------------------------------------------------------------- PE

/**
 * options:
 *   pe32Plus, machine, dllName, ordinalBase
 *   exports: [{ name, rva } | { name, forwarder } | { rva }] (no name: by ordinal only)
 *   edataVirtualSize: VirtualSize of the .edata section (0 is legal)
 *   extraDataSections: extra data sections with identical characteristics
 */
export function buildPE({
  pe32Plus = true,
  machine = 0x8664,
  dllName = 'sample.dll',
  ordinalBase = 1,
  exports = [
    { name: 'sample_init', rva: 0x1000 },
    { name: 'Alpha', rva: 0x1010 },
    { name: 'sample_table', rva: 0x3000 },
    { name: 'Forwarded', forwarder: 'NTDLL.RtlZeroMemory' },
    { rva: 0x1020 }
  ],
  edataVirtualSize = 0x200,
  extraDataSections = 2
} = {}) {
  const w = new Writer(true)
  const peOffset = 0x80
  w.ascii('MZ').zeros(0x3C - 2).u32(peOffset).zeros(peOffset - 0x40)

  const sections = [
    { name: '.text', rva: 0x1000, raw: 0x400, size: 0x200, vsize: 0x100, flags: 0x60000020 },
    { name: '.edata', rva: 0x2000, raw: 0x600, size: 0x200, vsize: edataVirtualSize, flags: 0x40000040 },
    { name: '.data', rva: 0x3000, raw: 0x800, size: 0x200, vsize: 0x100, flags: 0xC0000040 }
  ]
  for (let i = 0; i < extraDataSections; i++) {
    // Identical characteristics on purpose: each section must still be its own row
    sections.push({ name: `.rdata${i}`, rva: 0x4000 + i * 0x1000, raw: 0xA00 + i * 0x200, size: 0x200, vsize: 0x10, flags: 0x40000040 })
  }

  const optionalHeaderSize = pe32Plus ? 240 : 224
  w.ascii('PE').u16(0)
  w.u16(machine).u16(sections.length).u32(1262304000).u32(0).u32(0)
  w.u16(optionalHeaderSize).u16(pe32Plus ? 0x2022 : 0x2102)

  const optionalHeader = w.pos
  w.zeros(optionalHeaderSize)
  w.set16(optionalHeader, pe32Plus ? 0x20B : 0x10B)
  w.set32(optionalHeader + (pe32Plus ? 108 : 92), 16)
  const exportDirectoryEntry = optionalHeader + (pe32Plus ? 112 : 96)

  for (const s of sections) {
    w.fixed(s.name, 8).u32(s.vsize).u32(s.rva).u32(s.size).u32(s.raw)
    w.zeros(12).u32(s.flags)
  }
  const end = Math.max(...sections.map(s => s.raw + s.size))
  w.zeros(end - w.pos)

  // Export directory at the start of .edata
  const edata = sections[1]
  const toOffset = rva => rva - edata.rva + edata.raw
  let cursor = edata.rva + 40
  const take = n => {
    const at = cursor
    cursor += n
    return at
  }
  const functionsRva = take(exports.length * 4)
  const named = exports
    .map((e, index) => ({ ...e, index }))
    .filter(e => e.name)
    .sort((a, b) => (a.name < b.name ? -1 : 1))
  const namesRva = take(named.length * 4)
  const ordinalsRva = take(named.length * 2)

  const writeString = (s) => {
    const rva = take(s.length + 1)
    w.buf.set(Array.from(s, c => c.charCodeAt(0)), toOffset(rva))
    return rva
  }
  const nameRva = writeString(dllName)
  exports.forEach((e, i) => {
    const rva = e.forwarder ? writeString(e.forwarder) : e.rva
    w.set32(toOffset(functionsRva + i * 4), rva)
  })
  named.forEach((e, i) => {
    w.set32(toOffset(namesRva + i * 4), writeString(e.name))
    w.set16(toOffset(ordinalsRva + i * 2), e.index)
  })

  const dir = toOffset(edata.rva)
  w.set32(dir + 12, nameRva)
  w.set32(dir + 16, ordinalBase)
  w.set32(dir + 20, exports.length)
  w.set32(dir + 24, named.length)
  w.set32(dir + 28, functionsRva)
  w.set32(dir + 32, namesRva)
  w.set32(dir + 36, ordinalsRva)

  if (exports.length) {
    w.set32(exportDirectoryEntry, edata.rva)
    w.set32(exportDirectoryEntry + 4, cursor - edata.rva)
  }
  return w.toArrayBuffer()
}

// An MZ executable with no PE header: e_lfanew points past the end of the file.
export function buildDosOnly() {
  const w = new Writer(true)
  w.ascii('MZ').zeros(0x3C - 2).u32(0x4000).zeros(0x20)
  return w.toArrayBuffer()
}

// ---------------------------------------------------------------- linked ELF

/**
 * A dynamically linked ELF with program headers, an interpreter, a build-ID
 * note, a dynamic section, symbol versions and a .dynsym, laid out like
 * linker output (each LOAD segment maps file offsets to `base + offset`).
 *
 * options:
 *   is64, littleEndian
 *   kind: 'pie' | 'exec' | 'shared'
 *   relro: 'none' | 'partial' | 'full'
 *   execStack: PT_GNU_STACK with PF_X; noStackHeader: omit PT_GNU_STACK
 *   noSectionHeaders: e_shoff = 0 (everything must come from program headers)
 */
export function buildLinkedELF({
  is64 = true,
  littleEndian = true,
  kind = 'pie',
  relro = 'full',
  execStack = false,
  noStackHeader = false,
  noSectionHeaders = false
} = {}) {
  const w = new Writer(littleEndian)
  const A = is64 ? 8 : 4
  const ehsize = is64 ? 64 : 52
  const phentsize = is64 ? 56 : 32
  const shentsize = is64 ? 64 : 40
  const symentsize = is64 ? 24 : 16
  const base = kind === 'exec' ? 0x400000 : 0
  const PT = { LOAD: 1, DYNAMIC: 2, INTERP: 3, NOTE: 4, PHDR: 6, GNU_STACK: 0x6474e551, GNU_RELRO: 0x6474e552 }

  const phdrs = [{ type: PT.PHDR }, { type: PT.INTERP }, { type: PT.NOTE }, { type: PT.LOAD, id: 'ro' }, { type: PT.LOAD, id: 'rx' },
    { type: PT.LOAD, id: 'rw' }, { type: PT.DYNAMIC }]
  if (!noStackHeader) phdrs.push({ type: PT.GNU_STACK })
  if (relro !== 'none') phdrs.push({ type: PT.GNU_RELRO })
  w.zeros(ehsize)
  const phoff = w.pos
  w.zeros(phdrs.length * phentsize)

  const interpOff = w.pos
  const interp = is64 ? '/lib64/ld-linux-x86-64.so.2' : '/lib/ld-linux.so.2'
  w.cstr(interp).align(4)

  const noteOff = w.pos
  w.u32(4).u32(20).u32(3).ascii('GNU').u8(0)
  for (let i = 0; i < 20; i++) w.u8(0xa0 + i)
  const noteSize = w.pos - noteOff

  const dynstr = stringTable(['libc.so.6', 'libfoo.so.2', 'printf', 'GLIBC_2.2.5', '__stack_chk_fail', '__memcpy_chk',
    'exported_fn', 'libsample.so.1', '$ORIGIN/lib'])
  const dynstrOff = w.pos
  w.bytes(dynstr.bytes).align(8)

  // index: 0 null, 1 printf, 2 __stack_chk_fail, 3 __memcpy_chk, 4 exported_fn
  const dynsyms = [
    { name: 'printf', info: 0x12, shndx: 0, value: 0, size: 0, version: 2 },
    { name: '__stack_chk_fail', info: 0x12, shndx: 0, value: 0, size: 0, version: 2 },
    { name: '__memcpy_chk', info: 0x12, shndx: 0, value: 0, size: 0, version: 1 },
    { name: 'exported_fn', info: 0x12, shndx: 7, value: 0, size: 16, version: 1 }
  ]
  const dynsymOff = w.pos
  w.zeros(symentsize)
  const symEntries = []
  for (const sym of dynsyms) {
    symEntries.push(w.pos)
    const nameIndex = dynstr.offsets.get(sym.name)
    if (is64) w.u32(nameIndex).u8(sym.info).u8(0).u16(sym.shndx).u64(0).u64(sym.size)
    else w.u32(nameIndex).u32(0).u32(sym.size).u8(sym.info).u8(0).u16(sym.shndx)
  }
  const dynsymSize = w.pos - dynsymOff

  const versymOff = w.pos
  w.u16(0)
  for (const sym of dynsyms) w.u16(sym.version)
  const versymSize = w.pos - versymOff
  w.align(8)

  const verneedOff = w.pos
  w.u16(1).u16(1).u32(dynstr.offsets.get('libc.so.6')).u32(16).u32(0)
  w.u32(0x09691a75).u16(0).u16(2).u32(dynstr.offsets.get('GLIBC_2.2.5')).u32(0)
  const verneedSize = w.pos - verneedOff

  w.align(16)
  const roEnd = w.pos
  const textOff = w.pos
  w.zeros(32)
  for (let i = 0; i < 16; i++) w.buf[textOff + 16 + i] = 0xc3 // exported_fn's bytes
  const textEnd = w.pos
  w.align(16)

  const dynamicOff = w.pos
  const dyn = (tag, value) => { w.addr(tag, is64).addr(value, is64) }
  dyn(1, dynstr.offsets.get('libc.so.6'))
  dyn(1, dynstr.offsets.get('libfoo.so.2'))
  if (kind === 'shared') dyn(14, dynstr.offsets.get('libsample.so.1'))
  dyn(29, dynstr.offsets.get('$ORIGIN/lib'))
  dyn(5, base + dynstrOff)
  dyn(10, dynstr.bytes.length)
  dyn(6, base + dynsymOff)
  if (relro === 'full') dyn(30, 0x8)
  if (kind === 'pie') dyn(0x6ffffffb, relro === 'full' ? 0x08000001 : 0x08000000)
  dyn(0, 0)
  const dynamicSize = w.pos - dynamicOff

  const shstr = stringTable(['.interp', '.note.gnu.build-id', '.dynstr', '.dynsym', '.gnu.version', '.gnu.version_r', '.text', '.dynamic', '.shstrtab'])
  const shstrOff = w.pos
  w.bytes(shstr.bytes).align(8)
  const shoff = w.pos
  const sections = [
    ['', 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ['.interp', 1, 2, interpOff, interp.length + 1, 0, 0, 1, 0],
    ['.note.gnu.build-id', 7, 2, noteOff, noteSize, 0, 0, 4, 0],
    ['.dynstr', 3, 2, dynstrOff, dynstr.bytes.length, 0, 0, 1, 0],
    ['.dynsym', 11, 2, dynsymOff, dynsymSize, 3, 1, 8, symentsize],
    ['.gnu.version', 0x6fffffff, 2, versymOff, versymSize, 4, 0, 2, 2],
    ['.gnu.version_r', 0x6ffffffe, 2, verneedOff, verneedSize, 3, 1, 8, 0],
    ['.text', 1, 6, textOff, textEnd - textOff, 0, 0, 16, 0],
    ['.dynamic', 6, 3, dynamicOff, dynamicSize, 3, 0, 8, 2 * A],
    ['.shstrtab', 3, 0, shstrOff, shstr.bytes.length, 0, 0, 1, 0]
  ]
  for (const [name, type, flags, offset, size, link, info, align, entsize] of sections) {
    const addr = flags & 2 ? base + offset : 0
    w.u32(name ? shstr.offsets.get(name) : 0).u32(type || 0)
    w.addr(flags || 0, is64).addr(addr, is64).addr(offset || 0, is64).addr(size || 0, is64)
    w.u32(link || 0).u32(info || 0).addr(align || 0, is64).addr(entsize || 0, is64)
  }
  const fileEnd = w.pos

  // exported_fn lives 16 bytes into .text
  for (const at of [symEntries[3]]) w.setAddr(at + (is64 ? 8 : 4), base + textOff + 16, is64)

  const segment = (at, type, flags, offset, size) => {
    if (is64) {
      w.set32(at, type); w.set32(at + 4, flags)
      w.setAddr(at + 8, offset, true); w.setAddr(at + 16, base + offset, true); w.setAddr(at + 24, base + offset, true)
      w.setAddr(at + 32, size, true); w.setAddr(at + 40, size, true); w.setAddr(at + 48, 8, true)
    } else {
      w.set32(at, type); w.set32(at + 4, offset); w.set32(at + 8, base + offset); w.set32(at + 12, base + offset)
      w.set32(at + 16, size); w.set32(at + 20, size); w.set32(at + 24, flags); w.set32(at + 28, 4)
    }
  }
  phdrs.forEach((p, i) => {
    const at = phoff + i * phentsize
    if (p.type === PT.PHDR) segment(at, p.type, 4, phoff, phdrs.length * phentsize)
    else if (p.type === PT.INTERP) segment(at, p.type, 4, interpOff, interp.length + 1)
    else if (p.type === PT.NOTE) segment(at, p.type, 4, noteOff, noteSize)
    else if (p.id === 'ro') segment(at, p.type, 4, 0, roEnd)
    else if (p.id === 'rx') segment(at, p.type, 5, textOff, textEnd - textOff)
    else if (p.id === 'rw') segment(at, p.type, 6, dynamicOff, fileEnd - dynamicOff)
    else if (p.type === PT.DYNAMIC) segment(at, p.type, 6, dynamicOff, dynamicSize)
    else if (p.type === PT.GNU_STACK) { segment(at, p.type, execStack ? 7 : 6, 0, 0) }
    else if (p.type === PT.GNU_RELRO) segment(at, p.type, 4, dynamicOff, dynamicSize)
  })

  w.buf.set([0x7F, 0x45, 0x4C, 0x46, is64 ? 2 : 1, littleEndian ? 1 : 2, 1, 0], 0)
  w.set16(16, kind === 'exec' ? 2 : 3)
  w.set16(18, is64 ? 0x3E : 0x03)
  w.set32(20, 1)
  w.setAddr(24, base + textOff, is64)
  w.setAddr(is64 ? 32 : 28, phoff, is64)
  w.setAddr(is64 ? 40 : 32, noSectionHeaders ? 0 : shoff, is64)
  const h = is64 ? 52 : 40
  w.set16(h, ehsize)
  w.set16(h + 2, phentsize)
  w.set16(h + 4, phdrs.length)
  w.set16(h + 6, shentsize)
  w.set16(h + 8, noSectionHeaders ? 0 : sections.length)
  w.set16(h + 10, noSectionHeaders ? 0 : sections.length - 1)
  return w.toArrayBuffer()
}

// ---------------------------------------------------------------- full PE

/**
 * A PE image with the tables a first look needs: Rich header, imports by
 * name and ordinal, a delay-load import, a CodeView debug record, a CLR
 * header, overlay data and a certificate table.
 *
 * options:
 *   pe32Plus, dllCharacteristics, subsystem, characteristics
 *   rich, clr, delay, certificate: include those parts
 *   overlay: bytes of overlay data after the last section
 */
export function buildFullPE({
  pe32Plus = true,
  dllCharacteristics = 0x4160,
  subsystem = 3,
  characteristics = 0x22,
  rich = true,
  clr = true,
  delay = true,
  certificate = true,
  overlay = 64
} = {}) {
  const w = new Writer(true)
  const peOffset = 0x100
  w.ascii('MZ').zeros(0x3C - 2).u32(peOffset)
  w.zeros(0x40) // stub code
  if (rich) {
    const key = 0x12345678
    const masked = v => (v ^ key) >>> 0
    w.u32(masked(0x536E6144)).u32(key).u32(key).u32(key) // DanS + 3 zero dwords
    w.u32(masked((0x0105 << 16) | 30729)).u32(masked(7))
    w.u32(masked((0x0104 << 16) | 30729)).u32(masked(2))
    w.ascii('Rich').u32(key)
  }
  w.zeros(peOffset - w.pos)

  const rdata = { rva: 0x2000, raw: 0x600, size: 0x800 }
  const text = { rva: 0x1000, raw: 0x400, size: 0x200 }
  const optionalHeaderSize = pe32Plus ? 240 : 224
  w.ascii('PE').u16(0)
  w.u16(pe32Plus ? 0x8664 : 0x14c).u16(2).u32(0x5F5E1000).u32(0).u32(0).u16(optionalHeaderSize).u16(characteristics)
  const opt = w.pos
  w.zeros(optionalHeaderSize)
  for (const [name, s, flags] of [['.text', text, 0x60000020], ['.rdata', rdata, 0x40000040]]) {
    w.fixed(name, 8).u32(s.size).u32(s.rva).u32(s.size).u32(s.raw).zeros(12).u32(flags)
  }
  w.zeros(text.raw - w.pos)
  w.zeros(text.size)
  w.zeros(rdata.size)
  const rva = r => rdata.raw + (r - rdata.rva)

  // Optional header
  const P = pe32Plus ? 8 : 4
  w.set16(opt, pe32Plus ? 0x20B : 0x10B)
  w.buf[opt + 2] = 14
  w.buf[opt + 3] = 29
  w.set32(opt + 16, text.rva + 0x10) // AddressOfEntryPoint
  let at = opt + (pe32Plus ? 24 : 28)
  w.setAddr(at, 0x140000000 % (pe32Plus ? 2 ** 53 : 2 ** 32), pe32Plus)
  if (!pe32Plus) w.set32(at, 0x400000)
  at += P
  w.set32(at, 0x1000); w.set32(at + 4, 0x200)
  w.set16(at + 8, 6); w.set16(at + 16, 6)
  w.set32(at + 24, 0x3000) // SizeOfImage
  w.set32(at + 28, 0x400) // SizeOfHeaders
  w.set16(at + 36, subsystem)
  w.set16(at + 38, dllCharacteristics)
  const dirs = opt + (pe32Plus ? 112 : 96)
  w.set32(dirs - 4, 16)
  const setDir = (index, r, size) => { w.set32(dirs + index * 8, r); w.set32(dirs + index * 8 + 4, size) }

  // .rdata contents
  let cursor = rdata.rva
  const take = n => { const r = cursor; cursor += n; return r }
  const putString = (s) => { const r = take(s.length + 1); w.buf.set(Array.from(s, c => c.charCodeAt(0)), rva(r)); return r }
  const putHintName = (hint, name) => { const r = take(2 + name.length + 1 + ((name.length + 1) % 2)); w.set16(rva(r), hint); w.buf.set(Array.from(name, c => c.charCodeAt(0)), rva(r) + 2); return r }
  const thunk = (r, value) => (pe32Plus ? w.view.setBigUint64(rva(r), BigInt(value), true) : w.set32(rva(r), value))
  const ordinalFlag = pe32Plus ? 1n << 63n : 0x80000000

  const imports = [
    { dll: 'KERNEL32.dll', functions: ['CreateFileW', 'VirtualProtect', 'IsDebuggerPresent'] },
    { dll: 'WS2_32.dll', functions: [23, 'connect'] }
  ]
  const descriptors = take(20 * (imports.length + 1))
  imports.forEach((imp, i) => {
    const ilt = take(P * (imp.functions.length + 1))
    const iat = take(P * (imp.functions.length + 1))
    imp.functions.forEach((fn, j) => {
      const value = typeof fn === 'number' ? (pe32Plus ? ordinalFlag | BigInt(fn) : (ordinalFlag | fn) >>> 0) : putHintName(j, fn)
      thunk(ilt + j * P, value)
      thunk(iat + j * P, value)
    })
    const d = rva(descriptors + i * 20)
    w.set32(d, ilt)
    w.set32(d + 12, putString(imp.dll))
    w.set32(d + 16, iat)
  })
  setDir(1, descriptors, 20 * (imports.length + 1))

  if (delay) {
    const desc = take(64)
    const names = take(P * 2)
    thunk(names, putHintName(0, 'MessageBoxW'))
    const d = rva(desc)
    w.set32(d, 1)
    w.set32(d + 4, putString('USER32.dll'))
    w.set32(d + 16, names)
    setDir(13, desc, 64)
  }

  // Debug directory with an RSDS CodeView record
  const debugDir = take(28)
  const pdb = 'C:\\build\\sample.pdb'
  const cv = take(24 + pdb.length + 1)
  w.set32(rva(cv), 0x53445352)
  w.buf.set(Array.from(pdb, c => c.charCodeAt(0)), rva(cv) + 24)
  w.set32(rva(debugDir) + 12, 2)
  w.set32(rva(debugDir) + 16, 24 + pdb.length + 1)
  w.set32(rva(debugDir) + 20, cv)
  w.set32(rva(debugDir) + 24, rva(cv))
  setDir(6, debugDir, 28)

  if (clr) {
    cursor = (cursor + 3) & ~3
    const header = take(72)
    const metadata = take(32)
    w.set32(rva(header), 72)
    w.set16(rva(header) + 4, 2); w.set16(rva(header) + 6, 5)
    w.set32(rva(header) + 8, metadata); w.set32(rva(header) + 12, 32)
    w.set32(rva(header) + 16, 1)
    w.set32(rva(metadata), 0x424A5342)
    w.set32(rva(metadata) + 12, 12)
    w.buf.set(Array.from('v4.0.30319', c => c.charCodeAt(0)), rva(metadata) + 16)
    setDir(14, header, 72)
  }

  for (let i = 0; i < overlay; i++) w.u8(0x5A)
  if (certificate) {
    const start = w.pos
    w.u32(16).u16(0x200).u16(2).u32(0xDEADBEEF).u32(0xCAFEF00D)
    setDir(4, start, 16)
  }
  return w.toArrayBuffer()
}
