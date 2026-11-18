// Helpers shared by the format parsers. Parsers receive a Uint8Array that may
// be a view into a larger buffer, so DataViews are always built from its
// buffer, byteOffset and byteLength.

import { chargeRows, chargeText } from './budget.js'

const MAX_STRING_LENGTH = 4096

export const MAX_SYMBOLS = 2000000

export function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

export function startsWith(bytes, signature) {
  if (bytes.length < signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false
  }
  return true
}

export function inBounds(view, offset, length) {
  return Number.isSafeInteger(offset) && offset >= 0 && offset + length <= view.byteLength
}

const utf8 = new TextDecoder()

export function readCString(view, offset, end = view.byteLength) {
  if (!Number.isSafeInteger(offset) || offset < 0) return ''
  const limit = Math.min(end, view.byteLength, offset + MAX_STRING_LENGTH)
  if (offset >= limit) return ''
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, limit - offset)
  const terminator = bytes.indexOf(0)
  const text = utf8.decode(terminator === -1 ? bytes : bytes.subarray(0, terminator))
  chargeText(text.length)
  return text
}

export function readFixedString(view, offset, length) {
  return readCString(view, offset, offset + length)
}

export function ascii(bytes, start, length) {
  chargeText(Math.max(0, Math.min(length, bytes.length - start)))
  let out = ''
  for (let i = start; i < start + length && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i])
  }
  return out
}

export function hex(value) {
  return `0x${value.toString(16).toUpperCase()}`
}

export function hexBytes(bytes, start, length) {
  chargeText(Math.max(0, Math.min(length, bytes.length - start)) * 2)
  let out = ''
  for (let i = start; i < start + length && i < bytes.length; i++) {
    out += bytes[i].toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

/**
 * Builds a summary item, dropping empty detail lines and empty optional keys.
 * @returns {import('../analysis/types.js').SummaryItem}
 */
export function item(label, value, details, group) {
  const result = { label, value: String(value) }
  const lines = details ? details.filter(Boolean) : []
  chargeRows(1 + lines.length)
  if (lines.length) result.details = lines
  if (group) result.group = group
  return result
}

/**
 * Sorts symbols by name ignoring case and leading underscores, so `_start`,
 * `main` and `__libc_start_main` sit where a reader would look for them.
 * Ties are broken by the full row text so the order is stable, and exact
 * duplicates (common in symbol tables) are listed once.
 * @param {import('../analysis/types.js').SymbolEntry[]} symbols
 */
export function sortSymbols(symbols) {
  const keyed = symbols.map(symbol => ({
    symbol,
    key: symbol.name.replace(/^_+/, '').toLowerCase(),
    row: `${symbol.name}\0${symbol.type}\0${symbol.address || ''}\0${symbol.note || ''}`
  }))
  keyed.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1
    if (a.row !== b.row) return a.row < b.row ? -1 : 1
    return 0
  })
  const result = []
  for (let i = 0; i < keyed.length; i++) {
    if (i > 0 && keyed[i].row === keyed[i - 1].row) continue
    result.push(keyed[i].symbol)
  }
  return result
}

export function decodeFlags(value, table) {
  return table.filter(([bit]) => (value & bit) !== 0).map(([, label]) => label)
}
