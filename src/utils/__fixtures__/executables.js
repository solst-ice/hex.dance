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
 *   is64, cputype, cpusubtype, filetype
 *   segments: [{ segname, sections: [{ sectname, flags }] }]
 *   symbols: [{ name, type, sect, desc, value }]
 *   extraCommands: raw { cmd, cmdsize } pairs written before LC_SYMTAB
 *   ncmdsOverride: value stored in the header's ncmds
 */
export function buildMachO({
  is64 = true,
  cputype = CPU_TYPE_ARM64,
  cpusubtype = 0,
  filetype = 2,
  segments = MACHO_SAMPLE_SEGMENTS,
  symbols = MACHO_SAMPLE_SYMBOLS,
  extraCommands = [],
  ncmdsOverride
} = {}) {
  const w = new Writer(true)
  const headerSize = is64 ? 32 : 28
  w.u32(is64 ? 0xfeedfacf : 0xfeedface).u32(cputype).u32(cpusubtype).u32(filetype)
  const ncmdsAt = w.pos
  w.u32(0).u32(0).u32(0)
  if (is64) w.u32(0)

  let ncmds = 0
  for (const segment of segments) {
    const start = w.pos
    w.u32(is64 ? 0x19 : 0x1).u32(0).fixed(segment.segname, 16)
    w.addr(0, is64).addr(0, is64).addr(0, is64).addr(0, is64)
    w.u32(7).u32(5).u32(segment.sections.length).u32(0)
    for (const section of segment.sections) {
      w.fixed(section.sectname, 16).fixed(segment.segname, 16)
      w.addr(0, is64).addr(0, is64)
      w.u32(0).u32(0).u32(0).u32(0).u32(section.flags).u32(0).u32(0)
      if (is64) w.u32(0)
    }
    w.set32(start + 4, w.pos - start)
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
