// Turns analysis regions into segments for the anatomy bar: non-overlapping,
// with unmapped gaps made explicit, each wide enough to see and click.

/**
 * @typedef {Object} Segment
 * @property {number} start
 * @property {number} end           exclusive
 * @property {string} name
 * @property {string} kind          region kind, 'gap' for unmapped bytes, 'mixed' for merged small regions
 * @property {string[]} [members]   names of merged regions
 * @property {number} [count]       number of merged regions
 */

const FIELD_TO_REGION = {
  magic: 'header',
  header: 'header',
  size: 'header',
  count: 'header',
  offset: 'header',
  flags: 'header',
  checksum: 'header',
  string: 'metadata',
  data: 'data',
  padding: 'padding'
}

/** Regions to draw: the analysis' own, or its top-level fields when it has none. */
export function regionsOf(analysis) {
  if (!analysis) return []
  if (analysis.regions.length > 0) return analysis.regions
  return analysis.fields.map(field => ({
    name: field.name,
    offset: field.offset,
    length: field.length,
    kind: FIELD_TO_REGION[field.kind] || 'other'
  }))
}

/**
 * Sorted, non-overlapping segments covering [0, size): where regions overlap,
 * the earlier one keeps the shared bytes; uncovered bytes become gaps.
 * @returns {Segment[]}
 */
export function buildSegments(regions, size) {
  const sorted = regions
    .filter(region => region && Number.isFinite(region.offset) && region.length > 0)
    .slice()
    .sort((a, b) => a.offset - b.offset || b.length - a.length)
  const segments = []
  let cursor = 0
  for (const region of sorted) {
    const start = Math.max(region.offset, cursor)
    const end = Math.min(size, region.offset + region.length)
    if (end <= start) continue
    if (start > cursor) segments.push({ start: cursor, end: start, name: 'Unmapped bytes', kind: 'gap' })
    segments.push({ start, end, name: region.name, kind: region.kind || 'other' })
    cursor = end
  }
  if (size > 0 && cursor < size && segments.length > 0) segments.push({ start: cursor, end: size, name: 'Unmapped bytes', kind: 'gap' })
  return segments
}

function merge(group) {
  if (group.length === 1) return group[0]
  const kinds = new Set(group.map(segment => segment.kind))
  return {
    start: group[0].start,
    end: group[group.length - 1].end,
    name: `${group.length} small regions`,
    kind: kinds.size === 1 ? group[0].kind : 'mixed',
    members: group.slice(0, 6).map(segment => segment.name),
    count: group.length
  }
}

/**
 * Pixel layout: every segment gets at least `minPx`, the rest of the width is
 * shared in proportion to size. Runs of segments too small to show are merged.
 * @returns {(Segment & { left: number, width: number })[]}
 */
export function layoutSegments(segments, width, minPx = 8) {
  if (segments.length === 0 || width <= 0) return []
  const first = segments[0].start
  const total = Math.max(1, segments[segments.length - 1].end - first)
  const scale = width / total
  const items = []
  let group = []
  let groupBytes = 0
  const flush = () => {
    if (group.length) items.push(merge(group))
    group = []
    groupBytes = 0
  }
  for (const segment of segments) {
    const bytes = segment.end - segment.start
    if (bytes * scale >= minPx) {
      flush()
      items.push(segment)
      continue
    }
    group.push(segment)
    groupBytes += bytes
    if (groupBytes * scale >= minPx) flush()
  }
  flush()

  const spare = width - items.length * minPx
  let left = 0
  return items.map(item => {
    const share = spare > 0 ? minPx + spare * (item.end - item.start) / total : width / items.length
    const laid = { ...item, left, width: share }
    left += share
    return laid
  })
}

/** Horizontal position of a byte offset on the laid-out bar, or null. */
export function offsetToX(laid, offset) {
  let lo = 0
  let hi = laid.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const item = laid[mid]
    if (offset < item.start) hi = mid - 1
    else if (offset >= item.end) lo = mid + 1
    else return item.left + item.width * (offset - item.start) / Math.max(1, item.end - item.start)
  }
  return null
}
