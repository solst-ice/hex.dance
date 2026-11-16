// A DEFLATE decoder that checks a stream rather than keeping its output:
// it decodes into a 64 KB ring (enough for back-references), keeps a running
// Adler-32 or CRC-32 and reports where the compressed data ends. Random bytes
// fail within a few symbols, so it doubles as the validator for zlib and gzip
// candidates.

import { adler32 } from './bytes.js'
import { crc32 } from '../../lib/crc32.js'

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

const NEED_MORE = { needMore: true }
// Shared output ring; the decoder is synchronous, so calls never overlap
const ring = new Uint8Array(65536)
class InflateError extends Error {}

/**
 * Builds a lookup table indexed by the next `bits` input bits (LSB first).
 * Entries are (symbol << 4) | length; 0 marks an unused code. Mirrors zlib:
 * over-subscribed sets are invalid, incomplete ones only when the longest
 * code is one bit long.
 */
export function buildTable(lengths, count) {
  const counts = new Uint16Array(16)
  let max = 0
  for (let s = 0; s < count; s++) {
    counts[lengths[s]]++
    if (lengths[s] > max) max = lengths[s]
  }
  counts[0] = 0
  let left = 1
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - counts[len]
    if (left < 0) throw new InflateError('over-subscribed code')
  }
  if (left > 0 && max > 1) throw new InflateError('incomplete code')
  const bits = Math.max(1, max)
  const table = new Int32Array(1 << bits)
  const next = new Uint16Array(16)
  let code = 0
  for (let len = 1; len <= 15; len++) {
    code = (code + counts[len - 1]) << 1
    next[len] = code
  }
  for (let s = 0; s < count; s++) {
    const len = lengths[s]
    if (!len) continue
    let c = next[len]++
    let rev = 0
    for (let k = 0; k < len; k++) {
      rev = (rev << 1) | (c & 1)
      c >>= 1
    }
    for (let i = rev; i < table.length; i += 1 << len) table[i] = (s << 4) | len
  }
  return { table, bits, max }
}

let fixed = null
function fixedTables() {
  if (fixed) return fixed
  const lit = new Uint8Array(288)
  lit.fill(8, 0, 144)
  lit.fill(9, 144, 256)
  lit.fill(7, 256, 280)
  lit.fill(8, 280, 288)
  fixed = { lit: buildTable(lit, 288), dist: buildTable(new Uint8Array(32).fill(5), 32) }
  return fixed
}

/**
 * Decodes the raw DEFLATE stream that starts at `buf[pos]`.
 * @param {Uint8Array} buf
 * @param {number} pos
 * @param {{ checksum?: 'adler'|'crc'|null, deadline?: number, inputFinal?: boolean }} [options]
 *   `inputFinal`: `buf` reaches the end of the file, so running out of input is an error rather than a request for more
 * @returns {{ status: 'ok', end: number, outSize: number, check: number }
 *   | { status: 'error', reason: string, outSize: number }
 *   | { status: 'more', outSize: number }
 *   | { status: 'timeout', outSize: number }}
 */
export function inflateCheck(buf, pos, { checksum = null, deadline = Infinity, inputFinal = false } = {}) {
  const length = buf.length
  let p = pos
  let bb = 0
  let bc = 0
  let w = 0
  let total = 0
  let flushed = 0
  let check = checksum === 'adler' ? 1 : 0

  const refill = (n) => {
    while (bc < n) {
      if (p >= length) throw inputFinal ? new InflateError('unexpected end of data') : NEED_MORE
      bb |= buf[p++] << bc
      bc += 8
    }
  }
  const bits = (n) => {
    refill(n)
    const v = bb & ((1 << n) - 1)
    bb >>>= n
    bc -= n
    return v
  }
  const decode = (h) => {
    while (bc < h.bits && p < length) {
      bb |= buf[p++] << bc
      bc += 8
    }
    const e = h.table[bb & ((1 << h.bits) - 1)]
    if (e === 0) throw new InflateError('invalid code')
    const len = e & 15
    if (len > bc) throw inputFinal ? new InflateError('unexpected end of data') : NEED_MORE
    bb >>>= len
    bc -= len
    return e >> 4
  }
  const flush = () => {
    if (!checksum || total === flushed) return
    const sum = checksum === 'adler' ? adler32 : crc32
    const from = flushed & 0xFFFF
    const end = from + (total - flushed)
    if (end <= 65536) {
      check = sum(ring, from, end, check)
    } else {
      check = sum(ring, from, 65536, check)
      check = sum(ring, 0, end - 65536, check)
    }
    flushed = total
  }
  const emit = (v) => {
    ring[w] = v
    w = (w + 1) & 0xFFFF
    total++
    if (total - flushed >= 32768) flush()
  }

  try {
    let final = 0
    let symbols = 0
    do {
      final = bits(1)
      const type = bits(2)
      if (type === 0) {
        bb >>>= bc & 7
        bc -= bc & 7
        const len = bits(16)
        const nlen = bits(16)
        if ((len ^ 0xFFFF) !== nlen) throw new InflateError('stored block length check failed')
        let remaining = len
        while (remaining > 0 && bc >= 8) {
          emit(bits(8))
          remaining--
        }
        if (p + remaining > length) throw inputFinal ? new InflateError('unexpected end of data') : NEED_MORE
        for (let k = 0; k < remaining; k++) emit(buf[p++])
      } else if (type === 3) {
        throw new InflateError('invalid block type')
      } else {
        let lit, dist
        if (type === 1) {
          ({ lit, dist } = fixedTables())
        } else {
          const hlit = bits(5) + 257
          const hdist = bits(5) + 1
          const hclen = bits(4) + 4
          if (hlit > 286 || hdist > 30) throw new InflateError('too many length or distance symbols')
          const codeLengths = new Uint8Array(19)
          for (let k = 0; k < hclen; k++) codeLengths[CODE_ORDER[k]] = bits(3)
          const codeTable = buildTable(codeLengths, 19)
          if (codeTable.max === 0) throw new InflateError('empty code length code')
          const lengths = new Uint8Array(hlit + hdist)
          let k = 0
          while (k < hlit + hdist) {
            const sym = decode(codeTable)
            if (sym < 16) {
              lengths[k++] = sym
            } else {
              let repeat, value = 0
              if (sym === 16) {
                if (k === 0) throw new InflateError('repeat with no previous length')
                value = lengths[k - 1]
                repeat = 3 + bits(2)
              } else if (sym === 17) {
                repeat = 3 + bits(3)
              } else {
                repeat = 11 + bits(7)
              }
              if (k + repeat > hlit + hdist) throw new InflateError('too many code lengths')
              lengths.fill(value, k, k + repeat)
              k += repeat
            }
          }
          if (lengths[256] === 0) throw new InflateError('missing end-of-block code')
          lit = buildTable(lengths.subarray(0, hlit), hlit)
          dist = buildTable(lengths.subarray(hlit), hdist)
        }
        for (;;) {
          const sym = decode(lit)
          if (sym < 256) {
            emit(sym)
          } else if (sym === 256) {
            break
          } else {
            const li = sym - 257
            if (li >= 29) throw new InflateError('invalid length symbol')
            const len = LENGTH_BASE[li] + bits(LENGTH_EXTRA[li])
            if (dist.max === 0) throw new InflateError('no distance codes')
            const ds = decode(dist)
            if (ds >= 30) throw new InflateError('invalid distance symbol')
            const d = DIST_BASE[ds] + bits(DIST_EXTRA[ds])
            if (d > total) throw new InflateError('distance too far back')
            for (let k = 0; k < len; k++) emit(ring[(w - d) & 0xFFFF])
          }
          if ((++symbols & 0xFFFF) === 0 && Date.now() > deadline) return { status: 'timeout', outSize: total }
        }
      }
      if (Date.now() > deadline) return { status: 'timeout', outSize: total }
    } while (!final)
  } catch (error) {
    if (error === NEED_MORE) return { status: 'more', outSize: total }
    if (error instanceof InflateError) return { status: 'error', reason: error.message, outSize: total }
    throw error
  }
  flush()
  return { status: 'ok', end: p - (bc >> 3), outSize: total, check }
}
