// Text for the comparison: verdicts, numbers and the exported list.

export const EXPORT_CAP = 10000
export const EXPORT_BYTES = 32

const count = (n) => n.toLocaleString('en-US')

export const hexOffset = (n, digits = 8) => '0x' + n.toString(16).toUpperCase().padStart(digits, '0')

export const offsetDigits = (size) => Math.max(8, Math.max(0, size - 1).toString(16).length)

export function plural(n, one, many = one + 's') {
  return `${count(n)} ${n === 1 ? one : many}`
}

export function sizeText(n) {
  if (n < 1024) return plural(n, 'byte')
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]} (${plural(n, 'byte')})`
}

/** Percentage of `part` in `total`, never rounded to 0% or 100% unless exact. */
export function percent(part, total) {
  if (total <= 0 || part >= total) return '100%'
  if (part <= 0) return '0%'
  const value = (part / total) * 100
  if (value >= 99.99) return '>99.99%'
  if (value < 0.01) return '<0.01%'
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`
}

/** Bytes as spaced hex, `max` bytes at most, with a marker for the rest. */
export function hexPreview(bytes, start, end, max = 8) {
  const stop = Math.min(end, bytes.length, start + max)
  const parts = []
  for (let i = start; i < stop; i++) parts.push(bytes[i].toString(16).padStart(2, '0'))
  if (end > stop && stop >= start) parts.push('…')
  return parts.join(' ')
}

/**
 * @param {import('./diff.js').DiffStats} stats
 * @returns {{ kind: 'identical'|'same-size'|'prefix'|'different-size', title: string, detail: string }}
 */
export function verdict(stats) {
  const { sizeA, sizeB, diffBytes, rangeCount } = stats
  const ranges = `${plural(diffBytes, 'differing byte')} in ${plural(rangeCount, 'range')}`
  if (sizeA === sizeB) {
    if (diffBytes === 0) {
      return { kind: 'identical', title: 'Identical', detail: sizeA === 0 ? 'Both files are empty.' : `Both files hold the same ${plural(sizeA, 'byte')}.` }
    }
    return { kind: 'same-size', title: 'Same size, different content', detail: `${ranges}.` }
  }
  const longer = sizeA > sizeB ? 'A' : 'B'
  const shorter = longer === 'A' ? 'B' : 'A'
  const extra = Math.abs(sizeA - sizeB)
  if (diffBytes === 0) {
    const detail = Math.min(sizeA, sizeB) === 0
      ? `${shorter} is empty; ${longer} has ${plural(extra, 'byte')}.`
      : `${shorter} is a prefix of ${longer}: ${longer} has ${plural(extra, 'more byte')} at the end.`
    return { kind: 'prefix', title: 'Different sizes', detail }
  }
  return {
    kind: 'different-size',
    title: 'Different sizes',
    detail: `${longer} is ${plural(extra, 'byte')} longer, and the first ${plural(Math.min(sizeA, sizeB), 'byte')} have ${ranges}.`
  }
}

/**
 * One-line description of a confirmed shift.
 * @param {{ shift: number, from: number, to: number, exact: boolean, mixed: boolean }} shift
 */
export function shiftText({ shift, from, to, exact, mixed }) {
  const n = plural(Math.abs(shift), 'byte')
  const where = `${hexOffset(from)}–${hexOffset(to)}`
  if (shift > 0) {
    if (exact) return `B has ${n} inserted at ${hexOffset(from)}`
    if (mixed) return `B has about ${n} inserted around ${where}, where other bytes changed too`
    return `B has ${n} inserted somewhere in ${where} (inside a run of repeated bytes, so the exact point cannot be told)`
  }
  if (exact) return `B has ${n} removed at ${hexOffset(from)} (A has them at ${hexOffset(from)}–${hexOffset(from - shift - 1)})`
  if (mixed) return `B lacks about ${n} of A around ${where}, where other bytes changed too`
  return `B has ${n} removed somewhere in ${where} (inside a run of repeated bytes, so the exact point cannot be told)`
}

/**
 * The list of differences as plain text.
 * @param {Object} options
 * @param {{ name: string, bytes: Uint8Array }} options.a
 * @param {{ name: string, bytes: Uint8Array }} options.b
 * @param {import('./diff.js').DiffStats} options.stats
 * @param {{ starts: ArrayLike<number>, ends: ArrayLike<number>, length: number }} options.ranges
 * @param {{ shift: number, at: number } | null} [options.shift]
 * @param {number} [options.cap]
 */
export function exportText({ a, b, stats, ranges, shift = null, cap = EXPORT_CAP }) {
  const digits = offsetDigits(Math.max(stats.sizeA, stats.sizeB))
  const lines = [
    `# A: ${a.name} (${plural(stats.sizeA, 'byte')})`,
    `# B: ${b.name} (${plural(stats.sizeB, 'byte')})`,
    `# ${verdict(stats).title}: ${verdict(stats).detail}`,
    `# Ranges merge differences separated by up to ${plural(stats.gap, 'equal byte')}.`
  ]
  if (shift) lines.push(`# ${shiftText(shift)}.`)
  const shown = Math.min(cap, ranges.length)
  if (shown < stats.rangeCount) lines.push(`# Showing the first ${count(shown)} of ${count(stats.rangeCount)} ranges.`)
  const previews = []
  let width = 2
  for (let i = 0; i < shown; i++) {
    const preview = hexPreview(a.bytes, ranges.starts[i], ranges.ends[i], EXPORT_BYTES)
    previews.push(preview)
    width = Math.max(width, preview.length + 2)
  }
  if (shown > 0) {
    lines.push('')
    lines.push(['offset'.padEnd(digits + 2), 'length'.padStart(10), '  ', 'A'.padEnd(width), 'B'].join(''))
  }
  for (let i = 0; i < shown; i++) {
    const start = ranges.starts[i]
    const end = ranges.ends[i]
    lines.push([
      hexOffset(start, digits),
      String(end - start).padStart(10),
      '  ',
      previews[i].padEnd(width),
      hexPreview(b.bytes, start, end, EXPORT_BYTES)
    ].join('').trimEnd())
  }
  if (stats.sizeA !== stats.sizeB) {
    const longer = stats.sizeA > stats.sizeB ? 'A' : 'B'
    lines.push('')
    lines.push(`# Only in ${longer}: ${hexOffset(stats.common, digits)}–${hexOffset(Math.max(stats.sizeA, stats.sizeB) - 1, digits)} (${plural(Math.abs(stats.sizeA - stats.sizeB), 'byte')})`)
  }
  return lines.join('\n') + '\n'
}
