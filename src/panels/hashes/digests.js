/**
 * Incremental MD5, SHA-1, SHA-256, SHA-512 and CRC-32 in plain JS, so a
 * large file can be hashed one chunk at a time without ever holding a
 * second full copy of it (WebCrypto's digest() only takes the whole input).
 *
 * Every hasher has `update(bytes, start?, end?)` and `digest()`, which
 * returns the hash as a lowercase hex string. A hasher is finished after
 * `digest()`.
 */

function toHex(words, littleEndian) {
  let out = ''
  for (const word of words) {
    const w = word >>> 0
    if (littleEndian) {
      for (let shift = 0; shift < 32; shift += 8) out += ((w >>> shift) & 0xff).toString(16).padStart(2, '0')
    } else {
      out += w.toString(16).padStart(8, '0')
    }
  }
  return out
}

// SHA constants are the fractional bits of square and cube roots of the
// first primes; computing them avoids transcribing 80 64-bit literals.
function firstPrimes(count) {
  const primes = []
  for (let n = 2; primes.length < count; n++) {
    if (primes.every(p => p * p > n || n % p !== 0)) primes.push(n)
  }
  return primes
}

function integerRoot(n, k) {
  const kn = BigInt(k)
  let x = BigInt(Math.ceil(Number(n) ** (1 / k))) + (1n << 24n)
  for (;;) {
    const y = ((kn - 1n) * x + n / x ** (kn - 1n)) / kn
    if (y >= x) break
    x = y
  }
  while (x ** kn > n) x--
  while ((x + 1n) ** kn <= n) x++
  return x
}

/** 64 fractional bits of the k-th root of each prime, as [hi, lo] uint32 pairs. */
function rootFractions(count, k) {
  const mask = (1n << 64n) - 1n
  return firstPrimes(count).map(p => {
    const bits = integerRoot(BigInt(p) << BigInt(64 * k), k) & mask
    return [Number(bits >> 32n) | 0, Number(bits & 0xffffffffn) | 0]
  })
}

const CUBE = rootFractions(80, 3)
const SQUARE = rootFractions(8, 2)
const K256 = Int32Array.from(CUBE.slice(0, 64), ([hi]) => hi)
const K512 = Int32Array.from(CUBE.flat())
const H256 = SQUARE.map(([hi]) => hi)
const H512 = SQUARE.flat()

/**
 * Shared buffering and padding for Merkle–Damgård hashes. Subclasses
 * implement `block(data, offset)` and `words()`.
 */
class BlockHash {
  constructor(blockSize, lengthBytes, littleEndian) {
    this.blockSize = blockSize
    this.lengthBytes = lengthBytes
    this.littleEndian = littleEndian
    this.buffer = new Uint8Array(blockSize)
    this.buffered = 0
    this.total = 0
  }

  update(data, start = 0, end = data.length) {
    const size = this.blockSize
    this.total += end - start
    let pos = start
    if (this.buffered > 0) {
      const take = Math.min(size - this.buffered, end - pos)
      this.buffer.set(data.subarray(pos, pos + take), this.buffered)
      this.buffered += take
      pos += take
      if (this.buffered < size) return this
      this.block(this.buffer, 0)
      this.buffered = 0
    }
    for (; pos + size <= end; pos += size) this.block(data, pos)
    if (pos < end) {
      this.buffer.set(data.subarray(pos, end), 0)
      this.buffered = end - pos
    }
    return this
  }

  digest() {
    const size = this.blockSize
    const pad = new Uint8Array(size * 2)
    pad.set(this.buffer.subarray(0, this.buffered))
    pad[this.buffered] = 0x80
    const padded = this.buffered + 1 + this.lengthBytes <= size ? size : size * 2
    // Bit length; files are far below 2^53 bytes, so a double is exact
    let bits = this.total * 8
    for (let i = 0; i < 8; i++) {
      const at = this.littleEndian ? padded - this.lengthBytes + i : padded - 1 - i
      pad[at] = bits % 256
      bits = Math.floor(bits / 256)
    }
    this.block(pad, 0)
    if (padded > size) this.block(pad, size)
    return toHex(this.words(), this.littleEndian)
  }
}

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0)

export class Md5 extends BlockHash {
  constructor() {
    super(64, 8, true)
    this.h = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476)
    this.x = new Int32Array(16)
  }

  block(d, p) {
    const x = this.x
    for (let i = 0; i < 16; i++, p += 4) x[i] = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)
    const h = this.h
    let a = h[0], b = h[1], c = h[2], dd = h[3]
    for (let i = 0; i < 64; i++) {
      let f, g
      if (i < 16) { f = (b & c) | (~b & dd); g = i }
      else if (i < 32) { f = (dd & b) | (~dd & c); g = (5 * i + 1) & 15 }
      else if (i < 48) { f = b ^ c ^ dd; g = (3 * i + 5) & 15 }
      else { f = c ^ (b | ~dd); g = (7 * i) & 15 }
      const s = MD5_SHIFTS[((i >> 4) << 2) | (i & 3)]
      const t = (a + f + MD5_K[i] + x[g]) | 0
      a = dd
      dd = c
      c = b
      b = (b + ((t << s) | (t >>> (32 - s)))) | 0
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + dd) | 0
  }

  words() { return this.h }
}

export class Sha1 extends BlockHash {
  constructor() {
    super(64, 8, false)
    this.h = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0)
    this.w = new Int32Array(80)
  }

  block(d, p) {
    const w = this.w
    for (let i = 0; i < 16; i++, p += 4) w[i] = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]
    for (let i = 16; i < 80; i++) {
      const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = (v << 1) | (v >>> 31)
    }
    const h = this.h
    let a = h[0], b = h[1], c = h[2], dd = h[3], e = h[4]
    for (let i = 0; i < 80; i++) {
      let f, k
      if (i < 20) { f = (b & c) | (~b & dd); k = 0x5a827999 }
      else if (i < 40) { f = b ^ c ^ dd; k = 0x6ed9eba1 }
      else if (i < 60) { f = (b & c) | (b & dd) | (c & dd); k = 0x8f1bbcdc | 0 }
      else { f = b ^ c ^ dd; k = 0xca62c1d6 | 0 }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0
      e = dd
      dd = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = t
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + dd) | 0
    h[4] = (h[4] + e) | 0
  }

  words() { return this.h }
}

export class Sha256 extends BlockHash {
  constructor() {
    super(64, 8, false)
    this.h = Int32Array.from(H256)
    this.w = new Int32Array(64)
  }

  block(d, p) {
    const w = this.w
    for (let i = 0; i < 16; i++, p += 4) w[i] = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2]
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    const h = this.h
    let a = h[0], b = h[1], c = h[2], dd = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0
      hh = g
      g = f
      f = e
      e = (dd + t1) | 0
      dd = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + dd) | 0
    h[4] = (h[4] + e) | 0
    h[5] = (h[5] + f) | 0
    h[6] = (h[6] + g) | 0
    h[7] = (h[7] + hh) | 0
  }

  words() { return this.h }
}

const TWO_32 = 4294967296

// 64-bit words are kept as (hi, lo) int32 pairs; sums of lo halves stay
// exact in a double, and their carry is added to the hi half.
export class Sha512 extends BlockHash {
  constructor() {
    super(128, 16, false)
    this.h = Int32Array.from(H512)
    this.w = new Int32Array(160)
  }

  block(d, p) {
    const w = this.w
    for (let i = 0; i < 32; i++, p += 4) w[i] = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]
    for (let i = 16; i < 80; i++) {
      let xh = w[(i - 15) * 2], xl = w[(i - 15) * 2 + 1]
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7)
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25))
      xh = w[(i - 2) * 2]
      xl = w[(i - 2) * 2 + 1]
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6)
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26))
      const lo = (s0l >>> 0) + (s1l >>> 0) + (w[(i - 7) * 2 + 1] >>> 0) + (w[(i - 16) * 2 + 1] >>> 0)
      w[i * 2] = s0h + s1h + w[(i - 7) * 2] + w[(i - 16) * 2] + ((lo / TWO_32) | 0)
      w[i * 2 + 1] = lo
    }
    const h = this.h
    let ah = h[0], al = h[1], bh = h[2], bl = h[3], ch = h[4], cl = h[5], dh = h[6], dl = h[7]
    let eh = h[8], el = h[9], fh = h[10], fl = h[11], gh = h[12], gl = h[13], hh = h[14], hl = h[15]
    for (let i = 0; i < 80; i++) {
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23))
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23))
      const chh = (eh & fh) ^ (~eh & gh)
      const chl = (el & fl) ^ (~el & gl)
      const t1l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K512[i * 2 + 1] >>> 0) + (w[i * 2 + 1] >>> 0)
      const t1h = (hh + S1h + chh + K512[i * 2] + w[i * 2] + ((t1l / TWO_32) | 0)) | 0
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25))
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25))
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch)
      const mjl = (al & bl) ^ (al & cl) ^ (bl & cl)
      const t2l = (S0l >>> 0) + (mjl >>> 0)
      const t2h = (S0h + mjh + ((t2l / TWO_32) | 0)) | 0
      hh = gh; hl = gl
      gh = fh; gl = fl
      fh = eh; fl = el
      const el2 = (dl >>> 0) + (t1l >>> 0)
      eh = (dh + t1h + ((el2 / TWO_32) | 0)) | 0
      el = el2 | 0
      dh = ch; dl = cl
      ch = bh; cl = bl
      bh = ah; bl = al
      const al2 = (t1l >>> 0) + (t2l >>> 0)
      ah = (t1h + t2h + ((al2 / TWO_32) | 0)) | 0
      al = al2 | 0
    }
    const out = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl]
    for (let i = 0; i < 16; i += 2) {
      const lo = (h[i + 1] >>> 0) + (out[i + 1] >>> 0)
      h[i] = (h[i] + out[i] + ((lo / TWO_32) | 0)) | 0
      h[i + 1] = lo | 0
    }
  }

  words() { return this.h }
}

// Slicing-by-8 tables for the reflected IEEE polynomial (zlib, PNG, zip)
const CRC_TABLE = (() => {
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
  return t
})()

export class Crc32 {
  constructor() {
    this.crc = -1
  }

  update(d, start = 0, end = d.length) {
    const t = CRC_TABLE
    let c = this.crc
    let i = start
    for (; i + 8 <= end; i += 8) {
      c ^= d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)
      c = t[1792 + (c & 0xff)] ^ t[1536 + ((c >>> 8) & 0xff)] ^ t[1280 + ((c >>> 16) & 0xff)] ^ t[1024 + (c >>> 24)] ^
        t[768 + d[i + 4]] ^ t[512 + d[i + 5]] ^ t[256 + d[i + 6]] ^ t[d[i + 7]]
    }
    for (; i < end; i++) c = t[(c ^ d[i]) & 0xff] ^ (c >>> 8)
    this.crc = c
    return this
  }

  /** Unsigned CRC-32, as `zlib.crc32` returns it. */
  value() {
    return (this.crc ^ -1) >>> 0
  }

  digest() {
    return this.value().toString(16).padStart(8, '0')
  }
}

export const ALGORITHMS = [
  { id: 'md5', name: 'MD5', create: () => new Md5() },
  { id: 'sha1', name: 'SHA-1', create: () => new Sha1() },
  { id: 'sha256', name: 'SHA-256', create: () => new Sha256() },
  { id: 'sha512', name: 'SHA-512', create: () => new Sha512() },
  { id: 'crc32', name: 'CRC-32', create: () => new Crc32() }
]

/** Hashes a whole buffer with every algorithm; returns `{ [id]: hex }`. */
export function hashAll(bytes) {
  const out = {}
  for (const { id, create } of ALGORITHMS) out[id] = create().update(bytes).digest()
  return out
}
