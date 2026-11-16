// Decides what a poster shows: which bytes, which rows (with long runs
// collapsed into explicit breaks), and which fields get a label. Pure and
// bounded: it reads at most a few hundred fields and never iterates over
// file-sized ranges.

import { kindOf, regionKindOf } from './palette.js'

export const MAX_ROWS = 40
export const COLLAPSE_MIN = 3
// The start-of-file view always shows at least this many rows, so a format
// with only a few fields still gives a full-looking dump
export const MIN_CONTEXT_ROWS = 8
export const BYTES_PER_ROW = [8, 16, 32]
export const DEPTHS = [1, 2, 3, 4]
export const LABEL_LIMITS = [12, 24, 36, 60, 99]
export const DEFAULT_OPTIONS = { mode: 'auto', bytesPerRow: 16, depth: 3, maxLabels: 36 }

// Bound on tree nodes visited per poster, whatever the parser produced
const VISIT_BUDGET = 20000

const isCount = n => Number.isSafeInteger(n) && n >= 0

/**
 * The tree the poster labels: the analysis fields, or, when a format has
 * none, its regions as a flat list.
 * @param {import('../../analysis/types.js').Analysis|null} analysis
 * @param {number} size
 */
export function posterSource(analysis, size) {
  const fields = Array.isArray(analysis?.fields) ? analysis.fields.filter(f => validNode(f, size)) : []
  if (fields.length) return { source: 'fields', roots: fields }
  const regions = Array.isArray(analysis?.regions) ? analysis.regions.filter(r => validNode(r, size)) : []
  if (regions.length) {
    return {
      source: 'regions',
      roots: regions.map(r => ({ name: r.name, offset: r.offset, length: r.length, kind: regionKindOf(r.kind), description: 'Region' }))
    }
  }
  return { source: 'none', roots: [] }
}

function validNode(node, size) {
  return Boolean(node) && isCount(node.offset) && Number.isFinite(node.length) && node.length > 0 && node.offset < size
}

function nodeEnd(node, size) {
  return Math.min(size, node.offset + Math.floor(node.length))
}

/**
 * Leaves to label: fields at `depth` levels down, or shallower fields without
 * children, in file order, intersecting `window`. Overlapping leaves are
 * dropped so boxes never sit on top of each other.
 */
function collectLeaves(roots, { depth, window, size, outer }) {
  const parents = []
  const parentOf = new Map()
  const leaves = []
  let visits = 0

  const parentRecord = (node, level, chain) => {
    let record = parentOf.get(node)
    if (!record) {
      record = {
        id: parents.length,
        name: node.name,
        kind: kindOf(node.kind),
        offset: node.offset,
        length: nodeEnd(node, size) - node.offset,
        level,
        chain
      }
      parents.push(record)
      parentOf.set(node, record)
    }
    return record
  }

  const walk = (nodes, level, chain) => {
    const sorted = nodes.filter(n => validNode(n, size)).sort((a, b) => a.offset - b.offset)
    for (const node of sorted) {
      if (++visits > VISIT_BUDGET) return
      const end = nodeEnd(node, size)
      if (end <= window.start || node.offset >= window.end) continue
      const children = Array.isArray(node.children) ? node.children.filter(n => validNode(n, size)) : []
      if (level >= depth || children.length === 0) {
        leaves.push({ node, end, chain })
      } else {
        const record = parentRecord(node, chain.length, chain)
        walk(children, level + 1, [...chain, record.id])
      }
    }
  }

  let base = []
  if (outer) base = [parentRecord(outer, 0, []).id]
  walk(roots, 1, base)

  leaves.sort((a, b) => a.node.offset - b.node.offset)
  const kept = []
  let lastEnd = -1
  for (const leaf of leaves) {
    if (leaf.node.offset < lastEnd) continue
    kept.push(leaf)
    lastEnd = leaf.end
  }
  return { leaves: kept, parents, truncated: visits > VISIT_BUDGET }
}

/**
 * Rows to draw for a byte window. Rows holding the start or end of a label
 * are kept; runs of at least COLLAPSE_MIN rows between them collapse into one
 * break. Without labels the window is shown from its start. Never more than
 * `maxRows` items (rows plus breaks).
 */
export function planRows({ window, size, bytesPerRow, boundaries, maxRows = MAX_ROWS }) {
  const bpr = bytesPerRow
  const items = []
  if (window.start > 0) items.push({ type: 'break', start: 0, end: window.start, where: 'before' })
  if (window.end <= window.start) {
    if (window.end < size) items.push({ type: 'break', start: window.end, end: size, where: 'after' })
    return items
  }
  const firstRow = Math.floor(window.start / bpr)
  const lastRow = Math.floor((window.end - 1) / bpr)
  const room = Math.max(1, maxRows - items.length)

  let kept
  if (boundaries.length === 0) {
    kept = []
    for (let r = firstRow; r <= lastRow && kept.length < room; r++) kept.push(r)
  } else {
    const rows = new Set([firstRow, lastRow])
    for (const offset of boundaries) {
      if (offset >= window.start && offset < window.end) rows.add(Math.floor(offset / bpr))
    }
    kept = [...rows].sort((a, b) => a - b)
  }

  const body = []
  let previous = null
  for (const row of kept) {
    if (previous !== null) {
      const gap = row - previous - 1
      if (gap >= COLLAPSE_MIN) {
        body.push({ type: 'break', start: (previous + 1) * bpr, end: row * bpr, where: 'inside' })
      } else {
        for (let r = previous + 1; r < row && body.length <= room; r++) body.push(rowItem(r, bpr, window))
      }
    }
    body.push(rowItem(row, bpr, window))
    previous = row
    if (body.length > room) break
  }

  let shownEnd = body[body.length - 1].end
  const needsTail = shownEnd < size
  if (body.length + (needsTail ? 1 : 0) > room) {
    // Leave room for the break that says what was cut
    body.length = Math.max(1, room - 1)
    while (body.length > 1 && body[body.length - 1].type === 'break') body.pop()
    shownEnd = body[body.length - 1].end
  }
  items.push(...body)
  if (shownEnd < window.end) items.push({ type: 'break', start: shownEnd, end: window.end, where: window.end === size ? 'after' : 'inside' })
  if (window.end < size) items.push({ type: 'break', start: window.end, end: size, where: 'after' })
  return mergeBreaks(items)
}

function rowItem(row, bpr, window) {
  return { type: 'row', row, start: Math.max(row * bpr, window.start), end: Math.min((row + 1) * bpr, window.end) }
}

function mergeBreaks(items) {
  const out = []
  for (const item of items) {
    const last = out[out.length - 1]
    if (item.type === 'break' && last && last.type === 'break' && last.end === item.start) {
      last.end = item.end
      if (item.where === 'after') last.where = 'after'
    } else {
      out.push({ ...item })
    }
  }
  return out
}

function shownRanges(items) {
  return items.filter(i => i.type === 'row').map(i => [i.start, i.end])
}

function isShown(ranges, offset) {
  for (const [s, e] of ranges) if (offset >= s && offset < e) return true
  return false
}

function boundariesOf(leaves, window) {
  const out = []
  for (const leaf of leaves) {
    out.push(Math.max(leaf.node.offset, window.start))
    out.push(Math.min(leaf.end, window.end) - 1)
  }
  return out
}

/**
 * Top-level entries for the "this field" picker.
 * @returns {Array<{ index: number, name: string, offset: number, length: number }>}
 */
export function topLevelChoices(analysis, size, limit = 500) {
  const { roots } = posterSource(analysis, size)
  return roots.slice(0, limit).map((node, index) => ({ index, name: String(node.name ?? ''), offset: node.offset, length: Math.floor(node.length) }))
}

/**
 * @param {Object} input
 * @param {import('../../analysis/types.js').Analysis|null} input.analysis
 * @param {number} input.size
 * @param {'auto'|'selection'|'field'} [input.mode]
 * @param {{ start: number, end: number }|null} [input.range]   for mode 'selection'
 * @param {number} [input.fieldIndex]                          for mode 'field'
 * @param {number} [input.bytesPerRow]
 * @param {number} [input.depth]
 * @param {number} [input.maxLabels]
 * @param {number} [input.maxRows]
 */
export function planPoster(input) {
  const size = Math.max(0, Math.floor(input.size) || 0)
  const bpr = BYTES_PER_ROW.includes(input.bytesPerRow) ? input.bytesPerRow : 16
  const depth = Math.max(1, Math.min(8, Math.floor(input.depth) || 3))
  const maxLabels = Math.max(0, Math.min(99, Math.floor(input.maxLabels ?? 36)))
  const maxRows = Math.max(4, Math.min(200, Math.floor(input.maxRows) || MAX_ROWS))
  const { source, roots } = posterSource(input.analysis, size)

  let mode = input.mode || 'auto'
  let window = { start: 0, end: size }
  let outer = null
  let treeRoots = roots

  if (mode === 'selection' && input.range && input.range.end > input.range.start) {
    const start = Math.max(0, Math.min(size, Math.floor(input.range.start)))
    window = { start, end: Math.max(start, Math.min(size, Math.floor(input.range.end))) }
  } else if (mode === 'field' && roots[input.fieldIndex]) {
    const field = roots[input.fieldIndex]
    window = { start: field.offset, end: nodeEnd(field, size) }
    const children = Array.isArray(field.children) ? field.children.filter(n => validNode(n, size)) : []
    if (children.length) {
      outer = field
      treeRoots = children
    } else {
      treeRoots = [field]
    }
  } else {
    mode = 'auto'
  }

  const collected = collectLeaves(treeRoots, { depth, window, size, outer })
  let leaves = collected.leaves
  const available = leaves.length
  let items

  if (mode === 'auto') {
    // Start of the file through as many labelled fields as fit
    let count = Math.min(maxLabels, leaves.length)
    for (;;) {
      const chosen = leaves.slice(0, count)
      const contextEnd = Math.min(size, MIN_CONTEXT_ROWS * bpr)
      const end = count === 0 ? Math.min(size, maxRows * bpr) : Math.max(contextEnd, ...chosen.map(l => l.end))
      window = { start: 0, end }
      const boundaries = boundariesOf(chosen, window)
      if (count > 0) for (let offset = 0; offset < contextEnd; offset += bpr) boundaries.push(offset)
      items = planRows({ window, size, bytesPerRow: bpr, boundaries, maxRows })
      const ranges = shownRanges(items)
      const fits = chosen.every(l => isShown(ranges, l.node.offset))
      if (fits || count === 0) {
        leaves = chosen
        break
      }
      count--
    }
  } else {
    leaves = leaves.slice(0, maxLabels)
    items = planRows({ window, size, bytesPerRow: bpr, boundaries: boundariesOf(leaves, window), maxRows })
    const ranges = shownRanges(items)
    leaves = leaves.filter(l => isShown(ranges, Math.max(l.node.offset, window.start)))
  }

  const usedParents = new Set()
  const labels = leaves.map((leaf, i) => {
    for (const id of leaf.chain) usedParents.add(id)
    const node = leaf.node
    return {
      number: i + 1,
      name: String(node.name ?? ''),
      value: node.value === undefined || node.value === null ? '' : String(node.value),
      description: node.description === undefined || node.description === null ? '' : String(node.description),
      kind: kindOf(node.kind),
      offset: node.offset,
      length: leaf.end - node.offset,
      start: Math.max(node.offset, window.start),
      end: Math.min(leaf.end, window.end),
      parents: leaf.chain
    }
  })
  const parents = collected.parents.filter(p => usedParents.has(p.id))

  const rows = items.filter(i => i.type === 'row')
  return {
    size,
    mode,
    source,
    bytesPerRow: bpr,
    depth,
    maxRows,
    window,
    items,
    labels,
    parents,
    omittedLabels: Math.max(0, available - labels.length),
    partialTree: collected.truncated,
    shown: rows.length ? { start: rows[0].start, end: rows[rows.length - 1].end } : null
  }
}
