// Helpers for building `fields` trees. Parsers run in a worker and the result
// is posted to the page, so lists are capped: past the cap, items are only
// counted and one placeholder field covers the bytes they occupy.

import { chargeRows, chargeText, refundRows, tick } from './budget.js'

export const MAX_CHILDREN = 1000

/**
 * @param {string} name
 * @param {number} offset
 * @param {number} length
 * @param {Partial<import('../analysis/types.js').Field>} [rest]
 * @returns {import('../analysis/types.js').Field}
 */
export function field(name, offset, length, rest) {
  chargeRows()
  const out = { name, offset, length }
  if (rest) {
    for (const key of Object.keys(rest)) {
      const value = rest[key]
      if (value === undefined || value === null) continue
      if (key === 'children' && value.length === 0) continue
      out[key] = key === 'value' ? String(value) : value
    }
  }
  return out
}

// A field and its descendants
function countRows(item) {
  let count = 1
  if (item && item.children) for (const child of item.children) count += countRows(child)
  return count
}

/** Children of one node, kept in file order, with at most `limit` entries. */
export class FieldList {
  constructor(limit = MAX_CHILDREN, noun = 'items') {
    this.items = []
    this.limit = limit
    this.noun = noun
    this.hidden = 0
    this.hiddenStart = 0
    this.hiddenEnd = 0
  }

  /** True once further items are only counted; check before building expensive children. */
  get full() {
    return this.items.length >= this.limit
  }

  get count() {
    return this.items.length + this.hidden
  }

  push(item) {
    if (!this.full) this.items.push(item)
    else {
      refundRows(countRows(item))
      this.skip(item.offset, item.length)
    }
  }

  /** Counts an item that will not be shown. */
  skip(offset, length) {
    tick()
    if (this.hidden === 0) {
      this.hiddenStart = offset
      this.hiddenEnd = offset + length
    } else {
      this.hiddenStart = Math.min(this.hiddenStart, offset)
      this.hiddenEnd = Math.max(this.hiddenEnd, offset + length)
    }
    this.hidden++
  }

  toArray() {
    if (this.hidden === 0) return this.items
    return [...this.items, field(`… ${this.hidden.toLocaleString('en-US')} more not shown`, this.hiddenStart, this.hiddenEnd - this.hiddenStart, {
      kind: 'data',
      description: `${this.hidden.toLocaleString('en-US')} more ${this.noun} are not listed individually to keep the tree small`
    })]
  }
}

/** Printable ASCII for display; other bytes become '.' */
export function printable(bytes, start, length, max = 64) {
  let out = ''
  const end = Math.min(bytes.length, start + Math.min(length, max))
  chargeText(Math.max(0, end - start))
  for (let i = start; i < end; i++) {
    const b = bytes[i]
    out += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.'
  }
  return length > max ? out + '…' : out
}

/** Text for display: control characters removed, length capped. */
export function clip(text, max = 120) {
  chargeText(Math.min(text.length, max))
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    out += code < 0x20 || code === 0x7F ? ' ' : ch
    if (out.length > max) return out.slice(0, max) + '…'
  }
  return out
}

export function plural(n, noun, nouns = noun + 's') {
  return `${n.toLocaleString('en-US')} ${n === 1 ? noun : nouns}`
}

export function hexOffset(n) {
  return `0x${n.toString(16).toUpperCase()}`
}
