import { adler32, u16be, u16le, u32be, u32le, u64be, u64le, latin1 } from '../bytes.js'
import { Reader } from '../source.js'
import { found, plural } from './common.js'

const PE_MACHINES = { 0x14C: 'x86', 0x8664: 'x86-64', 0x1C0: 'ARM', 0x1C4: 'ARM Thumb-2', 0xAA64: 'ARM64', 0x200: 'Itanium', 0xEBC: 'EFI byte code' }

/**
 * PE: "MZ" is two bytes, so a candidate counts only if e_lfanew leads to
 * "PE\0\0" and a sane optional header. Plain MS-DOS executables (no PE
 * header) are not reported: their header has nothing that random data
 * would fail. The extent is the end of the last section's raw data, or of
 * the certificate table when it follows.
 */
export async function pe(ctx) {
  const { src, start } = ctx
  const dos = await src.read(start, 64)
  if (dos.length < 64) return null
  const lfanew = u32le(dos, 0x3C)
  if (lfanew < 0x40 || lfanew > 0x10000) return null
  const h = await src.read(start + lfanew, 24 + 240)
  if (h.length < 24 + 96 || u32le(h, 0) !== 0x00004550) return null
  const machine = u16le(h, 4)
  const sections = u16le(h, 6)
  const optSize = u16le(h, 20)
  const characteristics = u16le(h, 22)
  if (sections === 0 || sections > 96 || optSize < 96) return null
  const magic = u16le(h, 24)
  if (magic !== 0x10B && magic !== 0x20B) return null
  const plus = magic === 0x20B
  const opt = 24
  const headersSize = u32le(h, opt + 60)
  const dirCountAt = opt + (plus ? 108 : 92)
  const dirs = dirCountAt + 4
  let certEnd = 0
  if (h.length >= dirs + 5 * 8 && u32le(h, dirCountAt) > 4) {
    const certOffset = u32le(h, dirs + 4 * 8)
    const certSize = u32le(h, dirs + 4 * 8 + 4)
    if (certOffset && certSize) certEnd = certOffset + certSize
  }
  const table = await src.read(start + lfanew + 24 + optSize, sections * 40)
  if (table.length < sections * 40) return null
  let end = Math.max(headersSize, lfanew + 24 + optSize + sections * 40)
  for (let k = 0; k < sections; k++) {
    const rawSize = u32le(table, k * 40 + 16)
    const rawPtr = u32le(table, k * 40 + 20)
    if (rawSize && rawPtr) end = Math.max(end, rawPtr + rawSize)
  }
  let endedBy = 'its last section'
  const symbols = u32le(h, 16)
  const symbolTable = u32le(h, 12)
  if (symbolTable && symbols && symbols < (1 << 22)) {
    const strings = symbolTable + symbols * 18
    const t = await src.read(start + strings, 4)
    const stringsEnd = t.length === 4 && u32le(t, 0) >= 4 && u32le(t, 0) < (64 << 20) ? strings + u32le(t, 0) : 0
    if (stringsEnd > end) {
      end = stringsEnd
      endedBy = 'its COFF symbol table'
    }
  }
  if (end > 0x80000000) return null
  if (certEnd >= end && certEnd - end < (64 << 20)) {
    end = certEnd
    endedBy = 'its certificate table'
  }
  const dll = characteristics & 0x2000
  return found(ctx, {
    type: 'pe', ext: dll ? 'dll' : 'exe', module: 'pe',
    name: dll ? 'Windows DLL' : 'Windows PE executable',
    confidence: 'high', end: start + end,
    note: `${plus ? 'PE32+' : 'PE32'} ${PE_MACHINES[machine] || `machine 0x${machine.toString(16)}`}, ${plural(sections, 'section')}; ends after ${endedBy}`
  })
}

const CPU = { 7: 'x86', 0x01000007: 'x86-64', 12: 'ARM', 0x0100000C: 'ARM64', 0x0200000C: 'ARM64_32', 18: 'PowerPC', 0x01000012: 'PowerPC 64' }

/** 0xCAFEBABE starts both Java class files and Mach-O universal binaries; a small architecture count means the latter. */
export async function cafebabe(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 8)
  if (h.length < 8) return null
  const n = u32be(h, 4)
  if (n >= 1 && n <= 30) return fatMacho(ctx, n)
  return javaClass(ctx)
}

async function fatMacho(ctx, n) {
  const { src, start } = ctx
  const t = await src.read(start + 8, n * 20)
  if (t.length < n * 20) return null
  let end = 8 + n * 20
  const arches = []
  for (let k = 0; k < n; k++) {
    const cpu = u32be(t, k * 20)
    const offset = u32be(t, k * 20 + 8)
    const size = u32be(t, k * 20 + 12)
    const align = u32be(t, k * 20 + 16)
    if (offset < 8 + n * 20 || size === 0 || align > 16) return null
    const m = await src.read(start + offset, 4)
    if (m.length < 4) return null
    const magic = u32be(m, 0)
    if (![0xFEEDFACE, 0xFEEDFACF, 0xCEFAEDFE, 0xCFFAEDFE].includes(magic)) return null
    arches.push(CPU[cpu] || `cpu ${cpu}`)
    end = Math.max(end, offset + size)
  }
  return found(ctx, {
    type: 'macho', ext: 'macho', module: 'macho', name: 'Mach-O universal binary',
    confidence: 'high', end: start + end,
    note: `${arches.join(', ')}; each slice starts with a Mach-O header`
  })
}

/** Java class: walks the constant pool, members and attributes to the exact end. */
async function javaClass(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 10)
  if (h.length < 10) return null
  const major = u16be(h, 6)
  if (major < 45 || major > 80) return null
  const r = new Reader(src)
  let pos = start + 8
  const u16 = async () => {
    if (!(await r.need(pos, 2))) throw new Error('truncated')
    const v = u16be(r.buf, pos - r.base)
    pos += 2
    return v
  }
  const u32 = async () => {
    if (!(await r.need(pos, 4))) throw new Error('truncated')
    const v = u32be(r.buf, pos - r.base)
    pos += 4
    return v
  }
  try {
    const cpCount = await u16()
    if (cpCount < 2) return null
    for (let k = 1; k < cpCount; k++) {
      if (!(await r.need(pos, 1))) return null
      const tag = r.u8(pos)
      pos++
      if (tag === 1) {
        const n = await u16()
        pos += n
      }
      else if (tag === 3 || tag === 4 || tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) pos += 4
      else if (tag === 5 || tag === 6) {
        pos += 8
        k++
      } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) pos += 2
      else if (tag === 15) pos += 3
      else return null
      if (ctx.expired()) return null
    }
    pos += 6
    const interfaces = await u16()
    pos += interfaces * 2
    const skipAttributes = async () => {
      const n = await u16()
      for (let a = 0; a < n; a++) {
        pos += 2
        const n = await u32()
        pos += n
      }
    }
    for (let group = 0; group < 2; group++) {
      const members = await u16()
      for (let m = 0; m < members; m++) {
        pos += 6
        await skipAttributes()
      }
    }
    await skipAttributes()
  } catch {
    return null
  }
  if (pos > ctx.size) return null
  return found(ctx, {
    type: 'java-class', ext: 'class', module: 'java-class', name: 'Java class file',
    confidence: 'high', end: pos,
    note: `class file version ${major}; constant pool and members walked to the end`
  })
}

/** Thin Mach-O: known CPU type and file type, load commands that add up, extent from segments. */
export async function macho(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 32)
  if (h.length < 28) return null
  const magic = u32be(h, 0)
  const le = magic === 0xCEFAEDFE || magic === 0xCFFAEDFE
  const is64 = magic === 0xFEEDFACF || magic === 0xCFFAEDFE
  const u32 = le ? u32le : u32be
  const u64 = le ? u64le : u64be
  const cpu = u32(h, 4)
  const filetype = u32(h, 12)
  const ncmds = u32(h, 16)
  const sizeofcmds = u32(h, 20)
  const headerSize = is64 ? 32 : 28
  if (!(cpu in CPU) || filetype < 1 || filetype > 12 || ncmds < 1 || ncmds > 4096 || sizeofcmds < ncmds * 8 || sizeofcmds > (1 << 20)) return null
  const cmds = await src.read(start + headerSize, sizeofcmds)
  if (cmds.length < sizeofcmds) return null
  let end = headerSize + sizeofcmds
  let p = 0
  let segments = 0
  for (let k = 0; k < ncmds; k++) {
    if (p + 8 > sizeofcmds) return null
    const cmd = u32(cmds, p) & 0x7FFFFFFF
    const size = u32(cmds, p + 4)
    if (size < 8 || p + size > sizeofcmds) return null
    if (cmd === 0x1 && size >= 48) {
      end = Math.max(end, u32(cmds, p + 32) + u32(cmds, p + 36))
      segments++
    } else if (cmd === 0x19 && size >= 72) {
      end = Math.max(end, u64(cmds, p + 40) + u64(cmds, p + 48))
      segments++
    } else if (cmd === 0x2 && size >= 24) {
      end = Math.max(end, u32(cmds, p + 8) + u32(cmds, p + 12) * (is64 ? 16 : 12), u32(cmds, p + 16) + u32(cmds, p + 20))
    } else if (cmd === 0x1D && size >= 16) {
      end = Math.max(end, u32(cmds, p + 8) + u32(cmds, p + 12))
    }
    p += size
  }
  if (p !== sizeofcmds || end > 0x100000000) return null
  const types = { 1: 'object', 2: 'executable', 6: 'dynamic library', 8: 'bundle', 7: 'dynamic linker', 11: 'kext' }
  return found(ctx, {
    type: 'macho', ext: 'macho', module: 'macho', name: 'Mach-O binary',
    confidence: 'high', end: start + end,
    note: `${CPU[cpu]} ${types[filetype] || `file type ${filetype}`}, ${plural(ncmds, 'load command')}, ${plural(segments, 'segment')}`
  })
}

const ELF_MACHINES = { 3: 'x86', 8: 'MIPS', 20: 'PowerPC', 21: 'PowerPC 64', 40: 'ARM', 62: 'x86-64', 183: 'AArch64', 243: 'RISC-V', 2: 'SPARC', 43: 'SPARC V9', 22: 's390', 247: 'BPF' }
const ELF_TYPES = { 1: 'relocatable', 2: 'executable', 3: 'shared object', 4: 'core dump' }

/** ELF: identification bytes, header sizes, then the furthest program or section data. */
export async function elf(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 64)
  if (h.length < 52) return null
  const cls = h[4]
  const data = h[5]
  if ((cls !== 1 && cls !== 2) || (data !== 1 && data !== 2) || h[6] !== 1) return null
  const is64 = cls === 2
  if (is64 && h.length < 64) return null
  const le = data === 1
  const u16 = le ? u16le : u16be
  const u32 = le ? u32le : u32be
  const u64 = le ? u64le : u64be
  const word = is64 ? u64 : u32
  const type = u16(h, 16)
  const machine = u16(h, 18)
  if (u32(h, 20) !== 1 || !(type >= 1 && type <= 4) || machine === 0) return null
  const phoff = word(h, is64 ? 32 : 28)
  const shoff = word(h, is64 ? 40 : 32)
  const ehsize = u16(h, is64 ? 52 : 40)
  const phentsize = u16(h, is64 ? 54 : 42)
  const phnum = u16(h, is64 ? 56 : 44)
  const shentsize = u16(h, is64 ? 58 : 46)
  const shnum = u16(h, is64 ? 60 : 48)
  if (ehsize !== (is64 ? 64 : 52)) return null
  if (phnum && phentsize !== (is64 ? 56 : 32)) return null
  if (shnum && shentsize !== (is64 ? 64 : 40)) return null
  if (!phnum && !shnum) return null
  let end = ehsize
  let interp = false
  if (phnum) {
    end = Math.max(end, phoff + phnum * phentsize)
    const ph = await src.read(start + phoff, phnum * phentsize)
    if (ph.length === phnum * phentsize) {
      for (let k = 0; k < phnum; k++) {
        const e = k * phentsize
        const offset = is64 ? u64(ph, e + 8) : u32(ph, e + 4)
        const filesz = is64 ? u64(ph, e + 32) : u32(ph, e + 16)
        if (u32(ph, e) === 3) interp = true
        if (filesz) end = Math.max(end, offset + filesz)
      }
    }
  }
  if (shnum) {
    end = Math.max(end, shoff + shnum * shentsize)
    const sh = await src.read(start + shoff, shnum * shentsize)
    if (sh.length === shnum * shentsize) {
      for (let k = 0; k < shnum; k++) {
        const e = k * shentsize
        const shType = u32(sh, e + 4)
        const offset = is64 ? u64(sh, e + 24) : u32(sh, e + 16)
        const size = is64 ? u64(sh, e + 32) : u32(sh, e + 20)
        if (shType !== 8 && shType !== 0 && size) end = Math.max(end, offset + size)
      }
    }
  }
  if (!Number.isSafeInteger(end) || end > 2 ** 40) return null
  return found(ctx, {
    type: 'elf', ext: type === 3 && !interp ? 'so' : type === 1 ? 'o' : 'elf', module: 'elf',
    name: type === 3 && interp ? 'ELF executable (PIE)' : 'ELF ' + (ELF_TYPES[type] || 'file'),
    confidence: 'high', end: start + end,
    note: `${is64 ? '64' : '32'}-bit ${le ? 'LSB' : 'MSB'} ${ELF_MACHINES[machine] || `machine ${machine}`}, ${plural(phnum, 'segment')}, ${plural(shnum, 'section')}`
  })
}

function leb(buf, i) {
  let value = 0
  let shift = 0
  for (let k = 0; k < 5; k++) {
    if (i + k >= buf.length) return null
    const b = buf[i + k]
    value += (b & 0x7F) * 2 ** shift
    shift += 7
    if (!(b & 0x80)) return { value, length: k + 1 }
  }
  return null
}

/** WebAssembly: version 1, then sections with known ids whose sizes chain. The module has no terminator, so its end is where the chain stops. */
export async function wasm(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 8)
  if (h.length < 8 || u32le(h, 4) !== 1) return null
  const r = new Reader(src)
  let pos = start + 8
  let sections = 0
  let lastId = 0
  for (;;) {
    if (ctx.expired() || !(await r.need(pos, 6)) && !r.has(pos, 2)) break
    const i = pos - r.base
    const id = r.buf[i]
    if (id > 13) break
    const size = leb(r.buf, i + 1)
    if (!size || pos + 1 + size.length + size.value > ctx.size) break
    if (id !== 0 && id !== 12 && id !== 13 && id < lastId) break
    if (id !== 0 && id !== 12 && id !== 13) lastId = id
    pos += 1 + size.length + size.value
    sections++
  }
  if (!sections) return null
  return found(ctx, {
    type: 'wasm', ext: 'wasm', module: 'wasm', name: 'WebAssembly module',
    confidence: sections >= 2 ? 'high' : 'medium', end: pos, endKind: 'estimated',
    note: `${plural(sections, 'section')}; the end is where the section chain stops`
  })
}

/** DEX: header size, endian tag and file size; the Adler-32 checksum is verified for files up to 64 MB. */
export async function dex(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 0x70)
  if (h.length < 0x70) return null
  const version = latin1(h, 4, 3)
  if (!/^0\d\d$/.test(version) || h[7] !== 0) return null
  const fileSize = u32le(h, 32)
  if (u32le(h, 36) !== 0x70 || u32le(h, 40) !== 0x12345678 || fileSize < 0x70) return null
  let verified = false
  if (fileSize <= (64 << 20) && start + fileSize <= ctx.size) {
    const all = await src.read(start, fileSize)
    verified = adler32(all, 12, fileSize) === u32le(h, 8)
  }
  return found(ctx, {
    type: 'dex', ext: 'dex', name: 'Android DEX',
    confidence: verified ? 'high' : 'medium', end: start + fileSize,
    note: `version ${version}${verified ? ', checksum matches' : ''}`
  })
}
