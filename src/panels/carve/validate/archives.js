import { allZero, crc32, fromLatin1, hexField, latin1, octal, u16le, u32be, u32le, u64le } from '../bytes.js'
import { inflateCheck } from '../inflate.js'
import { Reader, findForward } from '../source.js'
import { found, plural, sizeText, hex } from './common.js'

const ZIP_METHODS = new Set([0, 1, 6, 8, 9, 12, 14, 19, 93, 95, 96, 97, 98, 99])
const LFH = 0x04034B50
const CDH = 0x02014B50
const EOCD = 0x06054B50
const DD = fromLatin1('PK\x07\x08')

/**
 * ZIP from a local file header: walks entries, the central directory and
 * the end record. Entries that put their sizes in a data descriptor are
 * skipped by searching for the descriptor's signature.
 */
export async function zip(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 30)
  if (h.length < 30) return null
  const nameLength = u16le(h, 26)
  if (h[4] > 100 || !ZIP_METHODS.has(u16le(h, 8)) || nameLength === 0 || nameLength > 4096) return null
  const nameBytes = await src.read(start + 30, nameLength)
  if (nameBytes.length < nameLength || nameBytes.includes(0)) return null
  const firstName = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes).slice(0, 60)
  const base = { type: 'zip', ext: 'zip', module: 'zip' }
  const r = new Reader(src)
  const skip = []
  let pos = start
  let entries = 0
  let directory = 0
  const stopped = (why) => found(ctx, { ...base, confidence: 'medium', end: null, skip, note: `${plural(entries, 'entry', 'entries')}, first "${firstName}"; ${why}` })
  for (;;) {
    if (ctx.expired()) return stopped('stopped at the time limit')
    if (!(await r.need(pos, 30)) && !r.has(pos, 22)) return stopped(`truncated at ${hex(pos)}`)
    const i = pos - r.base
    const sig = u32le(r.buf, i)
    if (sig === LFH) {
      if (!r.has(pos, 30)) return stopped(`truncated at ${hex(pos)}`)
      const flags = u16le(r.buf, i + 6)
      const method = u16le(r.buf, i + 8)
      let compSize = u32le(r.buf, i + 18)
      const dataStart = pos + 30 + u16le(r.buf, i + 26) + u16le(r.buf, i + 28)
      if (!ZIP_METHODS.has(method)) return stopped(`unknown compression method at ${hex(pos)}`)
      if (pos !== start) skip.push(pos)
      entries++
      if ((flags & 8) && (compSize === 0 || compSize === 0xFFFFFFFF)) {
        const dd = await findForward(src, dataStart, DD, ctx.size, ctx.expired)
        if (dd < 0) return stopped('could not find the end of an entry with a data descriptor')
        await r.need(dd, 24)
        compSize = u32le(r.buf, dd - r.base + 8)
        if (dataStart + compSize !== dd) return stopped('data descriptor does not match its entry')
        const zip64 = r.has(dd, 24) && u32le(r.buf, dd - r.base + 16) !== LFH && u32le(r.buf, dd - r.base + 16) !== CDH
        pos = dd + (zip64 ? 24 : 16)
      } else {
        pos = dataStart + compSize + (flags & 8 ? 16 : 0)
        if (flags & 8) {
          // The descriptor's signature is optional
          if (await r.need(pos - 16, 4) && u32le(r.buf, pos - 16 - r.base) !== 0x08074B50) pos -= 4
        }
      }
    } else if (sig === CDH) {
      if (!(await r.need(pos, 46))) return stopped('truncated central directory')
      const j = pos - r.base
      pos += 46 + u16le(r.buf, j + 28) + u16le(r.buf, j + 30) + u16le(r.buf, j + 32)
      directory++
    } else if (sig === EOCD) {
      if (!r.has(pos, 22)) return stopped('truncated end record')
      skip.push(pos)
      const end = pos + 22 + u16le(r.buf, i + 20)
      if (!entries) return null
      return found(ctx, { ...base, confidence: 'high', end, skip, note: `${plural(entries, 'entry', 'entries')}, first "${firstName}"; ends at its end record` })
    } else if (sig === 0x06064B50) {
      pos += 12 + u64le(r.buf, i + 4)
    } else if (sig === 0x07064B50) {
      pos += 20
    } else if (sig === 0x05054B50) {
      pos += 6 + u16le(r.buf, i + 4)
    } else {
      return entries > 1 || directory ? stopped(`unexpected data at ${hex(pos)}`) : null
    }
  }
}

/**
 * A ZIP end record not reached from a local header (those are skipped):
 * its central directory tells where the archive starts. Offsets relative to
 * the start of the outer file are what makes "JPEG with a ZIP appended"
 * readable as a ZIP.
 */
export async function zipEnd(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 22)
  if (h.length < 22) return null
  const disk = u16le(h, 4)
  const cdDisk = u16le(h, 6)
  const here = u16le(h, 8)
  const total = u16le(h, 10)
  const cdSize = u32le(h, 12)
  const cdOffset = u32le(h, 16)
  const comment = u16le(h, 20)
  if (disk !== 0 || cdDisk !== 0 || here !== total || total === 0) return null
  const cdStart = start - cdSize
  if (cdStart < 0) return null
  const cd = await src.read(cdStart, 4)
  if (cd.length < 4 || u32le(cd, 0) !== CDH) return null
  const archiveStart = cdStart - cdOffset
  if (archiveStart < 0) return null
  const lfh = await src.read(archiveStart, 4)
  const startsWithEntry = lfh.length === 4 && u32le(lfh, 0) === LFH
  return found(ctx, {
    type: 'zip', ext: 'zip', module: 'zip', name: 'ZIP archive',
    start: archiveStart,
    confidence: startsWithEntry ? 'high' : 'medium',
    end: start + 22 + comment,
    note: `${plural(total, 'entry', 'entries')}; found from its end record at ${hex(start)}${archiveStart === 0 && ctx.start > 0 ? ', with offsets that make it readable from the start of the file' : ''}`
  })
}

/** Inflates with growing windows until the stream ends or the time is up. */
async function inflateFrom(ctx, pos, checksum) {
  const { src, size } = ctx
  for (let want = 64 << 10; ; want *= 4) {
    const buf = await src.read(pos, want)
    const inputFinal = pos + buf.length >= size
    const result = inflateCheck(buf, 0, { checksum, inputFinal, deadline: ctx.deadline })
    if (result.status === 'ok') return { ...result, end: pos + result.end, buf }
    if (result.status !== 'more' || inputFinal || want >= (256 << 20)) return result
    if (ctx.expired()) return { status: 'timeout', outSize: result.outSize }
  }
}

async function gzipMember(ctx, at) {
  const { src } = ctx
  const h = await src.read(at, 10)
  if (h.length < 10 || h[0] !== 0x1F || h[1] !== 0x8B || h[2] !== 8) return null
  const flags = h[3]
  if (flags & 0xE0 || (h[8] !== 0 && h[8] !== 2 && h[8] !== 4) || (h[9] > 13 && h[9] !== 255)) return null
  let pos = at + 10
  let name = ''
  const r = new Reader(src, 64 << 10)
  if (flags & 4) {
    if (!(await r.need(pos, 2))) return null
    pos += 2 + u16le(r.buf, pos - r.base)
  }
  for (const bit of [8, 16]) {
    if (!(flags & bit)) continue
    if (!(await r.need(pos, 1))) return null
    const i = r.buf.indexOf(0, pos - r.base)
    if (i < 0 || i - (pos - r.base) > 1024) return null
    if (bit === 8) name = latin1(r.buf, pos - r.base, Math.min(80, i - (pos - r.base)))
    pos = r.base + i + 1
  }
  if (flags & 2) pos += 2
  const result = await inflateFrom(ctx, pos, 'crc')
  if (result.status !== 'ok') return { failed: result, name }
  const t = await src.read(result.end, 8)
  if (t.length < 8) return { failed: { status: 'error', reason: 'truncated trailer', outSize: result.outSize }, name }
  if (u32le(t, 0) !== result.check || u32le(t, 4) !== (result.outSize >>> 0)) return { failed: { status: 'error', reason: 'checksum mismatch', outSize: result.outSize }, name }
  return { end: result.end + 8, outSize: result.outSize, name }
}

/**
 * gzip: the 3-byte signature appears by chance about six times per 100 MB,
 * so a member counts only when it decompresses and its CRC-32 and length
 * match. Members that follow one another are one file.
 */
export async function gzip(ctx) {
  const first = await gzipMember(ctx, ctx.start)
  if (!first) return null
  const base = { type: 'gzip', ext: 'gz', module: 'gzip' }
  const label = first.name ? `"${first.name}", ` : ''
  if (first.failed) {
    const { status, outSize } = first.failed
    if (status === 'timeout' && outSize > (1 << 20)) {
      return found(ctx, { ...base, confidence: 'medium', end: null, note: `${label}decompresses cleanly for ${sizeText(outSize)}; stopped at the time limit` })
    }
    if (status === 'error' && first.failed.reason === 'unexpected end of data' && outSize > 4096) {
      return found(ctx, { ...base, confidence: 'medium', end: ctx.size, note: `${label}truncated after ${sizeText(outSize)} of output` })
    }
    return null
  }
  let end = first.end
  let members = 1
  let out = first.outSize
  const skip = []
  while (end < ctx.size && members < 1000 && !ctx.expired()) {
    const next = await gzipMember(ctx, end)
    if (!next || next.failed) break
    skip.push(end)
    end = next.end
    out += next.outSize
    members++
  }
  return found(ctx, {
    ...base, confidence: 'high', end, skip,
    note: `${label}${sizeText(end - ctx.start)} → ${sizeText(out)}${members > 1 ? ` in ${members} members` : ''}; CRC-32 matches`
  })
}

/**
 * zlib: the header is two bytes, so a stream counts only when it inflates
 * to the end and its Adler-32 matches.
 */
export async function zlib(ctx) {
  const result = await inflateFrom(ctx, ctx.start + 2, 'adler')
  if (result.status === 'timeout' && result.outSize > (1 << 20)) {
    return found(ctx, { type: 'zlib', ext: 'zlib', confidence: 'medium', end: null, note: `decompresses cleanly for ${sizeText(result.outSize)}; stopped at the time limit` })
  }
  if (result.status !== 'ok') return null
  const t = await ctx.src.read(result.end, 4)
  if (t.length < 4 || u32be(t, 0) !== result.check) return null
  const end = result.end + 4
  return found(ctx, {
    type: 'zlib', ext: 'zlib', name: 'zlib stream', confidence: 'high', end,
    note: `${sizeText(end - ctx.start)} → ${sizeText(result.outSize)}; Adler-32 matches`
  })
}

const XZ_FOOTER = fromLatin1('YZ')

/** xz: stream flags and their CRC-32; the end is the footer that repeats the flags with a valid CRC. */
export async function xz(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 12)
  if (h.length < 12 || h[6] !== 0 || h[7] > 0x0F || crc32(h, 6, 8) !== u32le(h, 8)) return null
  let from = start + 12
  for (let tries = 0; tries < 64 && !ctx.expired(); tries++) {
    const at = await findForward(src, from, XZ_FOOTER, ctx.size, ctx.expired)
    if (at < 0) break
    const footer = at - 10
    if (footer >= start + 12) {
      const f = await src.read(footer, 12)
      if (f[8] === h[6] && f[9] === h[7] && crc32(f, 4, 10) === u32le(f, 0)) {
        return found(ctx, { type: 'xz', ext: 'xz', module: 'xz', confidence: 'high', end: at + 2, note: 'header and footer CRC-32 match' })
      }
    }
    from = at + 1
  }
  return found(ctx, { type: 'xz', ext: 'xz', module: 'xz', confidence: 'medium', end: null, note: 'header CRC-32 matches; no footer found' })
}

/** bzip2: "BZh", a block-size digit and the 48-bit block or end-of-stream magic. The end is bit-aligned, so it is not computed. */
export async function bzip2(ctx) {
  const h = await ctx.src.read(ctx.start, 10)
  if (h.length < 10 || h[3] < 0x31 || h[3] > 0x39) return null
  const block = latin1(h, 4, 6)
  if (block !== '\x31\x41\x59\x26\x53\x59' && block !== '\x17\x72\x45\x38\x50\x90') return null
  return found(ctx, { type: 'bzip2', ext: 'bz2', module: 'bzip2', confidence: 'medium', end: null, note: `block size ${h[3] - 0x30}00 KB; first block magic present` })
}

/** Zstandard: frame header, then block headers up to the last block and the optional checksum. */
export async function zstd(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 18)
  if (h.length < 6) return null
  const fhd = h[4]
  if (fhd & 0x08) return null
  const single = (fhd >> 5) & 1
  const fcsFlag = fhd >> 6
  const dictBytes = [0, 1, 2, 4][fhd & 3]
  const fcsBytes = [single ? 1 : 0, 2, 4, 8][fcsFlag]
  if (!single && (h[5] >> 3) > 30) return null
  let pos = start + 5 + (single ? 0 : 1) + dictBytes + fcsBytes
  const r = new Reader(src)
  let blocks = 0
  for (;;) {
    if (ctx.expired()) return blocks ? found(ctx, { type: 'zstd', ext: 'zst', module: 'zstd', confidence: 'medium', end: null, note: 'stopped at the time limit' }) : null
    if (!(await r.need(pos, 3))) return null
    const i = pos - r.base
    const header = r.buf[i] | (r.buf[i + 1] << 8) | (r.buf[i + 2] << 16)
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >> 3
    if (type === 3 || size > (128 << 10)) return null
    pos += 3 + (type === 1 ? 1 : size)
    blocks++
    if (last) break
  }
  if (fhd & 4) pos += 4
  return found(ctx, { type: 'zstd', ext: 'zst', module: 'zstd', confidence: 'high', end: pos, note: `${plural(blocks, 'block')} up to the last-block flag` })
}

/** 7z: start header CRC-32, then the next header's position, size and CRC-32. */
export async function sevenZip(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 32)
  if (h.length < 32 || h[6] !== 0 || crc32(h, 12, 32) !== u32le(h, 8)) return null
  const nextOffset = u64le(h, 12)
  const nextSize = u64le(h, 20)
  const end = start + 32 + nextOffset + nextSize
  let verified = false
  if (nextSize > 0 && nextSize <= (16 << 20) && end <= ctx.size) {
    const next = await src.read(start + 32 + nextOffset, nextSize)
    verified = crc32(next) === u32le(h, 28)
  }
  return found(ctx, {
    type: '7z', ext: '7z', module: '7z', name: '7z archive', confidence: 'high', end,
    note: `version 0.${h[7]}; start header CRC-32 matches${verified ? ', next header CRC-32 matches' : ''}`
  })
}

function vint(buf, i) {
  let value = 0
  for (let k = 0; k < 10 && i + k < buf.length; k++) {
    value += (buf[i + k] & 0x7F) * 2 ** (7 * k)
    if (!(buf[i + k] & 0x80)) return { value, length: k + 1 }
  }
  return null
}

/** RAR 4 and 5: each block's header CRC is checked while walking to the end-of-archive block. */
export async function rar(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 8)
  if (h.length < 8) return null
  const v5 = h[6] === 1 && h[7] === 0
  if (!v5 && h[6] !== 0) return null
  const r = new Reader(src)
  let pos = start + (v5 ? 8 : 7)
  let blocks = 0
  const base = { type: 'rar', ext: 'rar', module: 'rar', name: 'RAR archive' }
  for (;;) {
    if (ctx.expired()) return blocks ? found(ctx, { ...base, confidence: 'medium', end: null, note: 'stopped at the time limit' }) : null
    if (!(await r.need(pos, 7)) && !r.has(pos, 7)) break
    const i = pos - r.base
    if (v5) {
      const size = vint(r.buf, i + 4)
      if (!size || size.value < 1 || size.value > (2 << 20)) break
      const headerEnd = pos + 4 + size.length + size.value
      if (!(await r.need(pos, headerEnd - pos))) break
      const j = pos - r.base
      if (crc32(r.buf, j + 4, j + 4 + size.length + size.value) !== u32le(r.buf, j)) break
      let k = j + 4 + size.length
      const type = vint(r.buf, k)
      k += type.length
      const flags = vint(r.buf, k)
      k += flags.length
      if (flags.value & 1) k += vint(r.buf, k).length
      const dataSize = flags.value & 2 ? vint(r.buf, k).value : 0
      pos = headerEnd + dataSize
      blocks++
      if (type.value === 5) return found(ctx, { ...base, confidence: 'high', end: pos, note: `RAR 5, ${plural(blocks, 'block')} with matching CRCs up to the end block` })
    } else {
      const headCrc = u16le(r.buf, i)
      const type = r.buf[i + 2]
      const flags = u16le(r.buf, i + 3)
      const size = u16le(r.buf, i + 5)
      if (size < 7 || type < 0x72 || type > 0x7B) break
      if (!(await r.need(pos, size + 4))) break
      const j = pos - r.base
      if ((crc32(r.buf, j + 2, j + size) & 0xFFFF) !== headCrc) break
      const add = flags & 0x8000 || type === 0x74 ? u32le(r.buf, j + 7) : 0
      pos += size + add
      blocks++
      if (type === 0x7B) return found(ctx, { ...base, confidence: 'high', end: pos, note: `RAR 4, ${plural(blocks, 'block')} with matching CRCs up to the end block` })
    }
  }
  if (!blocks) return null
  return found(ctx, { ...base, confidence: blocks >= 2 ? 'high' : 'medium', end: blocks >= 2 ? pos : null, endKind: 'estimated', note: `RAR ${v5 ? 5 : 4}, ${plural(blocks, 'block')} with matching CRCs; no end block` })
}

/**
 * LZMA (.lzma, "LZMA alone") has no magic number and no checksum in its
 * header, only plausible values: properties 0x5D (the default lc/lp/pb), a
 * dictionary of 2^n or 3·2^(n-1) bytes between 4 KB and 64 MB, a stored
 * length of at most 16 GB (or "unknown") and a zero first range-coder byte.
 * That is still only plausibility, so hits stay low confidence.
 */
export async function lzma(ctx) {
  const h = await ctx.src.read(ctx.start, 14)
  if (h.length < 14) return null
  const dict = u32le(h, 1)
  let ok = false
  for (let n = 12; n <= 26 && !ok; n++) ok = dict === 2 ** n || (n < 26 && dict === 3 * 2 ** (n - 1))
  if (!ok) return null
  const unknown = h.subarray(5, 13).every(v => v === 0xFF)
  const length = u64le(h, 5)
  if (!unknown && (length === 0 || length > 2 ** 34)) return null
  if (h[13] !== 0) return null
  return found(ctx, {
    type: 'lzma', ext: 'lzma', name: 'LZMA data', confidence: 'low', end: null,
    note: `dictionary ${sizeText(dict)}, ${unknown ? 'length not stored' : `unpacks to ${sizeText(length)}`}; header values are plausible, but LZMA has no magic number or checksum to confirm them`
  })
}

/** LZ4 frame: descriptor bits, then block sizes up to the end mark. */
export async function lz4(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 15)
  if (h.length < 7) return null
  const flg = h[4]
  const bd = h[5]
  if ((flg >> 6) !== 1 || (flg & 2) || (bd & 0x8F) || ((bd >> 4) & 7) < 4) return null
  const maxBlock = 1 << (8 + 2 * ((bd >> 4) & 7))
  let pos = start + 6 + (flg & 8 ? 8 : 0) + (flg & 1 ? 4 : 0) + 1
  const r = new Reader(src)
  let blocks = 0
  for (;;) {
    if (ctx.expired()) return null
    if (!(await r.need(pos, 4))) return null
    const word = u32le(r.buf, pos - r.base)
    if (word === 0) {
      pos += 4 + (flg & 4 ? 4 : 0)
      break
    }
    const size = word & 0x7FFFFFFF
    if (size > maxBlock) return null
    pos += 4 + size + (flg & 0x10 ? 4 : 0)
    blocks++
  }
  return found(ctx, { type: 'lz4', ext: 'lz4', name: 'LZ4 frame', confidence: 'high', end: pos, note: `${plural(blocks, 'block')} up to the end mark` })
}

/** Microsoft cabinet: reserved fields zero, version 1.3, at least one folder and file. */
export async function cab(ctx) {
  const h = await ctx.src.read(ctx.start, 36)
  if (h.length < 36) return null
  const size = u32le(h, 8)
  if (u32le(h, 12) !== 0 || u32le(h, 20) !== 0 || h[24] !== 3 || h[25] !== 1 || !u16le(h, 26) || !u16le(h, 28) || size < 36 || u32le(h, 16) >= size) return null
  return found(ctx, {
    type: 'cab', ext: 'cab', name: 'Microsoft cabinet', confidence: 'high', end: ctx.start + size,
    note: `${plural(u16le(h, 28), 'file')} in ${plural(u16le(h, 26), 'folder')}; size from its header`
  })
}

/** ar (and Debian packages): 60-byte member headers ending in "`\n" with decimal sizes. */
export async function ar(ctx) {
  const { src, start } = ctx
  const r = new Reader(src)
  let pos = start + 8
  let members = 0
  let first = ''
  for (;;) {
    if (ctx.expired() || !(await r.need(pos, 60))) break
    const i = pos - r.base
    if (r.buf[i + 58] !== 0x60 || r.buf[i + 59] !== 0x0A) break
    const sizeText = latin1(r.buf, i + 48, 10).trim()
    if (!/^\d+$/.test(sizeText)) break
    if (!members) first = latin1(r.buf, i, 16).trim()
    const size = Number(sizeText)
    pos += 60 + size + (size & 1)
    members++
  }
  if (!members) return null
  const deb = first === 'debian-binary'
  return found(ctx, {
    type: deb ? 'deb' : 'ar', ext: deb ? 'deb' : 'a', name: deb ? 'Debian package' : 'ar archive',
    confidence: 'high', end: Math.min(pos, ctx.size), endKind: 'estimated',
    note: `${plural(members, 'member')}, first "${first}"; the end is where member headers stop`
  })
}

/** cpio, "new" (hex) and "odc" (octal) headers, walked to the TRAILER!!! entry. */
export async function cpio(ctx) {
  const { src, start } = ctx
  const r = new Reader(src)
  let pos = start
  let entries = 0
  const skip = []
  for (;;) {
    if (ctx.expired()) return null
    if (!(await r.need(pos, 110)) && !r.has(pos, 76)) return null
    const i = pos - r.base
    const magic = latin1(r.buf, i, 6)
    let nameSize, fileSize, headerSize, align
    if (magic === '070701' || magic === '070702') {
      if (!r.has(pos, 110) || hexField(r.buf, i + 6, 104) < 0) return null
      nameSize = hexField(r.buf, i + 94, 8)
      fileSize = hexField(r.buf, i + 54, 8)
      headerSize = 110
      align = 4
    } else if (magic === '070707') {
      nameSize = octal(r.buf, i + 59, 6)
      fileSize = octal(r.buf, i + 65, 11)
      if (nameSize < 0 || fileSize < 0) return null
      headerSize = 76
      align = 1
    } else {
      return null
    }
    if (nameSize < 1 || nameSize > 4096) return null
    if (!(await r.need(pos + headerSize, nameSize))) return null
    const name = latin1(r.buf, pos + headerSize - r.base, nameSize - 1)
    const pad = (n) => (align === 4 ? (n + 3) & ~3 : n)
    if (pos !== start) skip.push(pos)
    pos += pad(headerSize + nameSize)
    pos = start + pad(pos - start)
    if (name === 'TRAILER!!!') {
      return found(ctx, { type: 'cpio', ext: 'cpio', name: 'cpio archive', confidence: 'high', end: pos, skip, note: `${plural(entries, 'entry', 'entries')} up to TRAILER!!!` })
    }
    pos = start + pad(pos - start + fileSize)
    entries++
  }
}

function tarChecksumOk(b, i) {
  const stored = octal(b, i + 148, 8)
  if (stored < 0) return false
  let sum = 0
  for (let k = 0; k < 512; k++) sum += k >= 148 && k < 156 ? 0x20 : b[i + k]
  return sum === stored
}

/** tar (ustar and GNU): header checksums, member sizes, up to the two zero blocks. */
export async function tar(ctx) {
  const { src, start } = ctx
  const r = new Reader(src)
  let pos = start
  let members = 0
  let first = ''
  const skip = []
  for (;;) {
    if (ctx.expired()) return members ? found(ctx, { type: 'tar', ext: 'tar', module: 'tar', confidence: 'medium', end: null, skip, note: 'stopped at the time limit' }) : null
    if (!(await r.need(pos, 512))) break
    const i = pos - r.base
    if (allZero(r.buf, i, 512)) {
      let end = pos + 512
      if (await r.need(end, 512) && allZero(r.buf, end - r.base, 512)) end += 512
      // Zero padding up to the 10 KB record size belongs to the archive too
      while ((end - start) % 10240 && await r.need(end, 512) && allZero(r.buf, end - r.base, 512)) end += 512
      return found(ctx, { type: 'tar', ext: 'tar', module: 'tar', confidence: 'high', end, skip, note: `${plural(members, 'member')}, first "${first}"; header checksums match` })
    }
    if (!tarChecksumOk(r.buf, i)) break
    let size = octal(r.buf, i + 124, 12)
    if (r.buf[i + 124] & 0x80) {
      size = 0
      for (let k = 125; k < 136; k++) size = size * 256 + r.buf[i + k]
    }
    if (size < 0) size = 0
    if (!members) first = latin1(r.buf, i, 100).replace(/\0.*$/s, '').slice(0, 60)
    if (pos !== start) skip.push(pos)
    pos += 512 + Math.ceil(size / 512) * 512
    members++
  }
  if (!members) return null
  return found(ctx, { type: 'tar', ext: 'tar', module: 'tar', confidence: 'medium', end: Math.min(pos, ctx.size), endKind: 'estimated', skip, note: `${plural(members, 'member')}, first "${first}"; no end-of-archive blocks` })
}
