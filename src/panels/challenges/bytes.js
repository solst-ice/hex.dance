// Small byte helpers for the challenge checkers. Every reader bounds-checks
// and returns null instead of throwing, because the bytes can be anything.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * CRC-32 (the one PNG and ZIP use) of `bytes[start, end)`.
 * @param {Uint8Array} bytes
 */
export function crc32(bytes, start = 0, end = bytes ? bytes.length : 0) {
  let c = 0xffffffff
  if (bytes) {
    const stop = Math.min(end, bytes.length)
    for (let i = Math.max(0, start); i < stop; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * CRC-32 of the whole buffer with the given ranges read as zero, so a checker
 * can confirm that nothing outside the bytes a task is about has changed.
 * @param {Uint8Array} bytes
 * @param {Array<[number, number]>} ranges   [start, end) pairs
 */
export function crc32Masked(bytes, ranges) {
  let c = 0xffffffff
  const length = bytes ? bytes.length : 0
  for (let i = 0; i < length; i++) {
    const masked = ranges.some(([start, end]) => i >= start && i < end)
    const value = masked ? 0 : bytes[i]
    c = CRC_TABLE[(c ^ value) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export function inRange(bytes, offset, length) {
  return Boolean(bytes) && offset >= 0 && length >= 0 && offset + length <= bytes.length
}

export function u16le(bytes, offset) {
  return inRange(bytes, offset, 2) ? bytes[offset] | (bytes[offset + 1] << 8) : null
}

export function u32le(bytes, offset) {
  if (!inRange(bytes, offset, 4)) return null
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

export function u32be(bytes, offset) {
  if (!inRange(bytes, offset, 4)) return null
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

/** True when `bytes` holds exactly `expected` at `offset`. */
export function bytesEqual(bytes, offset, expected) {
  if (!inRange(bytes, offset, expected.length)) return false
  for (let i = 0; i < expected.length; i++) if (bytes[offset + i] !== expected[i]) return false
  return true
}

export function ascii(text) {
  return Array.from(text, ch => ch.charCodeAt(0) & 0xff)
}

export function hex8(value) {
  return value.toString(16).toUpperCase().padStart(8, '0')
}

/** Splits a 32-bit value into the four bytes as they appear in a file. */
export function u32Bytes(value, littleEndian) {
  const parts = [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
  return littleEndian ? parts.reverse() : parts
}

export function formatHexBytes(list) {
  return list.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

/**
 * Parses hex typed by a person: "89 50 4e", "89504E", "0x89,0x50".
 * @returns {Uint8Array|null} null when the text is not whole bytes of hex
 */
export function parseHexBytes(text) {
  const cleaned = String(text ?? '').replace(/0x/gi, '').replace(/[\s,;:-]+/g, '')
  if (cleaned === '' || cleaned.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(cleaned)) return null
  const out = new Uint8Array(cleaned.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Parses an offset typed as decimal ("388") or hex ("0x184", "184h").
 * @returns {{ value: number, hexLooking: boolean }|null}
 */
export function parseOffset(text) {
  const s = String(text ?? '').trim().replace(/[_,\s]/g, '')
  if (/^0x[0-9a-f]+$/i.test(s)) return { value: parseInt(s.slice(2), 16), hexLooking: true }
  if (/^[0-9a-f]+h$/i.test(s)) return { value: parseInt(s.slice(0, -1), 16), hexLooking: true }
  if (/^[0-9]+$/.test(s)) return { value: parseInt(s, 10), hexLooking: false }
  if (/^[0-9a-f]+$/i.test(s)) return { value: parseInt(s, 16), hexLooking: true }
  return null
}

// SHA-256, small and synchronous, so answers can be compared without keeping
// them in clear text and without needing a secure context for crypto.subtle
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

/** @param {string} text  hashed as UTF-8 */
export function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text))
  const bitLength = data.length * 8
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    const v = Array.from(h)
    for (let i = 0; i < 64; i++) {
      const [a, b, c, d, e, f, g, hh] = v
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      v.splice(0, 8, (t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g)
    }
    for (let i = 0; i < 8; i++) h[i] += v[i]
  }
  return Array.from(h, x => x.toString(16).padStart(8, '0')).join('')
}
