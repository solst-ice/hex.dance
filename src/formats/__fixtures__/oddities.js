// Executables with controlled headers, for the pointer targets, memory
// layouts and unusual notes. The defaults are ordinary files; each option
// changes one thing a compiler would not.

const SECTION_HEADER = 40

/**
 * A 32-bit or 64-bit PE image.
 *
 * options:
 *   sections: [{ name, vsize, va, rawSize, raw, flags }]; default .text, .rdata, .data. A name
 *     may be given as bytes
 *   entry: AddressOfEntryPoint (default the start of the first section)
 *   peOffset, timestamp, optionalHeaderSize, rvaCount, fileAlignment, sectionAlignment, subsystem
 *   pe32Plus: 64-bit (PE32+) optional header
 *   imageBase: ImageBase (default 0x400000)
 *   imports: write an import directory (one DLL, one function) in the last section
 *   tlsCallbacks: RVAs of TLS callbacks; writes a TLS directory in the last section
 *   symbolTable: PointerToSymbolTable
 *   repro: add a debug directory with a Repro entry
 *   textPrefix: bytes written at the start of the first section's data
 */
export function buildCustomPE({
  sections = [
    { name: '.text', vsize: 0x180, va: 0x1000, rawSize: 0x200, raw: 0x400, flags: 0x60000020 },
    { name: '.rdata', vsize: 0x120, va: 0x2000, rawSize: 0x200, raw: 0x600, flags: 0x40000040 },
    { name: '.data', vsize: 0x300, va: 0x3000, rawSize: 0x200, raw: 0x800, flags: 0xC0000040 }
  ],
  entry,
  peOffset = 0x80,
  timestamp = 0x60000000,
  pe32Plus = false,
  optionalHeaderSize,
  rvaCount = 16,
  fileAlignment = 0x200,
  sectionAlignment = 0x1000,
  subsystem = 3,
  imageBase = 0x400000,
  imports = false,
  tlsCallbacks = null,
  symbolTable = 0,
  repro = false,
  textPrefix = null
} = {}) {
  const ohSize = optionalHeaderSize ?? (pe32Plus ? 0xF0 : 0xE0)
  const tableAt = peOffset + 24 + ohSize
  const headersEnd = tableAt + sections.length * SECTION_HEADER
  const end = Math.max(headersEnd, ...sections.map(s => (s.rawSize ? s.raw + s.rawSize : 0)), symbolTable ? symbolTable + 18 : 0)
  const bytes = new Uint8Array(end)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x4D
  bytes[1] = 0x5A
  view.setUint32(0x3C, peOffset, true)
  view.setUint32(peOffset, 0x00004550, true)
  const coff = peOffset + 4
  view.setUint16(coff, pe32Plus ? 0x8664 : 0x14C, true)
  view.setUint16(coff + 2, sections.length, true)
  view.setUint32(coff + 4, timestamp, true)
  view.setUint32(coff + 8, symbolTable, true)
  view.setUint32(coff + 12, symbolTable ? 1 : 0, true)
  view.setUint16(coff + 16, ohSize, true)
  view.setUint16(coff + 18, 0x0102, true)
  const opt = coff + 20
  view.setUint16(opt, pe32Plus ? 0x20B : 0x10B, true)
  view.setUint8(opt + 2, 14)
  view.setUint32(opt + 16, entry ?? (sections[0] ? sections[0].va : 0), true)
  view.setUint32(opt + 20, sections[0] ? sections[0].va : 0, true)
  if (pe32Plus) view.setBigUint64(opt + 24, BigInt(imageBase), true)
  else view.setUint32(opt + 28, imageBase, true)
  view.setUint32(opt + 32, sectionAlignment, true)
  view.setUint32(opt + 36, fileAlignment, true)
  view.setUint16(opt + 40, 6, true)
  view.setUint16(opt + 48, 6, true)
  const last = sections[sections.length - 1]
  view.setUint32(opt + 56, last ? last.va + 0x1000 : 0x1000, true)
  view.setUint32(opt + 60, 0x400, true)
  view.setUint16(opt + 68, subsystem, true)
  const rvaCountAt = opt + (pe32Plus ? 108 : 92)
  if (rvaCountAt + 4 <= tableAt) view.setUint32(rvaCountAt, rvaCount, true)
  const directory = (index, rva, size) => {
    const at = rvaCountAt + 4 + index * 8
    if (at + 8 <= tableAt) {
      view.setUint32(at, rva, true)
      view.setUint32(at + 4, size, true)
    }
  }
  sections.forEach((s, i) => {
    const at = tableAt + i * SECTION_HEADER
    // A name is a string of single-byte characters, or the raw bytes (UTF-8, say)
    const raw = typeof s.name === 'string' ? Array.from(s.name, c => c.charCodeAt(0)) : Array.from(s.name)
    bytes.set(raw.slice(0, 8), at)
    view.setUint32(at + 8, s.vsize, true)
    view.setUint32(at + 12, s.va, true)
    view.setUint32(at + 16, s.rawSize, true)
    view.setUint32(at + 20, s.raw, true)
    view.setUint32(at + 36, s.flags >>> 0, true)
  })
  if (textPrefix && sections[0]) bytes.set(textPrefix, sections[0].raw)

  // Tables live in the last section; its RVA maps straight to its raw offset
  let cursor = 0
  const take = n => {
    const rva = last.va + cursor
    cursor += n
    return { rva, at: last.raw + (rva - last.va) }
  }
  const pointer = pe32Plus ? 8 : 4
  const setPointer = (at, value) => (pe32Plus ? view.setBigUint64(at, BigInt(value), true) : view.setUint32(at, value, true))
  if (imports) {
    const descriptors = take(40)
    const lookup = take(pointer * 2)
    const iat = take(pointer * 2)
    const hint = take(16)
    const dll = take(16)
    view.setUint32(descriptors.at, lookup.rva, true)
    view.setUint32(descriptors.at + 12, dll.rva, true)
    view.setUint32(descriptors.at + 16, iat.rva, true)
    setPointer(lookup.at, hint.rva)
    setPointer(iat.at, hint.rva)
    bytes.set(Array.from('ExitProcess', c => c.charCodeAt(0)), hint.at + 2)
    bytes.set(Array.from('KERNEL32.dll', c => c.charCodeAt(0)), dll.at)
    directory(1, descriptors.rva, 40)
  }
  if (tlsCallbacks) {
    const tls = take(pe32Plus ? 40 : 24)
    const index = take(4)
    const list = take(pointer * (tlsCallbacks.length + 1))
    setPointer(tls.at + pointer * 2, imageBase + index.rva)
    setPointer(tls.at + pointer * 3, imageBase + list.rva)
    tlsCallbacks.forEach((rva, i) => setPointer(list.at + i * pointer, imageBase + rva))
    directory(9, tls.rva, pe32Plus ? 40 : 24)
  }
  if (repro) {
    const debug = take(28)
    view.setUint32(debug.at + 12, 16, true)
    directory(6, debug.rva, 28)
  }
  return bytes
}

/**
 * Shaped like corkami's 96workingsections.exe: `count` unnamed sections of
 * 0x200 bytes, all writable and executable (0xA0000000), the PE header right
 * after the DOS header, a zero timestamp and the entry point in the last section.
 */
export function buildManySectionsPE({ count = 96, flags = 0xA0000000, named = false } = {}) {
  const sections = []
  for (let i = 0; i < count; i++) {
    sections.push({ name: named ? `.s${i}` : '', vsize: 0x200, va: 0x2000 + i * 0x1000, rawSize: 0x200, raw: 0x1200 + i * 0x200, flags })
  }
  return buildCustomPE({ sections, peOffset: 0x40, timestamp: 0, entry: sections[count - 1].va, imports: true })
}

/**
 * A 64-bit Mach-O executable with the given segments and an LC_MAIN.
 * segments: [{ name, vmaddr, vmsize, fileoff, filesize, initprot, sections: [{ name, offset, size, addr }] }]
 */
export function buildSegmentedMachO({
  segments = [
    { name: '__PAGEZERO', vmaddr: 0, vmsize: 0x100000000, fileoff: 0, filesize: 0, initprot: 0, sections: [] },
    { name: '__TEXT', vmaddr: 0x100000000, vmsize: 0x4000, fileoff: 0, filesize: 0x4000, initprot: 5, sections: [{ name: '__text', offset: 0x3F00, size: 0x80, addr: 0x100003F00 }] },
    { name: '__DATA', vmaddr: 0x100004000, vmsize: 0x4000, fileoff: 0x4000, filesize: 0x1000, initprot: 3, sections: [{ name: '__data', offset: 0x4000, size: 0x40, addr: 0x100004000 }] },
    { name: '__LINKEDIT', vmaddr: 0x100008000, vmsize: 0x4000, fileoff: 0x5000, filesize: 0x100, initprot: 1, sections: [] }
  ],
  entryoff = 0x3F00,
  symtab = { symoff: 0x5000, nsyms: 0, stroff: 0x5080, strsize: 8 }
} = {}) {
  const size = Math.max(0x5100, ...segments.map(s => s.fileoff + s.filesize))
  const bytes = new Uint8Array(size)
  const view = new DataView(bytes.buffer)
  const name = (at, text) => { for (let c = 0; c < Math.min(16, text.length); c++) bytes[at + c] = text.charCodeAt(c) }
  view.setUint32(0, 0xfeedfacf, true)
  view.setUint32(4, 0x0100000c, true)
  view.setUint32(12, 2, true)
  view.setUint32(24, 0x200085, true)
  let at = 32
  let ncmds = 0
  for (const s of segments) {
    const start = at
    view.setUint32(at, 0x19, true)
    name(at + 8, s.name)
    view.setBigUint64(at + 24, BigInt(s.vmaddr), true)
    view.setBigUint64(at + 32, BigInt(s.vmsize), true)
    view.setBigUint64(at + 40, BigInt(s.fileoff), true)
    view.setBigUint64(at + 48, BigInt(s.filesize), true)
    view.setUint32(at + 56, 7, true)
    view.setUint32(at + 60, s.initprot, true)
    view.setUint32(at + 64, s.sections.length, true)
    at += 72
    for (const section of s.sections) {
      name(at, section.name)
      name(at + 16, s.name)
      view.setBigUint64(at + 32, BigInt(section.addr), true)
      view.setBigUint64(at + 40, BigInt(section.size), true)
      view.setUint32(at + 48, section.offset, true)
      at += 80
    }
    view.setUint32(start + 4, at - start, true)
    ncmds++
  }
  if (entryoff !== null) {
    view.setUint32(at, 0x80000028, true)
    view.setUint32(at + 4, 24, true)
    view.setBigUint64(at + 8, BigInt(entryoff), true)
    at += 24
    ncmds++
  }
  if (symtab) {
    view.setUint32(at, 2, true)
    view.setUint32(at + 4, 24, true)
    view.setUint32(at + 8, symtab.symoff, true)
    view.setUint32(at + 12, symtab.nsyms, true)
    view.setUint32(at + 16, symtab.stroff, true)
    view.setUint32(at + 20, symtab.strsize, true)
    at += 24
    ncmds++
  }
  view.setUint32(16, ncmds, true)
  view.setUint32(20, at - 32, true)
  return bytes
}

/** Reads the 64-bit little-endian ELF header fields the tests patch. */
export function elfHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    view,
    entry: Number(view.getBigUint64(24, true)),
    phoff: Number(view.getBigUint64(32, true)),
    shoff: Number(view.getBigUint64(40, true)),
    phentsize: view.getUint16(54, true),
    phnum: view.getUint16(56, true),
    shentsize: view.getUint16(58, true),
    shnum: view.getUint16(60, true),
    shstrndx: view.getUint16(62, true)
  }
}

/** The program headers of a 64-bit little-endian ELF: [{ at, type, flags, offset, vaddr, filesz }] */
export function elfSegments(bytes) {
  const h = elfHeader(bytes)
  const list = []
  for (let i = 0; i < h.phnum; i++) {
    const at = h.phoff + i * h.phentsize
    list.push({
      at,
      type: h.view.getUint32(at, true),
      flags: h.view.getUint32(at + 4, true),
      offset: Number(h.view.getBigUint64(at + 8, true)),
      vaddr: Number(h.view.getBigUint64(at + 16, true)),
      filesz: Number(h.view.getBigUint64(at + 32, true)),
      memsz: Number(h.view.getBigUint64(at + 40, true))
    })
  }
  return list
}
