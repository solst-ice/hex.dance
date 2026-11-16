// Field-tree helpers shared by the ELF, PE and Mach-O parsers. Every read is
// bounds-checked: a struct is decoded member by member and stops at the first
// member that does not fit in the file, so truncated input yields a shorter
// tree instead of an exception.

/** Total field nodes one parse may produce, so the result stays cheap to post from a worker */
export const MAX_FIELD_NODES = 20000
/** Entries of one table (sections, load commands, …) decoded in full before the rest is summarised */
export const MAX_TABLE_ENTRIES = 512

export function createBudget(max = MAX_FIELD_NODES) {
  return { left: max }
}

/**
 * Builds a Field, dropping empty optional keys.
 * @returns {import('../analysis/types.js').Field}
 */
export function field(name, offset, length, value, kind, description, children) {
  const result = { name, offset, length }
  if (value !== undefined && value !== null && value !== '') result.value = String(value)
  if (description) result.description = description
  if (kind) result.kind = kind
  if (children && children.length) result.children = children
  return result
}

export function hexBig(value) {
  return `0x${value.toString(16).toUpperCase()}`
}

/** Reads an unsigned integer of 1, 2, 4 or 8 bytes; 8-byte values come back as BigInt */
export function readUint(view, offset, size, le) {
  switch (size) {
    case 1: return view.getUint8(offset)
    case 2: return view.getUint16(offset, le)
    case 4: return view.getUint32(offset, le)
    case 8: return view.getBigUint64(offset, le)
    default: throw new Error(`unsupported integer size ${size}`)
  }
}

/** Number for values below 2^53, otherwise the closest double; for offsets and sizes that is still out of any file */
export const toNumber = value => (typeof value === 'bigint' ? Number(value) : value)

const defaultFormat = (kind, value) => {
  if (kind === 'count' || (kind === 'size' && value < 0x10000)) return String(value)
  return hexBig(value)
}

/**
 * Decodes a struct described by `spec`, a list of members
 * `[name, size, kind, description, format?]`. `size` may be 0 to skip a
 * member. `format(value)` returns the displayed value (value is a Number, or
 * a BigInt for 8-byte members). Members of any other size are byte arrays:
 * `format(offset)` may describe them. Returns the field nodes and the decoded
 * values by member name; members past `limit` (default: the end of the file)
 * are omitted.
 */
export function readStruct(view, base, spec, le, budget, limit = view.byteLength) {
  const children = []
  const values = {}
  let offset = base
  const end = Math.min(limit, view.byteLength)
  for (const [name, size, kind, description, format] of spec) {
    if (!size) continue
    if (offset < 0 || offset + size > end) break
    if (size !== 1 && size !== 2 && size !== 4 && size !== 8) {
      // Byte arrays (reserved words, fixed-size names) are shown without a decoded number
      if (!budget || budget.left-- > 0) {
        const shown = format ? format(offset) : undefined
        children.push(field(name, offset, size, shown, kind, description))
      }
      offset += size
      continue
    }
    const raw = readUint(view, offset, size, le)
    values[name] = raw
    if (!budget || budget.left > 0) {
      if (budget) budget.left--
      let shown
      try {
        shown = format ? format(raw) : defaultFormat(kind, raw)
      } catch {
        shown = hexBig(raw)
      }
      children.push(field(name, offset, size, shown, kind, description))
    }
    offset += size
  }
  return { children, values, end: offset }
}

/** Size in bytes of a struct spec */
export function structSize(spec) {
  return spec.reduce((sum, member) => sum + member[1], 0)
}

/**
 * Builds the nodes of a table of `count` equally sized entries starting at
 * `offset`. Entries are decoded by `entry(index, at)` (returning a Field or
 * null) until the per-table cap or the node budget runs out; the remainder is
 * covered by one summary node so the tree still accounts for every byte.
 */
export function tableNodes(view, offset, count, entrySize, budget, entry, noun = 'entries') {
  const nodes = []
  const fits = entrySize > 0 ? Math.max(0, Math.floor((view.byteLength - offset) / entrySize)) : 0
  const total = Math.min(count, fits)
  let i = 0
  for (; i < total && i < MAX_TABLE_ENTRIES && budget.left > 0; i++) {
    const node = entry(i, offset + i * entrySize)
    if (node) nodes.push(node)
  }
  if (i < total) {
    budget.left--
    nodes.push(field(`${total - i} more ${noun}`, offset + i * entrySize, (total - i) * entrySize, undefined, 'data',
      'Not decoded individually to keep the tree small'))
  }
  return nodes
}

/** Uses `entries`' total length when building a parent node around them */
export function spanOf(nodes, fallbackOffset) {
  if (!nodes.length) return { offset: fallbackOffset, length: 0 }
  const start = nodes[0].offset
  const last = nodes[nodes.length - 1]
  return { offset: start, length: last.offset + last.length - start }
}

/**
 * Turns possibly overlapping, unsorted regions into a sorted list without
 * overlaps (later, narrower regions are trimmed against earlier ones) and
 * fills the gaps between them with `gapName` regions.
 */
export function tileRegions(regions, size, gapName = 'Unmapped bytes', bytes = null) {
  const sorted = regions
    .filter(r => r && Number.isSafeInteger(r.offset) && r.offset >= 0 && r.offset < size && r.length > 0)
    .map(r => ({ ...r, length: Math.min(r.length, size - r.offset) }))
    .sort((a, b) => a.offset - b.offset || b.length - a.length)
  const result = []
  let cursor = 0
  const gap = (from, to) => {
    if (to <= from) return
    result.push({ name: gapName, offset: from, length: to - from, kind: isZeroFilled(bytes, from, to) ? 'padding' : 'other' })
  }
  for (const region of sorted) {
    const end = region.offset + region.length
    if (end <= cursor) continue
    const start = Math.max(region.offset, cursor)
    gap(cursor, start)
    result.push({ ...region, offset: start, length: end - start })
    cursor = end
  }
  gap(cursor, size)
  return result
}

const ZERO_CHECK_LIMIT = 1 << 16

function isZeroFilled(bytes, from, to) {
  if (!bytes || to - from > ZERO_CHECK_LIMIT) return false
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false
  return true
}

/** Bytes from `view` as an uppercase hex string, for IDs such as build IDs and UUIDs */
export function hexString(view, offset, length) {
  let out = ''
  const end = Math.min(offset + length, view.byteLength)
  for (let i = offset; i < end; i++) out += view.getUint8(i).toString(16).padStart(2, '0')
  return out
}
