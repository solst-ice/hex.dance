// CRC-32 checksums in plain JS (no DOM), shared by the format parsers (which
// also run in a worker and under node --test), the hashes, carve and
// challenges panels.
//
// `crc32` and `Crc32` are the common CRC-32 (reflected polynomial 0xEDB88320,
// as zlib, gzip, PNG, ZIP, xz, 7z and GPT use it). `oggCrc32` is the
// different, non-reflected CRC-32 that Ogg pages carry.

let tables = null

// Slicing-by-8 lookup tables: table k maps a byte to its CRC after k more zero bytes
function crcTables() {
  if (tables) return tables
  const t = new Int32Array(256 * 8)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n]
    for (let k = 1; k < 8; k++) {
      c = t[c & 0xff] ^ (c >>> 8)
      t[k * 256 + n] = c
    }
  }
  tables = t
  return t
}

// Runs the (inverted) CRC register `c` over d[start, end)
function update(c, d, start, end) {
  const t = crcTables()
  let i = start
  for (; i + 8 <= end; i += 8) {
    c ^= d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)
    c = t[1792 + (c & 0xff)] ^ t[1536 + ((c >>> 8) & 0xff)] ^ t[1280 + ((c >>> 16) & 0xff)] ^ t[1024 + (c >>> 24)] ^
      t[768 + d[i + 4]] ^ t[512 + d[i + 5]] ^ t[256 + d[i + 6]] ^ t[d[i + 7]]
  }
  for (; i < end; i++) c = t[(c ^ d[i]) & 0xff] ^ (c >>> 8)
  return c
}

// [start, end) clipped to the bytes; a missing buffer counts as empty
function bounds(bytes, start, end) {
  const length = bytes ? bytes.length : 0
  const from = Math.max(0, start)
  return [from, Math.max(from, Math.min(end, length))]
}

/**
 * CRC-32 of `bytes[start, end)`, as an unsigned number (what `zlib.crc32`
 * returns). The range is clipped to the bytes. Pass an earlier result as
 * `crc` to continue it over the next bytes.
 * @param {Uint8Array|ArrayLike<number>|null} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @param {number} [crc]
 * @returns {number}
 */
export function crc32(bytes, start = 0, end = bytes ? bytes.length : 0, crc = 0) {
  const [from, to] = bounds(bytes, start, end)
  return ~update(~crc, bytes, from, to) >>> 0
}

/**
 * Incremental CRC-32, for data that arrives in chunks:
 * `new Crc32().update(a).update(b).value()` equals `crc32(a + b)`.
 */
export class Crc32 {
  constructor() {
    this.crc = -1
  }

  /**
   * @param {Uint8Array|ArrayLike<number>} bytes
   * @param {number} [start]
   * @param {number} [end]
   */
  update(bytes, start = 0, end = bytes.length) {
    const [from, to] = bounds(bytes, start, end)
    this.crc = update(this.crc, bytes, from, to)
    return this
  }

  /** Unsigned CRC-32 of everything so far. */
  value() {
    return (this.crc ^ -1) >>> 0
  }

  /** The value as 8 lowercase hex digits. */
  digest() {
    return this.value().toString(16).padStart(8, '0')
  }
}

let oggTable = null

/**
 * Ogg's page checksum over `bytes[start, end)`: CRC-32 with the polynomial
 * 0x04C11DB7 fed most significant bit first, starting from 0, with no final
 * inversion. Pass an earlier result as `crc` to continue it.
 * @param {Uint8Array|ArrayLike<number>} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @param {number} [crc]
 * @returns {number}
 */
export function oggCrc32(bytes, start = 0, end = bytes.length, crc = 0) {
  if (!oggTable) {
    oggTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n << 24
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
      oggTable[n] = c >>> 0
    }
  }
  const [from, to] = bounds(bytes, start, end)
  let c = crc >>> 0
  for (let i = from; i < to; i++) c = (oggTable[((c >>> 24) ^ bytes[i]) & 0xff] ^ (c << 8)) >>> 0
  return c
}
