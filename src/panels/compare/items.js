// The list of differences: the stored ranges, then the bytes only one file
// has (when the sizes differ) as one last item.

export const HIGHLIGHT_CAP = 2000
const HIGHLIGHT_STEP = 250

/**
 * @typedef {{ start: number, end: number, diffs: number, kind: 'range'|'tail', only?: 'A'|'B' }} Item
 * @typedef {{ starts: ArrayLike<number>, ends: ArrayLike<number>, diffs?: ArrayLike<number>, length: number }} Ranges
 */

export function hasTail(stats) {
  return Boolean(stats) && stats.sizeA !== stats.sizeB
}

export function itemCount(stats, ranges) {
  return ranges.length + (hasTail(stats) ? 1 : 0)
}

/** @returns {Item|null} */
export function itemAt(stats, ranges, index) {
  if (index < 0) return null
  if (index < ranges.length) {
    return { start: ranges.starts[index], end: ranges.ends[index], diffs: ranges.diffs ? ranges.diffs[index] : 0, kind: 'range' }
  }
  if (index === ranges.length && hasTail(stats)) {
    const end = Math.max(stats.sizeA, stats.sizeB)
    return { start: stats.common, end, diffs: end - stats.common, kind: 'tail', only: stats.sizeA > stats.sizeB ? 'A' : 'B' }
  }
  return null
}

/** Index of the first stored range ending after `offset` (ranges.length when none). */
export function rangeAfter(ranges, offset) {
  let lo = 0
  let hi = ranges.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ranges.ends[mid] <= offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The item at or after `offset`, else the last item before it; -1 when the
 * list is empty.
 */
export function itemNear(stats, ranges, offset) {
  const count = itemCount(stats, ranges)
  if (count === 0) return -1
  const index = rangeAfter(ranges, offset)
  if (index < ranges.length) return index
  return count - 1
}

/**
 * Highlights for the ranges nearest `offset`, at most `cap`. The window moves
 * in steps so scrolling a little does not replace the highlights.
 * @returns {{ key: string, from: number, to: number }}
 */
export function highlightWindow(ranges, offset, cap = HIGHLIGHT_CAP) {
  if (ranges.length <= cap) return { key: 'all', from: 0, to: ranges.length }
  const center = Math.floor(rangeAfter(ranges, offset) / HIGHLIGHT_STEP) * HIGHLIGHT_STEP
  const from = Math.max(0, Math.min(ranges.length - cap, center - Math.floor(cap / 2)))
  return { key: String(from), from, to: from + cap }
}
