// Walks a raw DEFLATE stream (RFC 1951) to find where it ends and how much
// data it expands to, without producing the output: literals and
// back-references are decoded only to count them. Used by the gzip parser to
// find member boundaries and check the trailer.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

class DeflateError extends Error {}

// Lookup table indexed by the next `bits` input bits (LSB first); each entry
// is symbol << 4 | code length, or 0 for an unused code.
function buildTable(lengths, count) {
  let maxBits = 0
  for (let i = 0; i < count; i++) if (lengths[i] > maxBits) maxBits = lengths[i]
  if (maxBits === 0) return { table: new Uint32Array(1), bits: 0 }
  const blCount = new Uint16Array(16)
  for (let i = 0; i < count; i++) blCount[lengths[i]]++
  blCount[0] = 0
  const nextCode = new Uint16Array(16)
  let code = 0
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + blCount[bits - 1]) << 1
    nextCode[bits] = code
  }
  const size = 1 << maxBits
  const table = new Uint32Array(size)
  for (let symbol = 0; symbol < count; symbol++) {
    const length = lengths[symbol]
    if (length === 0) continue
    let value = nextCode[length]++
    if (value >= 1 << length) throw new DeflateError('over-subscribed Huffman code')
    let reversed = 0
    for (let i = 0; i < length; i++) {
      reversed = (reversed << 1) | (value & 1)
      value >>= 1
    }
    for (let i = reversed; i < size; i += 1 << length) table[i] = (symbol << 4) | length
  }
  return { table, bits: maxBits }
}

let fixedTables = null
function fixed() {
  if (!fixedTables) {
    const lit = new Uint8Array(288)
    lit.fill(8, 0, 144)
    lit.fill(9, 144, 256)
    lit.fill(7, 256, 280)
    lit.fill(8, 280, 288)
    const dist = new Uint8Array(30).fill(5)
    fixedTables = { lit: buildTable(lit, 288), dist: buildTable(dist, 30) }
  }
  return fixedTables
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start  offset of the first DEFLATE byte
 * @param {number} limit  give up (status 'limit') after this many input bytes
 * @returns {{ status: 'ok' | 'truncated' | 'error' | 'limit', end: number, size: number, blocks: number, message?: string }}
 *   `end` is the offset just past the final block (rounded up to a byte)
 */
export function walkDeflate(bytes, start, limit = Infinity) {
  const length = bytes.length
  const stop = Math.min(length, start + limit)
  let pos = start
  let bitBuf = 0
  let bitCount = 0
  let size = 0
  let blocks = 0

  const need = n => {
    while (bitCount < n) {
      if (pos >= length) throw new RangeError('truncated')
      if (pos >= stop) throw new EvalError('limit')
      bitBuf |= bytes[pos++] << bitCount
      bitCount += 8
    }
  }
  const bits = n => {
    if (n === 0) return 0
    need(n)
    const value = bitBuf & ((1 << n) - 1)
    bitBuf >>>= n
    bitCount -= n
    return value
  }
  // Fills as many bits as available up to `n`, so codes near the end decode
  const peek = n => {
    while (bitCount < n && pos < length && pos < stop) {
      bitBuf |= bytes[pos++] << bitCount
      bitCount += 8
    }
    return bitBuf & ((1 << n) - 1)
  }
  const decode = ({ table, bits: tableBits }) => {
    if (tableBits === 0) throw new DeflateError('empty Huffman code used')
    const entry = table[peek(tableBits)]
    const codeLength = entry & 15
    if (codeLength === 0) throw new DeflateError('invalid Huffman code')
    if (codeLength > bitCount) {
      if (pos >= length) throw new RangeError('truncated')
      throw new EvalError('limit')
    }
    bitBuf >>>= codeLength
    bitCount -= codeLength
    return entry >> 4
  }

  try {
    let final = 0
    while (!final) {
      final = bits(1)
      const type = bits(2)
      blocks++
      if (type === 0) {
        bitBuf = 0
        bitCount = 0
        if (pos + 4 > length) throw new RangeError('truncated')
        const len = bytes[pos] | (bytes[pos + 1] << 8)
        const nlen = bytes[pos + 2] | (bytes[pos + 3] << 8)
        if ((len ^ 0xFFFF) !== nlen) throw new DeflateError('stored block length check failed')
        pos += 4 + len
        if (pos > length) throw new RangeError('truncated')
        if (pos > stop) throw new EvalError('limit')
        size += len
        continue
      }
      if (type === 3) throw new DeflateError('invalid block type')
      let lit
      let dist
      if (type === 1) {
        ({ lit, dist } = fixed())
      } else {
        const hlit = bits(5) + 257
        const hdist = bits(5) + 1
        const hclen = bits(4) + 4
        const codeLengths = new Uint8Array(19)
        for (let i = 0; i < hclen; i++) codeLengths[CODE_LENGTH_ORDER[i]] = bits(3)
        const clTable = buildTable(codeLengths, 19)
        const lengths = new Uint8Array(hlit + hdist)
        for (let i = 0; i < hlit + hdist;) {
          const symbol = decode(clTable)
          if (symbol < 16) {
            lengths[i++] = symbol
            continue
          }
          let repeat
          let value = 0
          if (symbol === 16) {
            if (i === 0) throw new DeflateError('repeat with no previous length')
            value = lengths[i - 1]
            repeat = 3 + bits(2)
          } else if (symbol === 17) {
            repeat = 3 + bits(3)
          } else {
            repeat = 11 + bits(7)
          }
          if (i + repeat > hlit + hdist) throw new DeflateError('too many code lengths')
          lengths.fill(value, i, i + repeat)
          i += repeat
        }
        if (lengths[256] === 0) throw new DeflateError('no end-of-block code')
        lit = buildTable(lengths.subarray(0, hlit), hlit)
        dist = buildTable(lengths.subarray(hlit), hdist)
      }
      for (;;) {
        const symbol = decode(lit)
        if (symbol < 256) {
          size++
        } else if (symbol === 256) {
          break
        } else {
          const index = symbol - 257
          if (index >= 29) throw new DeflateError('invalid length code')
          size += LENGTH_BASE[index] + bits(LENGTH_EXTRA[index])
          const distSymbol = decode(dist)
          if (distSymbol >= 30) throw new DeflateError('invalid distance code')
          bits(DIST_EXTRA[distSymbol])
        }
      }
    }
    // Unused bits of the last byte are padding; return whole bytes still buffered
    const end = pos - (bitCount >> 3)
    return { status: 'ok', end, size, blocks }
  } catch (err) {
    if (err instanceof RangeError) return { status: 'truncated', end: length, size, blocks }
    if (err instanceof EvalError) return { status: 'limit', end: pos, size, blocks }
    if (err instanceof DeflateError) return { status: 'error', end: pos, size, blocks, message: err.message }
    throw err
  }
}
