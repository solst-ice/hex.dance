// Pointers: arcs on the file map from each pointer field to what it points
// at, and connectors in the hex dump. A connector lives entirely in a rail to
// the right of the dump's text column, so it never crosses bytes and can
// never be mistaken for a field outline: a badge with the pointing label's
// number at the right end of the source row, a line down (or up) its own
// lane, and an arrowhead with the target's number at the right end of the
// target row. Pointers without a connector get tags in a column after the
// rail; a target on a drawn row gets a matching "← n" tag, the way
// schematics pair off-sheet connectors.

import { truncate } from './escape.js'
import { textWidth, hex, whole } from './measure.js'

export const MAX_CONNECTORS = 8
export const MAX_LINKS = 400
const LANE = 6
const RAIL_GAP = 10
const END_GAP = 4
const TAG_F = 10.5
const TAG_GAP = 10
const TAG_CHARS = 26
const BADGE_F = 8.5
const MARK_F = 9
const ARROW = 6
// Must match layout.js
const BOX_H = 21

const fx = n => (Math.round(n * 100) / 100).toString()

/** First drawn row (item index) holding any byte of [start, end), or -1. */
function firstRowOf(items, start, end = start + 1) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.type === 'row' && it.start < end && start < it.end) return i
  }
  return -1
}

const badgeWidth = n => Math.max(14, String(n).length * BADGE_F * 0.62 + 7)
const markText = p => (p.targetLabel !== null ? String(p.targetLabel) : hex(p.target))
const markWidth = p => ARROW + 2 + textWidth(markText(p), MARK_F) + 2

/**
 * Every usable pointer with where it starts and ends on the dump, ranked by
 * how much it tells about how the file hangs together.
 */
function pointerModel(plan, entryOffset = null) {
  const list = Array.isArray(plan?.pointers) ? plan.pointers.slice(0, MAX_LINKS) : []
  const labels = Array.isArray(plan?.labels) ? plan.labels : []
  const items = Array.isArray(plan?.items) ? plan.items : []
  const byNumber = new Map(labels.map(l => [l.number, l]))
  const structureOf = label => (label ? (label.parents?.length ? `p${label.parents[0]}` : `l${label.number}`) : null)
  const out = []
  for (const p of list) {
    if (!p) continue
    const target = whole(p.target)
    if (target === null || target >= plan.size) continue
    const label = byNumber.get(p.from) || labels.find(l => l.offset === p.offset)
    if (!label) continue
    const sourceIndex = firstRowOf(items, label.start, label.end)
    if (sourceIndex < 0) continue
    const targetIndex = firstRowOf(items, target)
    let targetLabel = Number.isSafeInteger(p.targetLabel) && byNumber.has(p.targetLabel) ? p.targetLabel : null
    if (targetLabel === null) targetLabel = labels.find(l => target >= l.start && target < l.end)?.number ?? null
    const tl = targetLabel === null ? null : byNumber.get(targetLabel)
    // Entry point first; then pointers from one structure to another (a
    // header to the next header, a header to the data it describes); hops
    // inside one table last
    const cross = structureOf(tl) !== structureOf(label)
    const rank = entryOffset !== null && target === entryOffset ? 0 : cross ? (tl ? 1 : 2) : 3
    out.push({ label, target, targetLabel, sourceIndex, targetIndex, rank })
  }
  out.sort((a, b) => a.rank - b.rank || a.label.number - b.label.number)
  return out
}

/** Tag pieces per row when the pointers in `tagged` get no connector. */
function rowTags(model, tagged) {
  const rows = new Map()
  const at = index => {
    let r = rows.get(index)
    if (!r) rows.set(index, (r = { out: [], into: [] }))
    return r
  }
  for (const p of model) {
    if (!tagged.has(p)) continue
    const paired = p.targetIndex >= 0
    at(p.sourceIndex).out.push({ p, text: paired && p.targetLabel !== null ? `→ ${p.targetLabel} · ${hex(p.target)}` : `→ ${hex(p.target)}` })
    if (paired) {
      const r = at(p.targetIndex)
      if (!r.into.some(q => q.label.number === p.label.number)) r.into.push(p)
    }
  }
  return rows
}

/** The spans of one row's tag, cut to `chars` characters with a "+n" for what does not fit. */
function tagSpans(row, chars, shadeOf, colors) {
  const pieces = row.out.map(o => ({ text: o.text, fill: shadeOf(o.p.label) }))
  if (row.into.length) {
    const numbers = [...new Set(row.into.map(p => p.label.number))].sort((a, b) => a - b)
    pieces.push({ text: `← ${numbers.join(', ')}`, fill: shadeOf(row.into[0].label) })
  }
  const spans = []
  let used = 0
  for (let i = 0; i < pieces.length; i++) {
    const sep = spans.length ? '  ' : ''
    const rest = pieces.length - i - 1
    const more = rest ? ` +${rest}`.length : 0
    const len = sep.length + pieces[i].text.length
    if (used + len + more > chars) {
      const left = pieces.length - i
      if (spans.length) spans.push({ text: ` +${left}`, fill: colors.faint })
      else spans.push({ text: truncate(pieces[i].text, chars), fill: pieces[i].fill })
      break
    }
    spans.push({ text: sep + pieces[i].text, fill: pieces[i].fill })
    used += len
  }
  return spans
}

function railGeometry(model) {
  const eligible = model.filter(p => p.targetIndex >= 0 && p.targetIndex !== p.sourceIndex)
  let endW = 0
  for (const p of eligible) endW = Math.max(endW, badgeWidth(p.label.number), markWidth(p))
  const lanes = Math.min(MAX_CONNECTORS, eligible.length)
  const all = rowTags(model, new Set(model))
  let tagChars = 0
  for (const row of all.values()) tagChars = Math.max(tagChars, tagSpans(row, TAG_CHARS, () => '', {}).reduce((s, x) => s + x.text.length, 0))
  const lanesW = lanes ? endW + END_GAP + lanes * LANE : 0
  const tagW = tagChars * TAG_F * 0.62
  return { endW, lanes, lanesW, tagChars, tagX: RAIL_GAP + lanesW + (lanes ? TAG_GAP : 0), width: RAIL_GAP + lanesW + (tagChars ? (lanes ? TAG_GAP : 0) + tagW : 0) + 4 }
}

/** Room to reserve to the right of the dump for the rail and tags (0 when there are no pointers). */
export function railWidth(plan, entryOffset = null) {
  const model = pointerModel(plan, entryOffset)
  return model.length ? railGeometry(model).width : 0
}

/**
 * Draws connectors and tags for one or more dump columns.
 * @param {Object} input
 * @param {Object} input.plan
 * @param {Array<{ start: number, end: number, ox: number, oy: number, g: Object }>} input.columns
 *        each column shows plan.items[start, end) at (ox, oy) with geometry g
 * @param {number|null} input.entryOffset
 * @param {(label: Object) => string} input.shadeOf
 * @param {Object} input.colors
 * @param {Object} input.out
 */
export function drawDumpPointers({ plan, columns, entryOffset, shadeOf, colors, out }) {
  const model = pointerModel(plan, entryOffset)
  if (!model.length || !columns.length) return { connectors: 0, tags: 0 }
  const rail = railGeometry(model)
  const columnOf = index => columns.findIndex(c => index >= c.start && index < c.end)

  // Choose connectors: same column, not a same-row hop, and each row end
  // holds one badge or one arrowhead
  const ends = new Map()
  const chosen = []
  for (const p of model) {
    if (chosen.length >= MAX_CONNECTORS) break
    if (p.targetIndex < 0 || p.targetIndex === p.sourceIndex) continue
    const ci = columnOf(p.sourceIndex)
    if (ci < 0 || ci !== columnOf(p.targetIndex)) continue
    if (ends.has(p.sourceIndex) || ends.has(p.targetIndex)) continue
    ends.set(p.sourceIndex, p)
    ends.set(p.targetIndex, p)
    chosen.push({ p, ci })
  }

  // Lanes: shortest spans nearest the rows, so connectors nest
  const tops = []
  const marks = []
  const mid = (col, index) => col.oy + col.g.boxTop(index - col.start) + BOX_H / 2
  columns.forEach((col, ci) => {
    const mine = chosen.filter(c => c.ci === ci).sort((a, b) => Math.abs(a.p.targetIndex - a.p.sourceIndex) - Math.abs(b.p.targetIndex - b.p.sourceIndex) || a.p.sourceIndex - b.p.sourceIndex)
    const x0 = col.ox + col.g.asciiEnd + RAIL_GAP
    mine.forEach((c, lane) => {
      const { p } = c
      const g = `pointer:${p.label.number}`
      const color = shadeOf(p.label)
      const ys = mid(col, p.sourceIndex)
      const yt = mid(col, p.targetIndex)
      const lx = x0 + rail.endW + END_GAP + lane * LANE + LANE / 2
      const bw = badgeWidth(p.label.number)
      const mw = markWidth(p)
      const dir = yt > ys ? 1 : -1
      const r = Math.min(4, Math.abs(yt - ys) / 2)
      const d = `M${fx(x0 + bw)} ${fx(ys)}H${fx(lx - r)}Q${fx(lx)} ${fx(ys)} ${fx(lx)} ${fx(ys + dir * r)}V${fx(yt - dir * r)}Q${fx(lx)} ${fx(yt)} ${fx(lx - r)} ${fx(yt)}H${fx(x0 + mw)}`
      tops.push({ t: 'path', d, stroke: color, sw: 1.1, g })
      // Source: the pointing label's number
      marks.push({ t: 'rect', x: x0, y: ys - 6, w: bw, h: 12, rx: 3, fill: color, g })
      marks.push({ t: 'text', x: x0 + bw / 2, y: ys + 3, size: BADGE_F, weight: 700, fill: colors.tabText, anchor: 'middle', text: String(p.label.number), g })
      // Target: an arrowhead into the row and what it points at
      marks.push({ t: 'poly', points: [[x0, yt], [x0 + ARROW, yt - 3.5], [x0 + ARROW, yt + 3.5]], fill: color, g })
      marks.push({ t: 'text', x: x0 + ARROW + 2, y: yt + 3.2, size: MARK_F, weight: 700, fill: color, text: markText(p), g })
      out.boxes.push({ role: 'pend', x: x0, y: ys - 6, w: bw, h: 12, id: p.label.number })
      out.boxes.push({ role: 'pend', x: x0, y: yt - 6, w: mw, h: 12, id: p.label.number })
      out.boxes.push({ role: 'rail', x: lx - 0.6, y: Math.min(ys, yt) - 0.6, w: 1.2, h: Math.abs(yt - ys) + 1.2, id: p.label.number })
    })
  })
  out.elements.push(...tops, ...marks)

  // Tags for everything else, one line per row, after the rail
  const connected = new Set(chosen.map(c => c.p))
  const rows = rowTags(model, new Set(model.filter(p => !connected.has(p))))
  let tagCount = 0
  for (const [index, row] of rows) {
    const ci = columnOf(index)
    if (ci < 0) continue
    const col = columns[ci]
    const spans = tagSpans(row, rail.tagChars || TAG_CHARS, shadeOf, colors)
    if (!spans.length) continue
    const x = col.ox + col.g.asciiEnd + rail.tagX
    const y = mid(col, index) + TAG_F * 0.36
    const text = spans.map(s => s.text).join('')
    out.elements.push({ t: 'text', x, y, size: TAG_F, fill: colors.muted, spans, preserve: true, g: `ptag:${index}` })
    out.boxes.push({ role: 'ptag', x, y: y - 9, w: textWidth(text, TAG_F), h: 12 })
    tagCount++
  }
  return { connectors: chosen.length, tags: tagCount }
}

/** Pointer links for the file map: valid and inside the file. */
export function mapLinks(plan) {
  const list = Array.isArray(plan?.links) ? plan.links.slice(0, MAX_LINKS) : []
  const out = []
  for (const l of list) {
    const offset = whole(l?.offset)
    const target = whole(l?.target)
    const length = whole(l?.length) ?? 1
    if (offset === null || target === null || offset >= plan.size || target >= plan.size) continue
    out.push({ from: offset + Math.min(length, plan.size - offset) / 2, target })
  }
  return out
}

/** How tall the arcs may get above the file map's bar. */
export const ARC_ZONE = 58

/**
 * Arcs above the file map's bar, from each pointer field to its target, with
 * an arrowhead at the target. Thinner and fainter as there are more of them.
 */
export function drawMapArcs({ links, x, width, barY, size, colors, out }) {
  if (!links.length || size <= 0) return
  const sx = n => x + (n / size) * width
  // One arc per distinct pair of pixels, so duplicate links add nothing
  const pairs = new Map()
  for (const l of links) {
    const x1 = sx(l.from)
    const x2 = sx(l.target)
    const key = `${Math.round(x1)}:${Math.round(x2)}`
    if (!pairs.has(key)) pairs.set(key, [x1, x2])
  }
  const n = pairs.size
  const sw = n <= 8 ? 1.3 : n <= 40 ? 0.9 : n <= 150 ? 0.55 : 0.4
  const opacity = n <= 8 ? 0.95 : n <= 40 ? 0.6 : n <= 150 ? 0.3 : 0.22
  const color = colors.shades.offset[0]
  const heads = new Set()
  const top = barY - 2
  // Height grows with distance, so arcs leaving one place nest inside one
  // another and separate into rays as they go
  const peak = ARC_ZONE - 8
  const arcs = []
  const tips = []
  for (const [x1, x2] of pairs.values()) {
    const dx = Math.abs(x2 - x1)
    const tipKey = Math.round(x2 * 2)
    if (!heads.has(tipKey)) {
      heads.add(tipKey)
      const s = n <= 40 ? 3.4 : 2.4
      tips.push({ t: 'poly', points: [[x2, top + 1], [x2 - s * 0.8, top - s * 1.3], [x2 + s * 0.8, top - s * 1.3]], fill: color, fillOpacity: Math.min(1, opacity + 0.35) })
    }
    if (dx < 2) continue
    const h = 4 + (peak - 4) * Math.min(1, dx / width)
    arcs.push({ t: 'path', d: `M${fx(x1)} ${fx(top)}Q${fx((x1 + x2) / 2)} ${fx(top - 2 * h)} ${fx(x2)} ${fx(top - 3)}`, stroke: color, sw, opacity })
  }
  out.elements.push(...arcs, ...tips)
  out.boxes.push({ role: 'arcs', x, y: barY - ARC_ZONE, w: width, h: ARC_ZONE - 2 })
}
