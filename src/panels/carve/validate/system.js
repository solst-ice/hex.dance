import { crc32, fromLatin1, isPowerOfTwo, latin1, u16be, u16le, u32be, u32le, u64le } from '../bytes.js'
import { findForward } from '../source.js'
import { found, plural, sizeText } from './common.js'

/** SQLite: fixed payload fractions and a power-of-two page size; the size is page size × page count when the count is marked valid. */
export async function sqlite(ctx) {
  const h = await ctx.src.read(ctx.start, 100)
  if (h.length < 100) return null
  const raw = u16be(h, 16)
  const pageSize = raw === 1 ? 65536 : raw
  if (!isPowerOfTwo(pageSize) || pageSize < 512 || h[18] < 1 || h[18] > 2 || h[19] < 1 || h[19] > 2 || h[21] !== 64 || h[22] !== 32 || h[23] !== 32) return null
  const pages = u32be(h, 28)
  const countValid = pages > 0 && u32be(h, 24) === u32be(h, 92)
  return found(ctx, {
    type: 'sqlite', ext: 'sqlite', module: 'sqlite', name: 'SQLite database',
    confidence: 'high', end: countValid ? ctx.start + pages * pageSize : null,
    note: countValid ? `${plural(pages, 'page')} of ${pageSize} bytes` : `page size ${pageSize}; the page count in the header is stale, so the end is unknown`
  })
}

/** ISO 9660: the primary volume descriptor at 32 KB stores its size twice, little- and big-endian. */
export async function iso9660(ctx) {
  const d = await ctx.src.read(ctx.start + 0x8000, 2048)
  if (d.length < 2048) return null
  const blocks = u32le(d, 80)
  const blockSize = u16le(d, 128)
  if (blocks !== u32be(d, 84) || blockSize !== u16be(d, 130) || ![512, 1024, 2048].includes(blockSize) || blocks < 16) return null
  const label = latin1(d, 40, 32).trim()
  return found(ctx, {
    type: 'iso9660', ext: 'iso', module: 'iso9660', name: 'ISO 9660 disc image',
    confidence: 'high', end: ctx.start + blocks * blockSize,
    note: `${label ? `volume "${label}", ` : ''}${plural(blocks, 'block')} of ${blockSize} bytes (both byte orders agree)`
  })
}

/**
 * 0x55AA at 510 is two bytes, so a boot sector counts only as NTFS, exFAT
 * or FAT with a sane BIOS parameter block, or as an MBR with at least one
 * well-formed partition entry.
 */
export async function bootsector(ctx) {
  const { src, start } = ctx
  const b = await src.read(start, 512)
  if (b.length < 512) return null
  const oem = latin1(b, 3, 8)
  if (oem === 'NTFS    ') {
    const bps = u16le(b, 11)
    const total = u64le(b, 0x28)
    if (!isPowerOfTwo(bps) || bps < 256 || bps > 4096 || !total) return null
    return found(ctx, { type: 'ntfs', ext: 'img', name: 'NTFS volume', confidence: 'high', end: start + (total + 1) * bps, note: `${sizeText((total + 1) * bps)} from the boot sector` })
  }
  if (oem === 'EXFAT   ') {
    const shift = b[108]
    const total = u64le(b, 72)
    if (shift < 9 || shift > 12 || !total) return null
    return found(ctx, { type: 'exfat', ext: 'img', name: 'exFAT volume', confidence: 'high', end: start + total * 2 ** shift, note: `${sizeText(total * 2 ** shift)} from the boot sector` })
  }
  const jump = (b[0] === 0xEB && b[2] === 0x90) || b[0] === 0xE9
  if (jump) {
    const bps = u16le(b, 11)
    const spc = b[13]
    const reserved = u16le(b, 14)
    const fats = b[16]
    const media = b[21]
    const total = u16le(b, 19) || u32le(b, 32)
    const fat32 = u16le(b, 22) === 0
    if ([512, 1024, 2048, 4096].includes(bps) && isPowerOfTwo(spc) && spc <= 128 && reserved >= 1 && (fats === 1 || fats === 2) && (media === 0xF0 || media >= 0xF8) && total > 0) {
      const label = latin1(b, fat32 ? 82 : 54, 8).trim()
      return found(ctx, {
        type: 'fat', ext: 'img', name: `${/^FAT(12|16|32)$/.test(label) ? label : fat32 ? 'FAT32' : 'FAT'} volume`,
        confidence: 'high', end: start + total * bps, note: `${plural(total, 'sector')} of ${bps} bytes; BIOS parameter block is consistent`
      })
    }
  }
  const parts = []
  for (let k = 0; k < 4; k++) {
    const e = 446 + k * 16
    const status = b[e]
    const type = b[e + 4]
    const lba = u32le(b, e + 8)
    const count = u32le(b, e + 12)
    if (status !== 0 && status !== 0x80) return null
    if (type === 0) {
      if (lba || count) return null
      continue
    }
    if (!lba || !count) return null
    parts.push({ lba, count, type })
  }
  if (!parts.length) return null
  parts.sort((a, b) => a.lba - b.lba)
  for (let k = 1; k < parts.length; k++) if (parts[k].lba < parts[k - 1].lba + parts[k - 1].count) return null
  const gpt = parts.some(p => p.type === 0xEE)
  let confidence = 'medium'
  if (gpt) {
    const g = await src.read(start + 512, 8)
    if (latin1(g, 0, 8) === 'EFI PART') confidence = 'high'
  }
  const end = Math.max(...parts.map(p => p.lba + p.count)) * 512
  return found(ctx, {
    type: 'mbr', ext: 'img', module: 'partition', name: gpt ? 'GPT disk image' : 'MBR disk image',
    confidence, end: start + end,
    note: `${plural(parts.length, 'partition')} that do not overlap; size from the last one's end`
  })
}

/** ext2/3/4: superblock at 1 KB with block size, group size and state fields that must agree. */
export async function ext(ctx) {
  const s = await ctx.src.read(ctx.start + 1024, 1024)
  if (s.length < 1024) return null
  const inodes = u32le(s, 0)
  const blocksLo = u32le(s, 4)
  const logBlock = u32le(s, 24)
  if (!inodes || !blocksLo || logBlock > 6 || u32le(s, 8) > blocksLo || u32le(s, 12) > blocksLo || u32le(s, 16) > inodes) return null
  const blockSize = 1024 << logBlock
  if (u32le(s, 20) !== (blockSize === 1024 ? 1 : 0) || u32le(s, 32) !== 8 * blockSize || !u32le(s, 40)) return null
  if (u16le(s, 58) > 7 || u16le(s, 60) < 1 || u16le(s, 60) > 3 || u32le(s, 76) > 1) return null
  const incompat = u32le(s, 96)
  const blocks = incompat & 0x80 ? blocksLo + u32le(s, 0x150) * 0x100000000 : blocksLo
  const kind = incompat & 0x2C0 ? 'ext4' : u32le(s, 92) & 4 ? 'ext3' : 'ext2'
  const label = latin1(s, 120, 16).replace(/\0.*$/s, '')
  return found(ctx, {
    type: 'ext', ext: 'img', name: `${kind} file system`, confidence: 'high', end: ctx.start + blocks * blockSize,
    note: `${label ? `"${label}", ` : ''}${plural(blocks, 'block')} of ${blockSize} bytes; superblock fields agree`
  })
}

/** SquashFS 4: block size matches its log, known compressor; bytes_used gives the size. */
export async function squashfs(ctx) {
  const h = await ctx.src.read(ctx.start, 96)
  if (h.length < 96) return null
  if (h[0] === 0x73) {
    const major = u16be(h, 28)
    if (major < 1 || major > 4) return null
    return found(ctx, { type: 'squashfs', ext: 'squashfs', name: 'SquashFS image (big-endian)', confidence: 'low', end: null, note: `version ${major}; this layout is not decoded` })
  }
  const blockSize = u32le(h, 12)
  const compression = u16le(h, 20)
  if (u16le(h, 28) !== 4 || u16le(h, 30) !== 0 || !isPowerOfTwo(blockSize) || blockSize < 4096 || blockSize > (1 << 20) || 2 ** u16le(h, 22) !== blockSize || compression < 1 || compression > 6) return null
  const used = u64le(h, 40)
  const names = ['', 'gzip', 'lzma', 'lzo', 'xz', 'lz4', 'zstd']
  return found(ctx, {
    type: 'squashfs', ext: 'squashfs', name: 'SquashFS image', confidence: 'high', end: ctx.start + used,
    note: `${names[compression]}, ${plural(u32le(h, 4), 'inode')}, ${sizeText(blockSize)} blocks`
  })
}

/** cramfs: the "Compressed ROMFS" signature and the size field. */
export async function cramfs(ctx) {
  const h = await ctx.src.read(ctx.start, 48)
  if (h.length < 48 || latin1(h, 16, 16) !== 'Compressed ROMFS') return null
  return found(ctx, { type: 'cramfs', ext: 'cramfs', name: 'cramfs image', confidence: 'high', end: ctx.start + u32le(h, 4), note: `"${latin1(h, 48 - 16, 16).replace(/\0.*$/s, '')}"; size from its superblock` })
}

const UBOOT_OS = { 5: 'Linux', 17: 'U-Boot', 20: 'OpenRTOS' }
const UBOOT_TYPE = { 1: 'standalone', 2: 'kernel', 3: 'ramdisk', 4: 'multi-file', 5: 'firmware', 6: 'script', 7: 'filesystem', 8: 'flat device tree' }

/** U-Boot legacy image: header CRC-32; the data CRC-32 is checked for payloads up to 64 MB. */
export async function uimage(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 64)
  if (h.length < 64) return null
  const copy = h.slice()
  copy.fill(0, 4, 8)
  if (crc32(copy) !== u32be(h, 4)) return null
  const size = u32be(h, 12)
  let data = ''
  if (size <= (64 << 20) && start + 64 + size <= ctx.size) {
    const payload = await src.read(start + 64, size)
    data = crc32(payload) === u32be(h, 24) ? ', data CRC-32 matches' : ', data CRC-32 does not match'
  }
  const name = latin1(h, 32, 32).replace(/\0.*$/s, '')
  return found(ctx, {
    type: 'uimage', ext: 'uimg', name: 'U-Boot image', confidence: 'high', end: start + 64 + size,
    note: `${name ? `"${name}", ` : ''}${UBOOT_OS[h[28]] || 'OS ' + h[28]} ${UBOOT_TYPE[h[30]] || 'type ' + h[30]}; header CRC-32 matches${data}`
  })
}

/** Flattened device tree: version fields and block offsets inside totalsize. */
export async function dtb(ctx) {
  const h = await ctx.src.read(ctx.start, 40)
  if (h.length < 40) return null
  const total = u32be(h, 4)
  const version = u32be(h, 20)
  if (total < 40 || total > (64 << 20) || version < 1 || version > 17 || u32be(h, 24) > version) return null
  for (const at of [8, 12, 16]) if (u32be(h, at) >= total) return null
  return found(ctx, { type: 'dtb', ext: 'dtb', name: 'Device tree blob', confidence: 'high', end: ctx.start + total, note: `version ${version}; size from its header` })
}

const ceilPages = (n, page) => Math.ceil(n / page)

/** Android boot image: page size and component sizes give the image size. */
export async function androidboot(ctx) {
  const h = await ctx.src.read(ctx.start, 1660)
  if (h.length < 48) return null
  const version = u32le(h, 40)
  let pages
  let page
  if (version >= 3 && version <= 4) {
    page = 4096
    pages = 1 + ceilPages(u32le(h, 8), page) + ceilPages(u32le(h, 12), page)
    if (version === 4 && h.length >= 1584) pages += ceilPages(u32le(h, 1580), page)
  } else if (version <= 2) {
    page = u32le(h, 36)
    if (![2048, 4096, 8192, 16384].includes(page)) return null
    pages = 1 + ceilPages(u32le(h, 8), page) + ceilPages(u32le(h, 16), page) + ceilPages(u32le(h, 24), page)
    if (version >= 1 && h.length >= 1636) pages += ceilPages(u32le(h, 1632), page)
    if (version === 2 && h.length >= 1652) pages += ceilPages(u32le(h, 1648), page)
  } else {
    return null
  }
  return found(ctx, {
    type: 'androidboot', ext: 'img', name: 'Android boot image', confidence: 'medium', end: ctx.start + pages * page,
    note: `header version ${version}, ${plural(pages, 'page')} of ${page} bytes`
  })
}

/** OLE compound file (Office 97–2003, MSI, MSG): header fields, then the furthest sector in use per the FAT. */
export async function ole(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 512)
  if (h.length < 512) return null
  const major = u16le(h, 26)
  const shift = u16le(h, 30)
  if (u16le(h, 28) !== 0xFFFE || !((major === 3 && shift === 9) || (major === 4 && shift === 12)) || u16le(h, 32) !== 6) return null
  const sector = 1 << shift
  const fatSectors = u32le(h, 44)
  const base = { type: 'ole', ext: 'ole', name: 'OLE compound file' }
  if (!fatSectors || fatSectors > 109) {
    return found(ctx, { ...base, confidence: 'medium', end: null, note: `version ${major}; header is consistent, the size is not worked out for this many FAT sectors` })
  }
  let last = -1
  for (let k = 0; k < fatSectors; k++) {
    const id = u32le(h, 76 + k * 4)
    const fat = await src.read(start + (id + 1) * sector, sector)
    if (fat.length < sector) return found(ctx, { ...base, confidence: 'medium', end: ctx.size, note: `version ${major}; truncated FAT` })
    for (let i = sector / 4 - 1; i >= 0; i--) {
      if (u32le(fat, i * 4) !== 0xFFFFFFFF) {
        last = Math.max(last, k * (sector / 4) + i)
        break
      }
    }
  }
  if (last < 0) return null
  return found(ctx, {
    ...base, confidence: 'high', end: start + (last + 2) * sector,
    note: `version ${major}, ${sector}-byte sectors; the end is the last sector the FAT uses`
  })
}

const PEM_END = fromLatin1('-----END ')

/** PEM: a label in capitals, base64 lines, and the matching END line. */
export async function pem(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 80)
  const text = latin1(h, 0, h.length)
  const m = /^-----BEGIN ([A-Z0-9 ]{1,60})-----\r?\n/.exec(text)
  if (!m) return null
  const label = m[1]
  const at = await findForward(src, start + m[0].length, PEM_END, Math.min(ctx.size, start + (1 << 20)), ctx.expired)
  if (at < 0) return null
  const tail = latin1(await src.read(at, label.length + 20), 0, label.length + 20)
  if (!tail.startsWith(`-----END ${label}-----`)) return null
  const body = latin1(await src.read(start + m[0].length, at - start - m[0].length), 0, at - start - m[0].length)
  if (!/^(?:[A-Za-z0-9-]+: .*\r?\n)*\r?\n?(?:[A-Za-z0-9+/=]{1,80}\r?\n)+$/.test(body)) return null
  let end = at + 9 + label.length + 5
  if (tail[label.length + 14] === '\r') end++
  if (tail[end - at] === '\n') end++
  return found(ctx, { type: 'pem', ext: 'pem', name: `PEM ${label.toLowerCase()}`, confidence: 'high', end, note: `"${label}" block with base64 body and matching END line` })
}

const DER_PRIMITIVES = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0A, 0x0C, 0x12, 0x13, 0x14, 0x16, 0x17, 0x18, 0x1A, 0x1E])

function derLength(b, i) {
  const first = b[i]
  if (first === undefined) return null
  if (first < 0x80) return { length: first, size: 1 }
  const n = first & 0x7F
  if (n === 0 || n > 3 || i + n >= b.length) return null
  let length = 0
  for (let k = 1; k <= n; k++) length = length * 256 + b[i + k]
  return { length, size: 1 + n }
}

function derWalk(b, from, to, depth, counter) {
  let i = from
  while (i < to) {
    const tag = b[i]
    const len = derLength(b, i + 1)
    if (!len) return false
    const start = i + 1 + len.size
    const end = start + len.length
    if (end > to) return false
    counter.n++
    const constructed = tag & 0x20
    if (constructed) {
      if (depth > 12 || !derWalk(b, start, end, depth + 1, counter)) return false
    } else if (!DER_PRIMITIVES.has(tag) && (tag & 0xC0) !== 0x80) {
      return false
    }
    i = end
  }
  return i === to
}

/** DER: a SEQUENCE with a two-byte length whose whole TLV tree nests exactly; certificates and keys look like this. */
export async function der(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 4)
  if (h.length < 4) return null
  const length = u16be(h, 2)
  if (length < 128) return null
  const b = await src.read(start, 4 + length)
  if (b.length < 4 + length) return null
  const inner = b[4]
  if (inner !== 0x30 && inner !== 0x02 && inner !== 0x06 && inner !== 0xA0) return null
  const counter = { n: 0 }
  if (!derWalk(b, 4, 4 + length, 0, counter) || counter.n < 6) return null
  const cert = inner === 0x30 && b[5] === 0x82 && b[8] === 0xA0 && b[9] === 0x03 && b[10] === 0x02 && b[11] === 0x01
  return found(ctx, {
    type: 'der', ext: cert ? 'crt' : 'der', module: 'der', name: cert ? 'X.509 certificate (DER)' : 'DER structure',
    confidence: 'high', end: start + 4 + length,
    note: `${plural(counter.n, 'element')} that nest exactly`
  })
}

/** PDF: "%PDF-" and a version. The end (the last %%EOF before the next PDF header) is resolved once the scan has seen the whole file. */
export async function pdf(ctx) {
  const h = await ctx.src.read(ctx.start, 8)
  if (h.length < 8 || !/^%PDF-[12]\.\d$/.test(latin1(h, 0, 8))) return null
  return found(ctx, {
    type: 'pdf', ext: 'pdf', module: 'pdf', name: 'PDF document',
    confidence: 'medium', end: null, deferred: true,
    note: `version ${latin1(h, 5, 3)}`
  })
}
