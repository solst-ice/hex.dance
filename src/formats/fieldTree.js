// Helpers for building `fields` trees. Parsers run in a worker and the result
// is posted to the page, so lists are capped: past the cap, items are only
// counted and one placeholder field covers the bytes they occupy.

export const MAX_CHILDREN = 1000

/**
 * @param {string} name
 * @param {number} offset
 * @param {number} length
 * @param {Partial<import('../analysis/types.js').Field>} [rest]
 * @returns {import('../analysis/types.js').Field}
 */
export function field(name, offset, length, rest) {
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
    else this.skip(item.offset, item.length)
  }

  /** Counts an item that will not be shown. */
  skip(offset, length) {
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
  for (let i = start; i < end; i++) {
    const b = bytes[i]
    out += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.'
  }
  return length > max ? out + '…' : out
}

/** Text for display: control characters removed, length capped. */
export function clip(text, max = 120) {
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

let crcTable = null

/** CRC-32 (ISO-HDLC, as in PNG and ZIP) of bytes[start, end) */
export function crc32(bytes, start, end) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = -1
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
