import { crc32, u16be, u16le, u32be, u32le, latin1 } from '../bytes.js'
import { Reader } from '../source.js'
import { found, plural, hex } from './common.js'

const isLetter = (v) => (v >= 0x41 && v <= 0x5A) || (v >= 0x61 && v <= 0x7A)

/** PNG: IHDR CRC, then chunk lengths to IEND. */
export async function png(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 33)
  if (h.length < 33 || u32be(h, 8) !== 13 || latin1(h, 12, 4) !== 'IHDR') return null
  if (crc32(h, 12, 29) !== u32be(h, 29)) return null
  const width = u32be(h, 16)
  const height = u32be(h, 20)
  const base = { type: 'png', ext: 'png', module: 'png' }
  const dims = `${width}×${height}`
  const r = new Reader(src)
  let pos = start + 33
  let chunks = 1
  for (;;) {
    if (ctx.expired()) return found(ctx, { ...base, confidence: 'medium', end: null, note: `${dims}; stopped walking chunks at the time limit` })
    if (!(await r.need(pos, 8))) {
      return found(ctx, { ...base, confidence: 'medium', end: ctx.size, note: `${dims}; truncated: no IEND chunk before the end of the file` })
    }
    const len = u32be(r.buf, pos - r.base)
    const t = pos - r.base + 4
    if (len > 0x7FFFFFFF || !isLetter(r.buf[t]) || !isLetter(r.buf[t + 1]) || !isLetter(r.buf[t + 2]) || !isLetter(r.buf[t + 3])) {
      return found(ctx, { ...base, confidence: 'medium', end: null, note: `${dims}; chunk list breaks at ${hex(pos)}` })
    }
    const type = latin1(r.buf, t, 4)
    pos += 12 + len
    chunks++
    if (type === 'IEND') return found(ctx, { ...base, confidence: 'high', end: pos, note: `${dims}, ${plural(chunks, 'chunk')} up to IEND` })
  }
}

const SOF = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF])

/** JPEG: marker segments, entropy-coded data, up to EOI. */
export async function jpeg(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 4)
  if (h.length < 4) return null
  const first = h[3]
  if (!((first >= 0xE0 && first <= 0xEF) || first === 0xDB || first === 0xC4 || SOF.has(first) || first === 0xFE || first === 0xDD)) return null
  const r = new Reader(src)
  const base = { type: 'jpeg', ext: 'jpg', module: 'jpeg' }
  let pos = start + 2
  let sof = null
  let scans = 0
  let segments = 0
  const unknownEnd = (why) => (sof && segments >= 2
    ? found(ctx, { ...base, confidence: 'medium', end: null, note: `${sof}; ${why}` })
    : null)
  for (;;) {
    if (ctx.expired()) return unknownEnd('stopped at the time limit')
    if (!(await r.need(pos, 2))) return sof && scans ? found(ctx, { ...base, confidence: 'medium', end: ctx.size, note: `${sof}; truncated: no end-of-image marker` }) : null
    const i = pos - r.base
    if (r.buf[i] !== 0xFF) return unknownEnd(`marker expected at ${hex(pos)}`)
    const m = r.buf[i + 1]
    if (m === 0xFF) {
      pos++
      continue
    }
    if (m === 0xD9) {
      if (!sof || !scans) return null
      return found(ctx, { ...base, confidence: 'high', end: pos + 2, note: `${sof}, ${plural(scans, 'scan')}, ends at its EOI marker` })
    }
    if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) {
      pos += 2
      continue
    }
    if (m === 0x00 || m === 0xD8) return unknownEnd(`invalid marker at ${hex(pos)}`)
    if (!(await r.need(pos, 4))) return unknownEnd('truncated segment')
    const len = u16be(r.buf, pos - r.base + 2)
    if (len < 2) return unknownEnd(`bad segment length at ${hex(pos)}`)
    segments++
    if (SOF.has(m)) {
      if (!(await r.need(pos, 9))) return null
      const j = pos - r.base
      const height = u16be(r.buf, j + 5)
      const width = u16be(r.buf, j + 7)
      if (!width) return null
      sof = `${width}×${height}${m === 0xC2 ? ' progressive' : ''}`
    }
    pos += 2 + len
    if (m === 0xDA) {
      if (!sof) return null
      scans++
      // Entropy-coded data runs to the next marker that is not a stuffed 0xFF00 or a restart marker
      for (;;) {
        if (ctx.expired()) return unknownEnd('stopped at the time limit')
        if (!(await r.need(pos, 2))) return found(ctx, { ...base, confidence: 'medium', end: ctx.size, note: `${sof}; truncated inside image data` })
        const buf = r.buf
        let k = pos - r.base
        const stop = buf.length - 1
        let next = -1
        while (k < stop) {
          k = buf.indexOf(0xFF, k)
          if (k < 0 || k >= stop) break
          const v = buf[k + 1]
          if (v !== 0x00 && !(v >= 0xD0 && v <= 0xD7) && v !== 0xFF) {
            next = k
            break
          }
          k += 1
        }
        if (next >= 0) {
          pos = r.base + next
          break
        }
        pos = r.base + Math.max(pos - r.base + 1, stop)
      }
    }
  }
}

/** GIF: header, colour tables and blocks up to the trailer byte. */
export async function gif(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 13)
  if (h.length < 13) return null
  const width = u16le(h, 6)
  const height = u16le(h, 8)
  if (!width || !height) return null
  const flags = h[10]
  const base = { type: 'gif', ext: 'gif', module: 'gif' }
  const dims = `${width}×${height}`
  let pos = start + 13 + (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0)
  const r = new Reader(src)
  let frames = 0
  let blocks = 0
  const broken = (why) => (blocks >= 1 ? found(ctx, { ...base, confidence: 'medium', end: null, note: `${dims}; ${why}` }) : null)
  const skipSubBlocks = async () => {
    for (;;) {
      if (!(await r.need(pos, 1))) return false
      const n = r.u8(pos)
      pos += 1 + n
      if (n === 0) return true
    }
  }
  for (;;) {
    if (ctx.expired()) return broken('stopped at the time limit')
    if (!(await r.need(pos, 1))) return blocks ? found(ctx, { ...base, confidence: 'medium', end: ctx.size, note: `${dims}; truncated: no trailer` }) : null
    const b = r.u8(pos)
    if (b === 0x3B) {
      if (!blocks) return null
      return found(ctx, { ...base, confidence: 'high', end: pos + 1, note: `${dims}, ${plural(frames, 'frame')}, ends at its trailer` })
    }
    if (b === 0x21) {
      pos += 2
      if (!(await skipSubBlocks())) return broken('truncated extension')
    } else if (b === 0x2C) {
      if (!(await r.need(pos, 10))) return broken('truncated image descriptor')
      const f = r.u8(pos + 9)
      pos += 10 + (f & 0x80 ? 3 << ((f & 7) + 1) : 0)
      if (!(await r.need(pos, 1))) return broken('truncated image')
      const code = r.u8(pos)
      if (code < 2 || code > 12) return broken(`bad LZW code size at ${hex(pos)}`)
      pos += 1
      if (!(await skipSubBlocks())) return broken('truncated image data')
      frames++
    } else {
      return broken(`unexpected byte at ${hex(pos)}`)
    }
    blocks++
  }
}

const DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124])
const BMP_DEPTHS = new Set([1, 2, 4, 8, 16, 24, 32, 64])

/** BMP: the two-byte signature is weak, so every header field must be sane. */
export async function bmp(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 54)
  if (h.length < 26) return null
  const fileSize = u32le(h, 2)
  const dataOffset = u32le(h, 10)
  const dib = u32le(h, 14)
  if (u32le(h, 6) !== 0 || !DIB_SIZES.has(dib) || fileSize < 14 + dib || dataOffset < 14 + dib || dataOffset >= fileSize) return null
  let width, height, planes, bpp, compression = 0
  if (dib === 12) {
    width = u16le(h, 18)
    height = u16le(h, 20)
    planes = u16le(h, 22)
    bpp = u16le(h, 24)
  } else {
    if (h.length < 54) return null
    width = u32le(h, 18) | 0
    height = u32le(h, 22) | 0
    planes = u16le(h, 26)
    bpp = u16le(h, 28)
    compression = u32le(h, 30)
  }
  if (planes !== 1 || !BMP_DEPTHS.has(bpp) || compression > 13 || width <= 0 || width > 65535 || height === 0 || Math.abs(height) > 65535) return null
  const stride = Math.ceil((width * bpp) / 32) * 4
  const expected = dataOffset + stride * Math.abs(height)
  const exact = (compression === 0 || compression === 3) && (fileSize === expected || fileSize === expected + 2)
  if ((compression === 0 || compression === 3) && fileSize < expected) return null
  return found(ctx, {
    type: 'bmp', ext: 'bmp', module: 'bmp',
    confidence: exact ? 'high' : 'medium',
    end: start + fileSize,
    note: `${width}×${Math.abs(height)}, ${bpp}-bit${exact ? ', size matches its pixel data' : ''}`
  })
}

/** ICO and CUR: every directory entry must be sane and the first image must start with PNG or a DIB header. */
export async function ico(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 6)
  if (h.length < 6) return null
  const cursor = h[2] === 2
  const count = u16le(h, 4)
  if (count === 0 || count > 256) return null
  const dir = await src.read(start + 6, 16 * count)
  if (dir.length < 16 * count) return null
  let end = 6 + 16 * count
  let firstOffset = 0
  for (let k = 0; k < count; k++) {
    const e = 16 * k
    const planes = u16le(dir, e + 4)
    const bpp = u16le(dir, e + 6)
    const size = u32le(dir, e + 8)
    const offset = u32le(dir, e + 12)
    if (dir[e + 3] !== 0 && dir[e + 3] !== 0xFF) return null
    if (!cursor && (planes > 1 || ![0, 1, 4, 8, 16, 24, 32].includes(bpp))) return null
    if (size === 0 || size > (16 << 20) || offset < 6 + 16 * count) return null
    if (k === 0) firstOffset = offset
    end = Math.max(end, offset + size)
  }
  const img = await src.read(start + firstOffset, 8)
  const isPng = img.length >= 8 && u32be(img, 0) === 0x89504E47
  const isDib = img.length >= 4 && u32le(img, 0) === 40
  if (!isPng && !isDib) return null
  return found(ctx, {
    type: 'ico', ext: cursor ? 'cur' : 'ico', module: 'ico', name: cursor ? 'Windows cursor' : 'Windows icon',
    confidence: 'high', end: start + end,
    note: `${plural(count, 'image')}, directory entries consistent`
  })
}

const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4]

/** TIFF: sorted IFD entries with valid types; extent from out-of-line values and strips or tiles. */
export async function tiff(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 8)
  if (h.length < 8) return null
  const le = h[0] === 0x49
  const u16 = le ? u16le : u16be
  const u32 = le ? u32le : u32be
  let ifd = u32(h, 4)
  if (ifd < 8 || ifd > (256 << 20)) return null
  let end = 8
  let entries = 0
  let width = 0
  let height = 0
  const seen = new Set()
  const pairs = { 273: null, 279: null, 324: null, 325: null }
  for (let depth = 0; ifd && depth < 16 && !seen.has(ifd); depth++) {
    seen.add(ifd)
    const head = await src.read(start + ifd, 2)
    if (head.length < 2) return depth ? found(ctx, { type: 'tiff', ext: 'tif', module: 'tiff', confidence: 'medium', end: null, note: 'truncated IFD chain' }) : null
    const n = u16(head, 0)
    if (n === 0 || n > 1000) return null
    const d = await src.read(start + ifd + 2, n * 12 + 4)
    if (d.length < n * 12 + 4) return null
    let lastTag = -1
    for (let k = 0; k < n; k++) {
      const e = k * 12
      const tag = u16(d, e)
      const type = u16(d, e + 2)
      const count = u32(d, e + 4)
      if (tag <= lastTag || type === 0 || type > 13) return null
      lastTag = tag
      const bytes = TIFF_TYPE_SIZE[type] * count
      if (bytes > 4) {
        const off = u32(d, e + 8)
        end = Math.max(end, off + bytes)
      }
      if (depth === 0 && tag === 256) width = type === 3 ? u16(d, e + 8) : u32(d, e + 8)
      if (depth === 0 && tag === 257) height = type === 3 ? u16(d, e + 8) : u32(d, e + 8)
      if (tag in pairs && (type === 3 || type === 4) && count > 0 && count <= 65536) {
        const size = type === 3 ? 2 : 4
        let values
        if (count * size <= 4) {
          values = d.subarray(e + 8, e + 8 + count * size)
        } else {
          values = await src.read(start + u32(d, e + 8), count * size)
          if (values.length < count * size) values = null
        }
        if (values) {
          const list = []
          for (let i = 0; i < count; i++) list.push(size === 2 ? u16(values, i * 2) : u32(values, i * 4))
          pairs[tag] = (pairs[tag] || []).concat(list)
        }
      }
    }
    entries += n
    end = Math.max(end, ifd + 2 + n * 12 + 4)
    ifd = u32(d, n * 12)
  }
  for (const [offs, counts] of [[pairs[273], pairs[279]], [pairs[324], pairs[325]]]) {
    if (!offs || !counts) continue
    for (let i = 0; i < Math.min(offs.length, counts.length); i++) end = Math.max(end, offs[i] + counts[i])
  }
  if (entries < 3) return null
  return found(ctx, {
    type: 'tiff', ext: 'tif', module: 'tiff',
    confidence: width && height ? 'high' : 'medium',
    end: start + end, endKind: 'estimated',
    note: `${width && height ? `${width}×${height}, ` : ''}${plural(entries, 'tag')} in sorted IFDs; end is the furthest data they point to`
  })
}
