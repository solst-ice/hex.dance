// Reproducible byte corruption for the glitch lab. Works on a copy; the
// file itself is never touched.

/** Small, fast seeded PRNG (mulberry32); returns floats in [0, 1). */
export function seededRandom(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `count` distinct offsets in [skip, size), sorted, chosen by `seed`. */
export function pickOffsets(size, count, skip, seed) {
  const from = Math.max(0, Math.min(size, Math.floor(skip) || 0))
  const span = size - from
  const n = Math.max(0, Math.min(Math.floor(count) || 0, span))
  const random = seededRandom(seed)
  const picked = new Set()
  if (n > span / 2) {
    // Dense: shuffle the start of the range instead of rejecting repeats
    const all = Array.from({ length: span }, (_, i) => from + i)
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(random() * (span - i))
      ;[all[i], all[j]] = [all[j], all[i]]
      picked.add(all[i])
    }
  } else {
    while (picked.size < n) picked.add(from + Math.floor(random() * span))
  }
  return Array.from(picked).sort((a, b) => a - b)
}

/**
 * Copies `bytes` and gives each offset a new value, always different from
 * the old one.
 *
 * @returns {{ bytes: Uint8Array, changes: Array<{ offset: number, from: number, to: number }> }}
 */
export function glitchCopy(bytes, offsets, seed) {
  const copy = bytes.slice()
  const random = seededRandom((seed ^ 0x9e3779b9) >>> 0)
  const changes = offsets.map(offset => {
    const from = copy[offset]
    const to = from ^ (1 + Math.floor(random() * 255))
    copy[offset] = to
    return { offset, from, to }
  })
  return { bytes: copy, changes }
}

const u16be = (b, i) => (b[i] << 8) | b[i + 1]
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0

function jpegScanStart(b) {
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) { i++; continue }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue }
    const length = u16be(b, i + 2)
    if (marker === 0xda) return i + 2 + length
    i += 2 + length
  }
  return null
}

function pngDataStart(b) {
  let i = 8
  while (i + 8 <= b.length) {
    const length = u32be(b, i)
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
    // skip the two-byte zlib header too
    if (type === 'IDAT') return i + 8 + 2
    i += 12 + length
  }
  return null
}

function gifDataStart(b) {
  if (b.length < 13) return null
  let i = 13
  if (b[10] & 0x80) i += 3 * (2 << (b[10] & 7))
  while (i < b.length) {
    if (b[i] === 0x21) {
      i += 2
      while (i < b.length && b[i] !== 0) i += b[i] + 1
      i++
    } else if (b[i] === 0x2c) {
      const flags = b[i + 9]
      i += 10
      if (flags & 0x80) i += 3 * (2 << (flags & 7))
      // LZW minimum code size, then the first sub-block's length
      return i + 2
    } else {
      return null
    }
  }
  return null
}

/**
 * How many leading bytes to leave alone so the image still opens: the
 * headers and tables before the compressed pixels, where that is easy to
 * find, else a small fixed amount.
 */
export function suggestSkip(bytes, mime) {
  const size = bytes.length
  let start = null
  if (mime === 'image/jpeg') start = jpegScanStart(bytes)
  else if (mime === 'image/png') start = pngDataStart(bytes)
  else if (mime === 'image/gif') start = gifDataStart(bytes)
  else if (mime === 'image/bmp' && size >= 14) start = u32le(bytes, 10)
  if (start === null || !(start < size)) start = Math.min(1024, Math.floor(size / 8))
  return Math.max(0, Math.min(size - 1, start))
}
