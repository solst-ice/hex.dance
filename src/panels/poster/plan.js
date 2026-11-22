// Decides what a poster shows: which bytes, which rows (with long runs
// collapsed into explicit breaks), and which fields get a label. Pure and
// bounded: it reads at most VISIT_BUDGET tree nodes, checks a capped number
// of bytes for "all zero", and never iterates over file-sized ranges.
//
// Modes:
// - 'tour' (the default): the whole file. Every top-level structure (and
//   every region of the file map that no field covers) gets a box first;
//   then detail is added where it is most interesting until the label and
//   row limits are used. Pinned fields come before everything else.
// - 'auto': the start of the file, labelled in file order.
// - 'selection': a byte range; 'field': one top-level field.
// In every mode runs of fields that carry nothing are merged into one box and
// runs of entries with the same layout show only their first and last entry.

import { kindOf } from './palette.js'
import { createTree, validNode, readableText, readableProse, VISIT_BUDGET, TEXT_MIN } from './planTree.js'

export const MAX_ROWS = 40
export const COLLAPSE_MIN = 3
// The start-of-file view always shows at least this many rows, so a format
// with only a few fields still gives a full-looking dump
export const MIN_CONTEXT_ROWS = 8
export const BYTES_PER_ROW = [8, 16, 32]
export const DEPTHS = [1, 2, 3, 4]
export const LABEL_LIMITS = [12, 24, 36, 60, 99]
export const MODES = ['tour', 'auto', 'selection', 'field']
export const DEFAULT_OPTIONS = { mode: 'tour', bytesPerRow: 16, depth: 3, maxLabels: 36 }
export const MAX_LINKS = 400

// Detail is added level by level unless a deeper part is much more interesting
const LEVEL_PENALTY = 4
const KIND_SCORE = { magic: 8, count: 5, offset: 5, size: 4, flags: 3, checksum: 3, string: 3, header: 2, data: 1, other: 0, padding: -5 }
const PIN_CAP = 64
// Bytes looked at to tell rows of one repeated byte, per poster
const ZERO_ROW_BYTES = 1 << 20
// Further entries shown per repeat when labels and rows allow, and rows kept back while doing it
const MORE_ENTRIES = 2
const ROW_RESERVE = 8
// Rows of content added at the start of each long stretch (at least, and
// per row of budget), and how far ahead to look past zeros
const CONTENT_ROWS = 12
const CONTENT_SHARE = 1 / 6
const LOOK_AHEAD = 64
// Bytes looked at to tell whether a break is all one value
const FILL_PER_BREAK = 1 << 16
const FILL_TOTAL = 1 << 20
// Rows that hold readable strings: a run of at least STRING_RUN printable
// characters, half of them letters, looked for at most STRING_REACH bytes
// past the row's ends; rows of a box checked, rows added per box per round,
// and bytes looked at per poster. Ten characters, because compressed and
// encrypted data throws up shorter runs by chance: about one row in 25 of
// random bytes holds a run of six, one in a thousand a run of ten.
const STRING_RUN = 10
const STRING_REACH = 32
const STRING_ROWS_CHECKED = 256
const STRING_ROWS_PER_BOX = 3
const STRING_BYTES = 1 << 18
// Rows a tour keeps for strings while it labels: per box, and per poster
const STRING_NEED_BOX = 2
const STRING_NEED_MIN = 4
const STRING_NEED_SHARE = 1 / 10
// Labels tried, and dropped at most, to make room for one box's string rows
// (only for a string of STRING_DROP_RUN characters or more, and only
// labels no more interesting than DROP_INTEREST)
const DROP_TRIES = 24
const DROP_MAX = 2
const STRING_DROP_RUN = 16
const DROP_INTEREST = 4
// A box of text shows at most this many rows at its start, and its last two
const TEXT_HEAD = 5
const TEXT_TAIL = 2
// Stretches of text named for the text band: long enough to be worth
// reading as a listing (a few rows of the dump show a short one whole), and
// made of words and lines, not a table of names
const TEXT_BAND_MIN = 256
const TEXT_BAND_MAX = 3
const TEXT_CHECKS = 200

const isCount = n => Number.isSafeInteger(n) && n >= 0

/**
 * The top-level entries of the analysis: its fields, or, when a format has
 * none, its regions. Used for the "this field" picker.
 * @param {import('../../analysis/types.js').Analysis|null} analysis
 * @param {number} size
 */
export function posterSource(analysis, size) {
  const fields = Array.isArray(analysis?.fields) ? analysis.fields.slice(0, 4096).filter(f => validNode(f, size)) : []
  if (fields.length) return { source: 'fields', roots: fields }
  const regions = Array.isArray(analysis?.regions) ? analysis.regions.slice(0, 4096).filter(r => validNode(r, size)) : []
  if (regions.length) return { source: 'regions', roots: regions }
  return { source: 'none', roots: [] }
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
    if (item.type === 'break' && last && last.type === 'break' && last.end === item.start && !last.repeat && !item.repeat) {
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
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offset < ranges[mid][0]) hi = mid - 1
    else if (offset >= ranges[mid][1]) lo = mid + 1
    else return true
  }
  return false
}

// --- Interest ----------------------------------------------------------------

// Interesting: magic numbers, counts, sizes, offsets (above all real
// pointers), decoded flags, regions of code or data, anything pinned. Dull:
// zero values, reserved fields, padding, version numbers.
function interest(tree, node) {
  if (node.score !== undefined) return node.score
  let s
  if (node.pinned) s = 100
  else if (node.merged) s = -4
  else {
    s = KIND_SCORE[node.kind] ?? 0
    if (tree.isFiller(node)) s -= 9
    if (tree.pointerOf(node)) s += 5
    // Regions: code first, and the bigger the more it matters (up to a point)
    if (node.region) s += node.src.padding ? -6 : (node.src.value === 'code' ? 4 : 2) + Math.min(4, Math.max(0, Math.log2((node.end - node.offset) / 32)))
    if (node.kind === 'flags' && /[a-z]{3}/i.test(node.value.replace(/^\s*0x[0-9a-f]+/i, ''))) s += 2
    if (/version/i.test(node.name)) s -= 1
    if (tree.hasChildren(node)) s += 2
    if (node.rep?.role === 'last') s += 1
    if (node.hasPin) s += 20
  }
  node.score = s
  return s
}

// The last entry of a repeat, and further ones shown, are one box each
const boxOnly = node => Boolean(node.rep) && node.rep.role !== 'first' && node.rep.role !== 'pinned'
const unitNodes = unit => (unit.type === 'repeat' ? unit.shown : [unit])
const unitInterest = (tree, unit) => (unit.type === 'repeat' ? Math.max(...unit.shown.map(n => interest(tree, n))) + 2 : interest(tree, unit))
const unitStart = unit => (unit.type === 'repeat' ? unit.members[0].offset : unit.offset)
const unitEnd = unit => (unit.type === 'repeat' ? unit.members[unit.members.length - 1].end : unit.end)

/** The unit of a list that holds `offset`, unless it is in the skipped middle of a repeat. */
function unitAt(units, offset) {
  let lo = 0
  let hi = units.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const u = units[mid]
    if (offset < unitStart(u)) hi = mid - 1
    else if (offset >= unitEnd(u)) lo = mid + 1
    else {
      if (u.type !== 'repeat') return u
      return u.shown.some(n => offset >= n.offset && offset < n.end) ? u : null
    }
  }
  return null
}

// --- Rows --------------------------------------------------------------------

/**
 * Rows a set of labels needs: the first and last row of each, the row of
 * each pointer and of its target, the ends of every displayed repeat and the
 * first and last row of the file. Rows between two shown entries of a
 * repeat are "forced": always one break, never filled.
 */
function rowNeeds(tree, labels, bpr) {
  const size = tree.size
  const rowOf = o => Math.floor(o / bpr)
  const want = new Set()
  if (size > 0) {
    want.add(0)
    want.add(rowOf(size - 1))
  }
  const forced = []
  const targets = []
  const reps = new Set()
  for (const node of labels) {
    want.add(rowOf(node.offset))
    want.add(rowOf(node.end - 1))
    const ptr = tree.pointerOf(node)
    if (ptr) {
      want.add(rowOf(ptr.offset))
      targets.push(rowOf(ptr.target))
    }
    for (let n = node; n && !n.isRoot; n = n.parent) if (n.rep) reps.add(n.rep.rep)
  }
  for (const rep of reps) {
    const shown = rep.shown
    for (let k = 0; k + 1 < shown.length; k++) {
      const a = shown[k]
      const b = shown[k + 1]
      const count = b.rep.index - a.rep.index - 1
      if (count <= 0) continue
      const r1 = rowOf(a.end - 1)
      const r2 = rowOf(b.offset)
      want.add(r1)
      want.add(r2)
      if (r2 - r1 > 1) forced.push({ r1: r1 + 1, r2: r2 - 1, info: { id: rep.id, count, unit: rep.unit, start: a.end, end: b.offset } })
    }
  }
  forced.sort((a, b) => a.r1 - b.r1)
  const inForced = r => forced.some(f => r >= f.r1 && r <= f.r2)
  for (const r of targets) if (!inForced(r)) want.add(r)

  const rows = [...want].filter(r => !inForced(r)).sort((a, b) => a - b)
  return { rows, forced }
}

function forcedIn(forced, a, b) {
  for (const f of forced) if (f.r1 <= b && f.r2 >= a) return f
  return null
}

/**
 * Whether a row's bytes are all one value (zero, 0x0D, 0xFF...), from a
 * bounded cache. Such rows are treated as filler: shown only where a box
 * starts or ends. Without bytes no row counts.
 */
function blankRows(tree, bpr) {
  const bytes = tree.bytes
  const cache = new Map()
  let budget = ZERO_ROW_BYTES
  return r => {
    if (!bytes) return false
    let z = cache.get(r)
    if (z !== undefined) return z
    const start = r * bpr
    const end = Math.min(tree.size, start + bpr)
    if (end - start > budget) return false
    budget -= end - start
    z = end > start
    const v = bytes[start]
    for (let i = start + 1; i < end && z; i++) z = bytes[i] === v
    cache.set(r, z)
    return z
  }
}

/** Whether a row repeats the bytes of the row above exactly (bounded, like blankRows). */
function sameRows(tree, bpr) {
  const bytes = tree.bytes
  const cache = new Map()
  let budget = ZERO_ROW_BYTES
  return r => {
    if (!bytes || r <= 0) return false
    let same = cache.get(r)
    if (same !== undefined) return same
    const start = r * bpr
    const end = Math.min(tree.size, start + bpr)
    if (end - start < bpr || bpr > budget) return false
    budget -= bpr
    same = true
    for (let i = start; i < end && same; i++) same = bytes[i] === bytes[i - bpr]
    cache.set(r, same)
    return same
  }
}

/**
 * The length of the longest readable string a row holds part of (0 for
 * none): a run of at least STRING_RUN printable characters with at least
 * three different ones, half of them letters, at least three of them in the
 * row (a run is followed at most STRING_REACH bytes past the row). Bounded
 * like blankRows.
 */
function stringRows(tree, bpr) {
  const bytes = tree.bytes
  const cache = new Map()
  let budget = STRING_BYTES
  const isPrintable = b => b >= 0x20 && b < 0x7f
  const isLetter = b => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
  return r => {
    if (!bytes) return 0
    let found = cache.get(r)
    if (found !== undefined) return found
    const start = r * bpr
    const end = Math.min(tree.size, start + bpr)
    const from = Math.max(0, start - STRING_REACH)
    const to = Math.min(tree.size, end + STRING_REACH)
    if (to - from > budget) return 0
    budget -= to - from
    found = 0
    let i = from
    while (i < to) {
      if (!isPrintable(bytes[i])) {
        i++
        continue
      }
      let j = i
      let letters = 0
      const seen = new Set()
      while (j < to && isPrintable(bytes[j])) {
        if (isLetter(bytes[j])) letters++
        if (seen.size < 3) seen.add(bytes[j])
        j++
      }
      const inRow = Math.min(j, end) - Math.max(i, start)
      if (j - i >= STRING_RUN && seen.size >= 3 && letters * 2 >= j - i && inRow >= 3) found = Math.max(found, j - i)
      i = j
    }
    cache.set(r, found)
    return found
  }
}

/**
 * The rows of a box that a tour keeps for readable strings: the first run of
 * consecutive string rows inside the box (not its first or last row), at
 * most STRING_NEED_BOX of them; none for boxes of text or filler. At most
 * `cap` rows per poster.
 */
function stringNeeds(tree, bpr, maxRows, textOf) {
  const stringRow = stringRows(tree, bpr)
  const cache = new Map()
  return {
    cap: Math.max(STRING_NEED_MIN, Math.floor(maxRows * STRING_NEED_SHARE)),
    of(node) {
      let rows = cache.get(node)
      if (rows) return rows
      rows = []
      rows.best = 0
      const first = Math.floor(node.offset / bpr)
      const last = Math.floor((node.end - 1) / bpr)
      if (last - first >= 2 && !node.merged && !tree.isFiller(node) && !textOf(node)) {
        for (let r = first + 1; r < last && r <= first + STRING_ROWS_CHECKED && rows.length < STRING_NEED_BOX; r++) {
          const run = stringRow(r)
          if (run) {
            rows.push(r)
            rows.best = Math.max(rows.best, run)
          } else if (rows.length) break
        }
      }
      cache.set(node, rows)
      return rows
    }
  }
}

/**
 * Items for a sorted set of kept rows: gaps of COLLAPSE_MIN rows or more,
 * and the skipped middle of a repeat, become one break; shorter gaps are
 * drawn row by row, except rows of one repeated byte, which become a break
 * (no box starts or ends on them: kept rows are never dropped).
 */
function itemsFrom(rows, forced, bpr, size, blankRow = () => false) {
  const window = { start: 0, end: size }
  const items = []
  const pushBreak = (start, end) => {
    const last = items[items.length - 1]
    if (last && last.type === 'break' && !last.repeat && last.end === start) last.end = end
    else items.push({ type: 'break', start, end, where: 'inside' })
  }
  for (let k = 0; k < rows.length; k++) {
    if (k > 0) {
      const a = rows[k - 1]
      const b = rows[k]
      const g = b - a - 1
      if (g > 0) {
        const f = forcedIn(forced, a + 1, b - 1)
        if (f) items.push({ type: 'break', start: (a + 1) * bpr, end: b * bpr, where: 'inside', repeat: { ...f.info } })
        else if (g >= COLLAPSE_MIN) pushBreak((a + 1) * bpr, b * bpr)
        else {
          for (let r = a + 1; r < b; r++) {
            if (blankRow(r)) pushBreak(r * bpr, (r + 1) * bpr)
            else items.push(rowItem(r, bpr, window))
          }
        }
      }
    }
    items.push(rowItem(rows[k], bpr, window))
  }
  return items
}

function countItems(rows, forced, blankRow = () => false) {
  let n = rows.length
  for (let k = 1; k < rows.length; k++) {
    const a = rows[k - 1]
    const b = rows[k]
    const g = b - a - 1
    if (g <= 0) continue
    if (g >= COLLAPSE_MIN || forcedIn(forced, a + 1, b - 1)) n += 1
    else {
      let inZero = false
      for (let r = a + 1; r < b; r++) {
        const z = blankRow(r)
        if (!z || !inZero) n += 1
        inZero = z
      }
    }
  }
  return n
}

// --- Tour --------------------------------------------------------------------

function planTour(tree, { depth, maxLabels, maxRows, bpr }) {
  const shown = new Set()
  const opened = new Set()
  const failed = new Set()
  const root = tree.root
  const blankRow = blankRows(tree, bpr)
  const textOf = textChecker(tree)
  const strings = stringNeeds(tree, bpr, maxRows, textOf)
  const inFrontier = unit => unitNodes(unit).some(n => shown.has(n) || opened.has(n))
  const fits = () => {
    if (shown.size > maxLabels) return false
    const { rows, forced } = rowNeeds(tree, shown, bpr)
    return countItems(rows, forced, blankRow) <= maxRows
  }
  // Applies a change, keeping it only when it fits
  const attempt = change => {
    const savedShown = [...shown]
    const savedOpened = [...opened]
    change()
    if (fits()) return true
    shown.clear()
    for (const n of savedShown) shown.add(n)
    opened.clear()
    for (const n of savedOpened) opened.add(n)
    return false
  }
  const addUnit = unit => { for (const n of unitNodes(unit)) shown.add(n) }
  const openWith = (node, units) => {
    shown.delete(node)
    opened.add(node)
    for (const u of units) addUnit(u)
  }
  const openable = node => !node.merged && (!node.rep || node.rep.role === 'first' || node.rep.role === 'pinned') && tree.units(node).length > 0

  // 1. Pins, ahead of everything else: the path down to each, then the pinned
  // field itself or its children to the chosen depth
  let pinsLabelled = 0
  for (const pin of [...tree.pinned].sort((a, b) => a.offset - b.offset)) {
    const path = []
    for (let n = pin; n && !n.isRoot; n = n.parent) path.unshift(n)
    let ok = true
    for (const node of path) {
      const parent = node.parent
      const unit = tree.units(parent).find(u => u === node || (u.type === 'repeat' && u.shown.includes(node)))
      if (!unit) {
        ok = false
        break
      }
      if (inFrontier(unit)) continue
      ok = attempt(() => {
        if (shown.has(parent)) openWith(parent, [unit])
        else addUnit(unit)
      })
      if (!ok) break
    }
    if (!ok || !shown.has(pin)) continue
    pinsLabelled++
    const queue = [pin]
    while (queue.length) {
      const node = queue.shift()
      if (!shown.has(node) || node.level >= depth || !openable(node)) continue
      const units = tree.units(node)
      if (attempt(() => openWith(node, units))) for (const u of units) queue.push(...unitNodes(u))
    }
  }

  // 2. Every top-level structure gets its own box: fields first, then the
  // regions that no field covers, then padding; the most interesting first
  const roots = tree.units(root)
  const rank = unit => {
    const node = unitNodes(unit)[0]
    return node.region ? (tree.dull(node) || node.src.padding ? 2 : 1) : 0
  }
  let rootsLeft = 0
  for (const unit of [...roots].sort((a, b) => rank(a) - rank(b) || unitInterest(tree, b) - unitInterest(tree, a))) {
    if (inFrontier(unit)) continue
    if (!attempt(() => addUnit(unit))) rootsLeft++
  }

  // 3. More detail where it is most interesting, until the limits are used
  let rowLimited = false
  for (let guard = 0; guard < 400 && shown.size < maxLabels; guard++) {
    const candidates = []
    for (const node of shown) {
      if (node.level >= depth || !openable(node) || failed.has(node)) continue
      const units = tree.units(node)
      const scores = units.map(u => unitInterest(tree, u)).sort((a, b) => b - a).slice(0, 3)
      const mean = scores.reduce((s, v) => s + v, 0) / scores.length
      candidates.push({ type: 'open', node, units, priority: interest(tree, node) + mean / 2 - LEVEL_PENALTY * node.level })
    }
    for (const node of [root, ...opened]) {
      for (const unit of tree.units(node)) {
        if (inFrontier(unit) || failed.has(unit)) continue
        candidates.push({ type: 'add', unit, priority: unitInterest(tree, unit) - LEVEL_PENALTY * (node.level + 1) - 1 })
      }
    }
    // Whatever holds the target of a labelled pointer gets a label too
    for (const node of shown) {
      const ptr = tree.pointerOf(node)
      const unit = ptr && holderUnit(tree, ptr.target, shown, opened)
      if (unit && !failed.has(unit)) candidates.push({ type: 'add', unit, priority: 50 })
    }
    if (!candidates.length) break
    candidates.sort((a, b) => b.priority - a.priority)
    const room = maxLabels - shown.size
    let done = false
    for (const c of candidates) {
      const cost = c.type === 'open' ? unitsCost(c.units) - 1 : unitNodes(c.unit).length
      if (cost > room) continue
      if (attempt(() => (c.type === 'open' ? openWith(c.node, c.units) : addUnit(c.unit)))) {
        done = true
        break
      }
      rowLimited = true
      failed.add(c.type === 'open' ? c.node : c.unit)
    }
    if (done) continue
    // Nothing fits whole: open the best candidate with its most interesting children
    for (const c of candidates) {
      if (c.type !== 'open') continue
      const ranked = [...c.units].sort((a, b) => unitInterest(tree, b) - unitInterest(tree, a))
      const pick = []
      let cost = 0
      for (const u of ranked) {
        const n = unitNodes(u).length
        if (cost + n - 1 > room) continue
        pick.push(u)
        cost += n
      }
      if (pick.length >= 2 && attempt(() => openWith(c.node, pick))) {
        done = true
        break
      }
      failed.add(c.node)
    }
    if (!done) break
  }

  // 4. With labels to spare and plenty of rows, show a further entry or two
  // of each repeat (the second and third section header, say), one box each
  const reps = new Set()
  for (const n of [...shown, ...opened]) if (n.rep) reps.add(n.rep.rep)
  for (let round = 0; round < MORE_ENTRIES; round++) {
    for (const rep of [...reps].sort((a, b) => a.members[0].offset - b.members[0].offset)) {
      if (shown.size >= maxLabels) break
      const index = round + 1
      if (index >= rep.count - 1 || rep.shown.some(n => n.rep.index === index)) continue
      tree.showEntry(rep, index)
      const entry = rep.members[index]
      shown.add(entry)
      const { rows, forced } = rowNeeds(tree, shown, bpr)
      if (countItems(rows, forced, blankRow) <= maxRows - ROW_RESERVE) continue
      shown.delete(entry)
      tree.hideEntry(rep, index)
    }
  }

  // 5. Rows of the boxes that hold readable strings, a few per box, the
  // longest strings first. When the rows of a long string do not fit, up to
  // DROP_MAX labels of little interest that free rows make room (never a
  // pin, a pointer, a top-level box or an entry of a repeat)
  const keep = new Set()
  let left = strings.cap
  let drops = DROP_MAX
  const withStrings = [...shown].filter(n => strings.of(n).length)
  withStrings.sort((a, b) => strings.of(b).best - strings.of(a).best || interest(tree, b) - interest(tree, a) || a.offset - b.offset)
  for (const node of withStrings) {
    if (left <= 0) break
    const want = strings.of(node).slice(0, left)
    const needed = () => {
      const { rows, forced } = rowNeeds(tree, shown, bpr)
      const all = new Set(rows)
      for (const r of keep) all.add(r)
      const fresh = want.filter(r => !all.has(r) && !forced.some(f => r >= f.r1 && r <= f.r2))
      for (const r of fresh) all.add(r)
      return { fresh, count: countItems([...all].sort((a, b) => a - b), forced, blankRow) }
    }
    let { fresh, count } = needed()
    if (!fresh.length) continue
    const dropped = []
    if (count > maxRows && drops > 0 && strings.of(node).best >= STRING_DROP_RUN) {
      const droppable = [...shown]
        .filter(n => n !== node && !n.pinned && !n.hasPin && !n.rep && n.level >= 2 && !tree.pointerOf(n) && interest(tree, n) <= DROP_INTEREST)
        .sort((a, b) => interest(tree, a) - interest(tree, b) || b.offset - a.offset)
        .slice(0, DROP_TRIES)
      for (const n of droppable) {
        if (count <= maxRows || dropped.length >= drops) break
        shown.delete(n)
        const next = needed().count
        if (next < count) {
          dropped.push(n)
          count = next
        } else shown.add(n)
      }
    }
    if (count <= maxRows) {
      for (const r of fresh) keep.add(r)
      left -= fresh.length
      drops -= dropped.length
      if (dropped.length) rowLimited = true
    } else for (const n of dropped) shown.add(n)
  }

  // 6. Use the rows that are left
  const labels = [...shown].sort((a, b) => a.offset - b.offset)
  const needs = rowNeeds(tree, shown, bpr)
  const forced = needs.forced
  const rows = [...new Set([...needs.rows, ...keep])].sort((a, b) => a - b)
  const filled = fillRows(tree, rows, forced, labels, bpr, maxRows, blankRow, textOf)
  return { labels, rows: filled, forced, rootsLeft, pinsLabelled, rowLimited, blankRow }
}

function unitsCost(units) {
  return units.reduce((s, u) => s + unitNodes(u).length, 0)
}

/** The unit to add so that `offset` lies in a labelled box, if that is possible. */
function holderUnit(tree, offset, shown, opened) {
  let node = tree.root
  for (let depth = 0; depth < 32; depth++) {
    const unit = unitAt(tree.units(node), offset)
    if (!unit) return null
    const inner = unitNodes(unit).find(n => offset >= n.offset && offset < n.end)
    if (!inner || shown.has(inner)) return null
    if (!opened.has(inner)) return unit
    node = inner
  }
  return null
}

/**
 * Spends the rows left after labelling: a row or two more of each data box,
 * then short gaps (smallest first), then a bounded number of rows more at the
 * start of each long stretch, in turn. Rows of one repeated byte, or
 * that only repeat the row above, are never added: rows left over stay unused, as a shorter dump is better than
 * filler.
 */
function fillRows(tree, rows, forced, labels, bpr, maxRows, blankRow, textOf) {
  const sameRow = sameRows(tree, bpr)
  const stringRow = stringRows(tree, bpr)
  // Filler: rows of one repeated byte, and rows that only repeat the row above
  const filler = r => blankRow(r) || sameRow(r)
  const set = new Set(rows)
  let current = [...rows]
  let count = countItems(current, forced, blankRow)
  const inForced = r => forced.some(f => r >= f.r1 && r <= f.r2)
  const tryAdd = add => {
    const fresh = add.filter(r => !set.has(r) && !inForced(r) && !filler(r))
    if (!fresh.length) return false
    const next = [...current, ...fresh].sort((a, b) => a - b)
    const n = countItems(next, forced, blankRow)
    if (n > maxRows) return false
    for (const r of fresh) set.add(r)
    current = next
    count = n
    return true
  }
  const rowOf = o => Math.floor(o / bpr)
  const byInterest = (a, b) => interest(tree, b) - interest(tree, a) || a.offset - b.offset
  // Boxes of text: the last rows too, as the end of a text often holds
  // something else; the start comes with the other boxes below
  const texts = labels.filter(n => textOf(n) && rowOf(n.end - 1) - rowOf(n.offset) >= TEXT_HEAD + TEXT_TAIL).sort(byInterest)
  for (const n of texts) {
    const last = rowOf(n.end - 1)
    const tail = []
    for (let r = last - TEXT_TAIL + 1; r < last; r++) tail.push(r)
    if (!tryAdd(tail)) tryAdd([last - 1])
  }
  // Rows of other boxes that hold readable strings, a few per box in turn,
  // the most interesting box first; consecutive rows go in together
  const plain = labels.filter(n => !textOf(n) && !tree.isFiller(n) && rowOf(n.end - 1) - rowOf(n.offset) >= 2).sort(byInterest)
  const stringsOf = new Map()
  for (const n of plain) {
    const found = []
    const first = rowOf(n.offset)
    const last = Math.min(rowOf(n.end - 1), first + STRING_ROWS_CHECKED)
    for (let r = first + 1; r < last; r++) if (!set.has(r) && !inForced(r) && stringRow(r)) found.push(r)
    if (found.length) stringsOf.set(n, found)
  }
  for (let round = 0; round < 2 && stringsOf.size; round++) {
    for (const n of plain) {
      const found = stringsOf.get(n)
      if (!found || count >= maxRows) continue
      const take = found.splice(0, STRING_ROWS_PER_BOX)
      if (!tryAdd(take)) for (const r of take) tryAdd([r])
    }
  }
  const data = labels
    .filter(n => (n.region || ['data', 'string', 'checksum', 'other'].includes(n.kind)) && !tree.isFiller(n) && rowOf(n.end - 1) - rowOf(n.offset) >= 2)
    .sort(byInterest)
  for (const extra of [1, 2]) {
    for (const n of data) {
      if (count >= maxRows) break
      if (extra === 1 || rowOf(n.end - 1) - rowOf(n.offset) > 3) tryAdd([rowOf(n.offset) + extra])
    }
  }
  const tried = new Set()
  for (let guard = 0; guard < 400 && count < maxRows; guard++) {
    let best = null
    for (let k = 1; k < current.length; k++) {
      const a = current[k - 1]
      const b = current[k]
      const g = b - a - 1
      if (g < COLLAPSE_MIN || tried.has(a) || forcedIn(forced, a + 1, b - 1)) continue
      if (g - 1 <= maxRows - count && (!best || g < best.g)) best = { a, b, g }
    }
    if (!best) break
    tried.add(best.a)
    const add = []
    for (let r = best.a + 1; r < best.b; r++) add.push(r)
    // Only whole gaps: a gap with filler in it stays a break
    if (!add.some(filler)) tryAdd(add)
  }
  // More of what long stretches hold: the next row that is not one repeated byte,
  // looking a few rows ahead only; a box of text shows only its first rows
  // (the text band shows more of it)
  const textHead = a => texts.some(n => a >= rowOf(n.offset) && a < rowOf(n.end - 1) && a - rowOf(n.offset) + 1 >= TEXT_HEAD)
  const added = new Map()
  for (let pass = 0, passes = Math.max(CONTENT_ROWS, Math.floor(maxRows * CONTENT_SHARE)); pass < passes && count < maxRows; pass++) {
    let any = false
    const gaps = []
    for (let k = 1; k < current.length; k++) {
      const a = current[k - 1]
      const b = current[k]
      if (b - a - 1 >= COLLAPSE_MIN && !forcedIn(forced, a + 1, b - 1)) gaps.push([a, b])
    }
    for (const [a, b] of gaps) {
      if (count >= maxRows) break
      if (pass > 0 && !added.has(a)) continue
      if (textHead(a)) continue
      let r = a + 1
      while (r < b - 1 && r - a <= LOOK_AHEAD && blankRow(r)) r++
      if (r >= b - 1 || filler(r)) continue
      if (tryAdd([r])) {
        added.set(r, true)
        any = true
      }
    }
    if (!any) break
  }
  return current
}

// --- Start of file, selection, one field ---------------------------------------

/**
 * Leaves to label: nodes at `depth` levels below `base`, or shallower ones
 * without children, intersecting `window`, in file order.
 */
function collectLeaves(tree, base, { depth, window }) {
  const leaves = []
  const walk = node => {
    for (const unit of tree.units(node)) {
      for (const n of unitNodes(unit)) {
        if (n.end <= window.start || n.offset >= window.end) continue
        if (n.level - base.level >= depth || n.merged || boxOnly(n) || tree.units(n).length === 0) leaves.push(n)
        else walk(n)
      }
    }
  }
  walk(base)
  return leaves
}

function boundariesOf(leaves, window) {
  const out = []
  for (const leaf of leaves) {
    out.push(Math.max(leaf.offset, window.start))
    out.push(Math.min(leaf.end, window.end) - 1)
  }
  return out
}

function planRange(tree, mode, { window, base, depth, maxLabels, maxRows, bpr, size }) {
  let leaves = collectLeaves(tree, base, { depth, window })
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
      if (count === 0 || chosen.every(l => isShown(ranges, l.offset))) {
        leaves = chosen
        break
      }
      count--
    }
  } else {
    if (leaves.length > maxLabels) {
      // Drop the least interesting, not the last in file order
      const keep = new Set([...leaves].sort((a, b) => interest(tree, b) - interest(tree, a) || a.offset - b.offset).slice(0, maxLabels))
      leaves = leaves.filter(l => keep.has(l))
    }
    items = planRows({ window, size, bytesPerRow: bpr, boundaries: boundariesOf(leaves, window), maxRows })
    const ranges = shownRanges(items)
    leaves = leaves.filter(l => isShown(ranges, Math.max(l.offset, window.start)))
  }
  return { leaves, items: annotateRepeats(items, leaves, bpr), window, available }
}

/** Marks the breaks that stand for the skipped middle of a repeat. */
function annotateRepeats(items, leaves, bpr) {
  const gaps = []
  const reps = new Set()
  for (const leaf of leaves) for (let n = leaf; n && !n.isRoot; n = n.parent) if (n.rep) reps.add(n.rep.rep)
  for (const rep of reps) {
    for (let k = 0; k + 1 < rep.shown.length; k++) {
      const a = rep.shown[k]
      const b = rep.shown[k + 1]
      const count = b.rep.index - a.rep.index - 1
      if (count > 0) gaps.push({ id: rep.id, count, unit: rep.unit, start: a.end, end: b.offset })
    }
  }
  if (!gaps.length) return items
  return items.map(item => {
    if (item.type !== 'break') return item
    const gap = gaps.find(g => item.start >= Math.floor(g.start / bpr) * bpr && item.end <= Math.ceil(g.end / bpr) * bpr && item.end > g.start && item.start < g.end)
    return gap ? { ...item, repeat: { ...gap } } : item
  })
}

// --- Output ------------------------------------------------------------------

/** Whether a node's bytes read as text, for a bounded number of nodes per poster. */
function textChecker(tree) {
  let checks = TEXT_CHECKS
  return node => {
    if (node.isText !== undefined) return node.isText
    if (node.merged || node.end - node.offset < TEXT_MIN || checks <= 0) return false
    checks--
    node.isText = readableText(tree.bytes, node.offset, node.end)
    return node.isText
  }
}

function countLeaves(tree, depth) {
  let total = 0
  const stack = [tree.root]
  let guard = 0
  while (stack.length && guard++ < VISIT_BUDGET) {
    const node = stack.pop()
    for (const unit of tree.units(node)) {
      for (const n of unitNodes(unit)) {
        if (n.level >= depth || n.merged || boxOnly(n) || tree.units(n).length === 0) total++
        else stack.push(n)
      }
    }
  }
  return total
}

/**
 * Every pointer in the analysis, in file order, at most MAX_LINKS. When a
 * field and one of its descendants point at the same place (parsers set the
 * target on a header and on its pointer field), only the descendant counts:
 * it is the more precise position.
 */
function collectLinks(analysis, size) {
  const links = []
  const stack = Array.isArray(analysis?.fields) ? [{ list: analysis.fields, above: [] }] : []
  let visits = 0
  while (stack.length && visits < VISIT_BUDGET) {
    const { list, above } = stack.pop()
    for (let i = 0; i < list.length && visits < VISIT_BUDGET; i++, visits++) {
      const f = list[i]
      if (!validNode(f, size)) continue
      let link = null
      if (isCount(f.target) && f.target < size) {
        link = { offset: f.offset, length: Math.floor(f.length), target: f.target }
        for (const a of above) if (a.target === f.target) a.dropped = true
        links.push(link)
      }
      if (Array.isArray(f.children) && f.children.length && above.length < 64) {
        stack.push({ list: f.children, above: link ? [...above, link] : above })
      }
    }
  }
  const kept = links.filter(l => !l.dropped)
  kept.sort((a, b) => a.offset - b.offset || a.target - b.target)
  const out = []
  for (const l of kept) {
    const last = out[out.length - 1]
    if (last && last.offset === l.offset && last.length === l.length && last.target === l.target) continue
    out.push({ offset: l.offset, length: l.length, target: l.target })
    if (out.length >= MAX_LINKS) break
  }
  return out
}

/**
 * Marks breaks whose bytes are all one value (all zero, all FF), looking at
 * no more than FILL_PER_BREAK bytes per break and FILL_TOTAL per poster; a
 * break not fully checked says nothing.
 */
function describeFill(items, bytes) {
  if (!bytes) return items
  let budget = FILL_TOTAL
  return items.map(item => {
    if (item.type !== 'break' || item.repeat) return item
    const n = item.end - item.start
    if (n <= 0 || n > FILL_PER_BREAK || n > budget) return item
    budget -= n
    const v = bytes[item.start]
    for (let i = item.start + 1; i < item.end; i++) if (bytes[i] !== v) return item
    return { ...item, fill: v }
  })
}

/** Marks the breaks that skip part of a box of text, so they can say so. */
function markTextBreaks(items, labels) {
  const texts = labels.filter(l => l.text)
  if (!texts.length) return items
  return items.map(item => (item.type === 'break' && !item.repeat && item.fill === undefined && texts.some(l => item.start >= l.start && item.end <= l.end) ? { ...item, text: true } : item))
}

function describe(tree, nodes, items, window, textOf) {
  // Parents: every node above a label, ordered by offset so that brackets
  // at one level alternate columns
  const parentNodes = new Set()
  for (const n of nodes) for (let p = n.parent; p && !p.isRoot; p = p.parent) parentNodes.add(p)
  const ordered = [...parentNodes].sort((a, b) => a.offset - b.offset || a.level - b.level)
  const ids = new Map(ordered.map((p, i) => [p, i]))
  const chainOf = node => {
    const chain = []
    for (let p = node.parent; p && !p.isRoot; p = p.parent) chain.unshift(ids.get(p))
    return chain
  }
  const repeatOf = node => (node.rep ? { id: node.rep.rep.id, index: node.rep.index, role: node.rep.role, count: node.rep.rep.count } : null)
  const parents = ordered.map(p => {
    const chain = chainOf(p)
    const record = { id: ids.get(p), name: p.name, kind: kindOf(p.kind), offset: p.offset, length: p.end - p.offset, level: chain.length, chain }
    if (p.region) record.region = true
    const repeat = repeatOf(p)
    if (repeat) record.repeat = repeat
    return record
  })

  const labels = nodes.map((node, i) => {
    const label = {
      number: i + 1,
      name: node.name,
      value: node.value,
      description: node.description,
      kind: kindOf(node.kind),
      offset: node.offset,
      length: node.end - node.offset,
      start: Math.max(node.offset, window.start),
      end: Math.min(node.end, window.end),
      parents: chainOf(node)
    }
    if (node.region) label.region = true
    if (node.merged) label.merged = { ...node.merged }
    if (node.pinned) label.pinned = true
    if (textOf(node)) label.text = true
    const repeat = repeatOf(node)
    if (repeat) label.repeat = repeat
    return label
  })

  const labelAt = offset => {
    let lo = 0
    let hi = labels.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offset < labels[mid].start) hi = mid - 1
      else if (offset >= labels[mid].end) lo = mid + 1
      else return labels[mid].number
    }
    return null
  }
  const ranges = shownRanges(items)
  const pointers = []
  nodes.forEach((node, i) => {
    const ptr = tree.pointerOf(node)
    if (ptr) pointers.push({ from: i + 1, offset: ptr.offset, target: ptr.target, targetShown: isShown(ranges, ptr.target), targetLabel: labelAt(ptr.target) })
  })

  // Repeats with at least one entry on the poster
  const reps = new Map()
  nodes.forEach((node, i) => {
    for (let n = node; n && !n.isRoot; n = n.parent) {
      if (!n.rep) continue
      const rep = n.rep.rep
      const seen = reps.get(rep)
      if (!seen) reps.set(rep, { firstLabel: i + 1, firstEntryLabel: n.rep.role === 'first' ? i + 1 : null })
      else if (n.rep.role === 'first' && seen.firstEntryLabel === null) seen.firstEntryLabel = i + 1
    }
  })
  const repeats = [...reps].map(([rep, seen]) => {
    const first = rep.members[0]
    const last = rep.members[rep.members.length - 1]
    const lengths = new Set(rep.members.map(m => m.end - m.offset))
    return {
      id: rep.id,
      count: rep.count,
      unit: rep.unit,
      shownEntries: rep.shown.length,
      start: first.offset,
      end: last.end,
      entryLength: lengths.size === 1 ? first.end - first.offset : null,
      first: first.name,
      last: last.name,
      parent: rep.parent.isRoot ? null : ids.get(rep.parent) ?? null,
      firstLabel: seen.firstEntryLabel ?? seen.firstLabel,
      text: tree.summarise(rep)
    }
  }).sort((a, b) => a.start - b.start)

  // The longest stretches of text among the boxes, for the text band
  const texts = labels
    .filter(l => l.text && l.end - l.start >= TEXT_BAND_MIN && readableProse(tree.bytes, l.start, l.end))
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
    .slice(0, TEXT_BAND_MAX)
    .map(l => ({ offset: l.start, length: l.end - l.start, label: l.number, name: l.name }))

  return { labels, parents, pointers, repeats, texts }
}

/**
 * @param {Object} input
 * @param {import('../../analysis/types.js').Analysis|null} input.analysis
 * @param {number} input.size
 * @param {Uint8Array} [input.bytes]                           to tell which fields are all zero
 * @param {'tour'|'auto'|'selection'|'field'} [input.mode]     'tour' when missing
 * @param {{ start: number, end: number }|null} [input.range]   for mode 'selection'
 * @param {number} [input.fieldIndex]                          for mode 'field'
 * @param {Array<{ offset: number, length: number }>} [input.pins]  labelled first in mode 'tour'
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
  let mode = MODES.includes(input.mode) ? input.mode : DEFAULT_OPTIONS.mode

  let window = { start: 0, end: size }
  let fieldSrc = null
  if (mode === 'selection') {
    if (input.range && input.range.end > input.range.start) {
      const start = Math.max(0, Math.min(size, Math.floor(input.range.start)))
      window = { start, end: Math.max(start, Math.min(size, Math.floor(input.range.end))) }
    } else mode = DEFAULT_OPTIONS.mode
  } else if (mode === 'field') {
    fieldSrc = posterSource(input.analysis, size).roots[input.fieldIndex] || null
    if (!fieldSrc) mode = DEFAULT_OPTIONS.mode
  }

  const pins = mode === 'tour' && Array.isArray(input.pins) ? input.pins.slice(0, PIN_CAP) : []
  const tree = createTree({ analysis: input.analysis, size, bytes: input.bytes, pins, withRegions: mode === 'tour' })

  let nodes
  let items
  let available
  let tour = null
  if (mode === 'tour') {
    // The window is the whole file; `shown` (below) spans the first drawn
    // byte to the last, with breaks in between, so it does not claim that
    // every byte in it is drawn
    tour = planTour(tree, { depth, maxLabels, maxRows, bpr })
    nodes = tour.labels
    items = itemsFrom(tour.rows, tour.forced, bpr, size, tour.blankRow)
  } else {
    let base = tree.root
    if (mode === 'field') {
      const node = tree.root.raw.find(n => n.src === fieldSrc)
      if (node) {
        window = { start: node.offset, end: node.end }
        // A field without children is labelled itself
        base = tree.units(node).length ? node : { ...tree.root, raw: [node], units: [node] }
      } else {
        // It overlapped an earlier field: show its bytes and whatever is labelled there
        window = { start: fieldSrc.offset, end: Math.min(size, fieldSrc.offset + Math.floor(fieldSrc.length)) }
      }
    }
    const result = planRange(tree, mode, { window, base, depth, maxLabels, maxRows, bpr, size })
    nodes = result.leaves
    items = result.items
    window = result.window
    available = result.available
  }

  items = describeFill(items, tree.bytes)
  const { labels, parents, pointers, repeats, texts } = describe(tree, nodes, items, window, textChecker(tree))
  items = markTextBreaks(items, labels)
  // omittedLabels: fields within the depth limit that would get a label of
  // their own on a poster without limits but have none here. In tour mode
  // that is counted over the whole file; entries hidden in a collapsed repeat
  // and fields folded into a merged box are not counted (the legend and the
  // notes speak for those).
  if (tour) available = countLeaves(tree, depth)
  const omittedLabels = Math.max(0, available - labels.length)
  const rows = items.filter(i => i.type === 'row')
  return {
    size,
    mode,
    source: tree.source,
    bytesPerRow: bpr,
    depth,
    maxRows,
    maxLabels,
    window,
    items,
    labels,
    parents,
    pointers,
    links: collectLinks(input.analysis, size),
    repeats,
    texts,
    regionsAdded: tree.regionNodes,
    pins: { asked: pins.length, labelled: tour ? tour.pinsLabelled : 0, ignored: tree.pinsIgnored },
    rootsLeft: tour ? tour.rootsLeft : 0,
    // What stopped more labels: the label limit, or the rows (rows may also
    // be left unused on purpose, when all that is left is zeros)
    limitedBy: omittedLabels > 0 || (tour && tour.rootsLeft) ? (labels.length >= maxLabels ? 'labels' : tour ? (tour.rowLimited ? 'rows' : null) : 'rows') : null,
    omittedLabels,
    partialTree: tree.truncated || tree.cutLists > 0,
    shown: rows.length ? { start: rows[0].start, end: rows[rows.length - 1].end } : null
  }
}
