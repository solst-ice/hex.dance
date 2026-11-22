// Helpers for the three things a parser can say beyond its field tree: where
// a pointer field points (`Field.target`), how the file is laid out in memory
// (`Analysis.image`) and what about it is unusual (`Analysis.unusual`).
// analyzeBytes checks all of it again, so these only keep the parsers short.

const asNumber = value => (typeof value === 'bigint' ? Number(value) : value)

/**
 * Sets `target` on a field when `target` is a file offset inside the file;
 * leaves the field alone otherwise. A field that gains a target and has no
 * kind, or the generic 'data', becomes an 'offset'.
 * @returns the field
 */
export function pointAt(node, target, size) {
  const at = asNumber(target)
  if (node && Number.isSafeInteger(at) && at >= 0 && at < size) {
    node.target = at
    if (!node.kind || node.kind === 'data') node.kind = 'offset'
  }
  return node
}

/** Calls pointAt on each field of `nodes` whose name is a key of `targets`. */
export function pointNamed(nodes, targets, size) {
  if (!nodes) return nodes
  for (const node of nodes) {
    if (node && Object.prototype.hasOwnProperty.call(targets, node.name)) pointAt(node, targets[node.name], size)
  }
  return nodes
}

/** The first field of `nodes` with this name, or null. */
export function childNamed(nodes, name) {
  if (!nodes) return null
  for (const node of nodes) if (node && node.name === name) return node
  return null
}

/** 'rwx'-style flags. */
export const rwx = (read, write, exec) => `${read ? 'r' : '-'}${write ? 'w' : '-'}${exec ? 'x' : '-'}`

/** Sections the loader places in memory, capped as the Analysis type says. */
export const MAX_IMAGE_SECTIONS = 1024

/** The most notes analyzeBytes keeps for one file. */
export const MAX_UNUSUAL = 12

/** A note, with the bytes that show it when there is one place. */
export function unusualNote(text, offset, length) {
  const note = { text }
  if (Number.isSafeInteger(offset) && offset >= 0) {
    note.offset = offset
    if (Number.isSafeInteger(length) && length > 0) note.length = length
  }
  return note
}

/** Whether a number is a safe, non-negative integer (addresses, sizes). */
export const isAddress = value => Number.isSafeInteger(value) && value >= 0

/** 0x-prefixed uppercase hex, for numbers in notes. */
export const hexText = value => `0x${value.toString(16).toUpperCase()}`
