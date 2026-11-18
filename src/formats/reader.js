// Low-level helpers for the format parsers added alongside `shared.js`:
// bounds-safe integer reads, field builders that keep trees tidy and small
// formatting helpers. Everything here is pure and works on any length.

import { dataView } from './shared.js'
import { chargeRows, chargeText, refundRows, tick } from './budget.js'

/**
 * Bounds-safe reads over a Uint8Array. Reads past the end return 0, so
 * callers must check `has` before trusting a value that decides control flow.
 */
export class ByteReader {
  constructor(bytes, little = true) {
    this.bytes = bytes
    this.view = dataView(bytes)
    this.length = bytes.length
    this.little = little
  }

  has(offset, length = 1) {
    tick()
    return Number.isSafeInteger(offset) && offset >= 0 && length >= 0 && offset + length <= this.length
  }

  u8(offset) {
    return this.has(offset, 1) ? this.bytes[offset] : 0
  }

  u16(offset, little = this.little) {
    return this.has(offset, 2) ? this.view.getUint16(offset, little) : 0
  }

  i16(offset, little = this.little) {
    return this.has(offset, 2) ? this.view.getInt16(offset, little) : 0
  }

  u24(offset, little = this.little) {
    if (!this.has(offset, 3)) return 0
    const b = this.bytes
    return little ? b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) : (b[offset] << 16) | (b[offset + 1] << 8) | b[offset + 2]
  }

  u32(offset, little = this.little) {
    return this.has(offset, 4) ? this.view.getUint32(offset, little) : 0
  }

  i32(offset, little = this.little) {
    return this.has(offset, 4) ? this.view.getInt32(offset, little) : 0
  }

  /** 64-bit unsigned as a Number; values above 2^53 lose precision but stay ordered */
  u64(offset, little = this.little) {
    if (!this.has(offset, 8)) return 0
    const a = this.view.getUint32(offset, little)
    const b = this.view.getUint32(offset + 4, little)
    return little ? b * 0x100000000 + a : a * 0x100000000 + b
  }

  /** 64-bit unsigned as a BigInt, for values that must be shown exactly */
  u64big(offset, little = this.little) {
    return this.has(offset, 8) ? this.view.getBigUint64(offset, little) : 0n
  }

  ascii(offset, length) {
    return latin1(this.bytes, offset, length)
  }
}

/** Builds a field, leaving out empty optional keys. */
export function field(name, offset, length, value, description, kind, children) {
  chargeRows()
  const result = { name, offset, length }
  if (value !== undefined && value !== null && value !== '') result.value = String(value)
  if (description) result.description = description
  if (kind) result.kind = kind
  if (children && children.length) result.children = children
  return result
}

/** A placeholder covering items that were left out, so the tree says so. */
export function moreField(count, offset, end, what = 'more') {
  return field(`… ${count.toLocaleString('en-US')} ${what} not shown`, offset, Math.max(1, end - offset), undefined, 'Left out to keep the tree readable', 'data')
}

// A field and its descendants
function countRows(entry) {
  let count = 1
  if (entry && entry.children) for (const child of entry.children) count += countRows(child)
  return count
}

/**
 * Keeps the first `max` fields and folds the rest into one "… N more not
 * shown" field spanning them. `extraCount` adds items that were counted but
 * never built (their span is taken up to `extraEnd`).
 */
export function capFields(fields, max, what = 'more', extraCount = 0, extraEnd = 0) {
  if (fields.length <= max && extraCount === 0) return fields
  const kept = fields.slice(0, max)
  const hidden = fields.slice(max)
  let start = Infinity
  let end = 0
  for (const hiddenField of hidden) {
    refundRows(countRows(hiddenField))
    start = Math.min(start, hiddenField.offset)
    end = Math.max(end, hiddenField.offset + hiddenField.length)
  }
  if (extraCount > 0) {
    if (start === Infinity) {
      const last = kept[kept.length - 1]
      start = last ? last.offset + last.length : extraEnd
    }
    end = Math.max(end, extraEnd)
  }
  const count = hidden.length + extraCount
  if (count > 0 && end > start) kept.push(moreField(count, start, end, what))
  return kept
}

/**
 * Sorts fields by offset and drops any that overlap an earlier one. Used for
 * top-level lists built from offsets a file controls, which a hostile file
 * can make collide.
 */
export function nonOverlapping(fields) {
  const sorted = [...fields].sort((a, b) => a.offset - b.offset || b.length - a.length)
  const result = []
  let end = 0
  for (const entry of sorted) {
    if (entry.length <= 0 || entry.offset < end) continue
    result.push(entry)
    end = entry.offset + entry.length
  }
  return result
}

/** Clamps a [offset, offset + length) range to the file. */
export function clampLength(offset, length, size) {
  if (offset >= size) return 0
  return Math.max(0, Math.min(length, size - offset))
}

/** Replaces control characters so a value stays on one line. */
export function printable(text, max = 200) {
  let clean = ''
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code === 0x0A || code === 0x0D || code === 0x09) clean += ' '
    else clean += code < 0x20 || (code >= 0x7F && code <= 0x9F) ? '�' : ch
    if (clean.length > max) break
  }
  clean = clean.replace(/ {2,}/g, ' ')
  chargeText(clean.length)
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

export function latin1(bytes, offset, length) {
  let out = ''
  const end = Math.min(bytes.length, offset + length)
  chargeText(Math.max(0, end - Math.max(0, offset)))
  for (let i = Math.max(0, offset); i < end; i++) out += String.fromCharCode(bytes[i])
  return out
}

/** Four-character code as printable text, e.g. 'ftyp' */
export function fourcc(bytes, offset) {
  chargeText(4)
  let out = ''
  for (let i = offset; i < offset + 4 && i < bytes.length; i++) {
    const c = bytes[i]
    out += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : c >= 0xA0 ? String.fromCharCode(c) : '.'
  }
  return out
}

const utf8Decoder = new TextDecoder('utf-8')

export function utf8(bytes, offset, length) {
  const start = Math.max(0, offset)
  const end = Math.min(bytes.length, offset + length)
  chargeText(Math.max(0, end - start))
  return end > start ? utf8Decoder.decode(bytes.subarray(start, end)) : ''
}

export function utf16(bytes, offset, length, little) {
  let out = ''
  const end = Math.min(bytes.length, offset + length) - 1
  chargeText(Math.max(0, (end + 1 - Math.max(0, offset)) >> 1))
  for (let i = Math.max(0, offset); i < end; i += 2) {
    out += String.fromCharCode(little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1])
  }
  return out
}

/** Trims trailing NULs and spaces from a fixed-width text field. */
export function trimField(text) {
  return text.replace(/[\0 ]+$/, '')
}

export function hex32(value) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

/** Unsigned LEB128 (WebAssembly, DWARF). Returns null when malformed or truncated. */
export function readULEB(bytes, offset, end = bytes.length, maxBytes = 10) {
  tick()
  let value = 0
  let scale = 1
  for (let i = 0; i < maxBytes; i++) {
    const position = offset + i
    if (position >= end || position >= bytes.length) return null
    const byte = bytes[position]
    value += (byte & 0x7F) * scale
    scale *= 128
    if ((byte & 0x80) === 0) return { value, next: position + 1 }
  }
  return null
}

/** Seconds as '1:02:03.45' or '12.34 s' */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
  if (seconds < 60) return `${+seconds.toFixed(seconds < 10 ? 3 : 2)} s`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const secs = rest.toFixed(2).padStart(5, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`
}

/** A Date as 'YYYY-MM-DD HH:MM:SS UTC', or 'invalid' */
export function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'invalid'
  const year = date.getUTCFullYear()
  if (year < 0 || year > 9999) return 'invalid'
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

/** Unix seconds as a date string */
export function unixDate(seconds) {
  return formatDate(new Date(seconds * 1000))
}

export function plural(count, word, many = `${word}s`) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? word : many}`
}

export function formatNumber(value) {
  return typeof value === 'bigint' ? value.toString() : Number(value).toLocaleString('en-US')
}

/** Formats a GUID stored in the mixed-endian Microsoft layout */
export function guid(bytes, offset) {
  const h = (i) => bytes[offset + i].toString(16).toUpperCase().padStart(2, '0')
  if (offset + 16 > bytes.length) return ''
  return `${h(3)}${h(2)}${h(1)}${h(0)}-${h(5)}${h(4)}-${h(7)}${h(6)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`
}

/**
 * Clips every field to its parent's range (the file for top-level fields)
 * and drops fields left empty, so a truncated file never yields a field that
 * points past the end of the data it describes.
 */
export function fitFields(fields, start, end) {
  const out = []
  for (const entry of fields) {
    if (!entry || !Number.isFinite(entry.offset) || !Number.isFinite(entry.length)) continue
    const from = Math.max(entry.offset, start)
    const to = Math.min(entry.offset + entry.length, end)
    if (to <= from) continue
    const fitted = { ...entry, offset: from, length: to - from }
    if (entry.children) {
      const children = fitFields(entry.children, from, to)
      if (children.length) fitted.children = children
      else delete fitted.children
    }
    out.push(fitted)
  }
  return out
}

/** Wraps a parser so its fields are always fitted to the file */
export function fitted(parse) {
  return (bytes, meta) => {
    const result = parse(bytes, meta)
    if (result && Array.isArray(result.fields)) result.fields = fitFields(result.fields, 0, bytes.length)
    return result
  }
}
