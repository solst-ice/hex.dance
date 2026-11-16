// Turns what the user typed into byte patterns for the scanner.
//
// A pattern is { label, values, alt, mask }: at position i a byte matches when
// mask[i] is 0 (wildcard) or it equals values[i] or alt[i] (alt is the other
// letter case, or the same value).

/**
 * @typedef {Object} Pattern
 * @property {string} label
 * @property {Uint8Array} values
 * @property {Uint8Array} alt
 * @property {Uint8Array} mask
 *
 * @typedef {{ ok: true, patterns: Pattern[] } | { ok: false, error: string, empty?: boolean }} ParseResult
 */

export const MAX_PATTERN_BYTES = 1024

function makePattern(label, values, mask = null, alt = null) {
  return {
    label,
    values,
    alt: alt || values,
    mask: mask || new Uint8Array(values.length).fill(1)
  }
}

/** @returns {ParseResult} */
export function parseHex(input) {
  const text = String(input).replace(/0x(?=[0-9a-f?])/gi, '').replace(/[\s,]+/g, '')
  if (!text) return { ok: false, error: 'Type hex bytes, for example 7f 45 4c 46 or ffd8ff??', empty: true }
  const bad = text.match(/[^0-9a-f?]/i)
  if (bad) return { ok: false, error: `"${bad[0]}" is not a hex digit or ?? wildcard` }
  if (text.length % 2) return { ok: false, error: 'Odd number of hex digits: each byte needs two' }
  const n = text.length / 2
  if (n > MAX_PATTERN_BYTES) return { ok: false, error: `Patterns are limited to ${MAX_PATTERN_BYTES} bytes` }
  const values = new Uint8Array(n)
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const pair = text.slice(i * 2, i * 2 + 2)
    if (pair === '??') continue
    if (pair.includes('?')) return { ok: false, error: 'Wildcards cover whole bytes: use ?? not a single ?' }
    values[i] = parseInt(pair, 16)
    mask[i] = 1
  }
  if (!mask.some(Boolean)) return { ok: false, error: 'The pattern needs at least one byte that is not a wildcard' }
  return { ok: true, patterns: [makePattern('hex', values, mask)] }
}

function foldAscii(values) {
  const alt = new Uint8Array(values)
  for (let i = 0; i < alt.length; i++) {
    const b = alt[i]
    if (b >= 0x41 && b <= 0x5a) alt[i] = b + 0x20
    else if (b >= 0x61 && b <= 0x7a) alt[i] = b - 0x20
  }
  return alt
}

function utf16le(text) {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    out[i * 2] = unit & 0xff
    out[i * 2 + 1] = unit >> 8
  }
  return out
}

/**
 * @param {string} input
 * @param {{ utf8?: boolean, utf16?: boolean, ignoreCase?: boolean }} options
 * @returns {ParseResult}
 */
export function parseText(input, { utf8 = true, utf16 = true, ignoreCase = false } = {}) {
  const text = String(input)
  if (!text) return { ok: false, error: 'Type text to find', empty: true }
  if (!utf8 && !utf16) return { ok: false, error: 'Choose at least one encoding' }
  const patterns = []
  const add = (label, values) => {
    if (values.length > MAX_PATTERN_BYTES) return
    // Only A–Z fold: folding other letters byte by byte would also match
    // mixtures of the two encodings' bytes
    const alt = ignoreCase ? foldAscii(values) : null
    if (alt && label === 'UTF-16LE') {
      // Only code units 0x0041–0x007a are letters to fold; restore the rest
      for (let i = 0; i < alt.length; i += 2) {
        alt[i + 1] = values[i + 1]
        if (values[i + 1] !== 0) alt[i] = values[i]
      }
    }
    patterns.push(makePattern(label, values, null, alt))
  }
  if (utf8) add(/^[\x20-\x7e]*$/.test(text) ? 'ASCII' : 'UTF-8', new TextEncoder().encode(text))
  if (utf16) add('UTF-16LE', utf16le(text))
  if (!patterns.length) return { ok: false, error: `Patterns are limited to ${MAX_PATTERN_BYTES} bytes` }
  return { ok: true, patterns }
}

const WIDTHS = [8, 16, 32, 64]

/** @returns {bigint|null} */
export function parseNumber(input) {
  const text = String(input).trim().replace(/_/g, '')
  const match = text.match(/^([+-]?)(0x[0-9a-f]+|\d+)$/i)
  if (!match) return null
  const magnitude = BigInt(match[2])
  return match[1] === '-' ? -magnitude : magnitude
}

/** Two's-complement bytes of `value` in `width` bits, or null when it does not fit. */
export function encodeInteger(value, width, littleEndian) {
  const bits = BigInt(width)
  if (value < -(1n << (bits - 1n)) || value >= (1n << bits)) return null
  let v = BigInt.asUintN(width, value)
  const size = width / 8
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    out[littleEndian ? i : size - 1 - i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * @param {string} input
 * @param {{ widths?: number[], little?: boolean, big?: boolean }} options
 * @returns {ParseResult}
 */
export function parseNumberQuery(input, { widths = WIDTHS, little = true, big = true } = {}) {
  if (!String(input).trim()) return { ok: false, error: 'Type a number: decimal (1234, -5) or hex (0x4d2)', empty: true }
  const value = parseNumber(input)
  if (value === null) return { ok: false, error: 'Not a number: use decimal (1234, -5) or hex (0x4d2)' }
  if (!widths.length) return { ok: false, error: 'Choose at least one width' }
  if (!little && !big) return { ok: false, error: 'Choose at least one byte order' }
  const patterns = []
  // Longest first, so where encodings overlap the widest one names the match
  for (const width of [...widths].sort((a, b) => b - a)) {
    for (const littleEndian of [true, false]) {
      if (littleEndian ? !little : !big) continue
      const bytes = encodeInteger(value, width, littleEndian)
      if (!bytes) continue
      const label = width === 8 ? '8-bit' : `${width}-bit ${littleEndian ? 'LE' : 'BE'}`
      if (patterns.some(p => sameBytes(p.values, bytes))) continue
      patterns.push(makePattern(label, bytes))
    }
  }
  if (!patterns.length) {
    const largest = Math.max(...widths)
    return { ok: false, error: `${value} does not fit in ${largest} bits` }
  }
  return { ok: true, patterns }
}

/**
 * @param {'hex'|'text'|'number'} mode
 * @returns {ParseResult}
 */
export function parseQuery(mode, input, options = {}) {
  if (mode === 'text') return parseText(input, options)
  if (mode === 'number') return parseNumberQuery(input, options)
  return parseHex(input)
}

export function describePattern(pattern) {
  let text = ''
  for (let i = 0; i < pattern.values.length && i < 24; i++) {
    text += (i ? ' ' : '') + (pattern.mask[i] ? pattern.values[i].toString(16).padStart(2, '0') : '??')
  }
  return pattern.values.length > 24 ? `${text} …` : text
}
