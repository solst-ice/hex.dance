// Pointers: arcs on the file map from each pointer field to what it points
// at, and connectors in the hex dump from a labelled pointer field to its
// target row, routed through a rail of lanes to the right of the dump. Only
// row gaps, the rail and the tag column are used, so a connector never runs
// over the bytes or their text; they are drawn behind the boxes and tabs.

import { textWidth, hex, whole } from './measure.js'

export const MAX_CONNECTORS = 8
export const MAX_LINKS = 400
const LANE = 6
const RAIL_GAP = 12
const TAG_F = 10.5
const TAG_GAP = 8
// Must match layout.js
const BOX_H = 21
const ROW_PITCH = 32
const HEADER_H = 30
const TAB_F = 8.5
const ADVANCE = 0.6
const CW = 14 * ADVANCE

const fx = n => (Math.round(n * 100) / 100).toString()

/** The pointers worth drawing: valid, with a label to start from, at most a few hundred. */
function usablePointers(plan) {
  const list = Array.isArray(plan?.pointers) ? plan.pointers.slice(0, MAX_LINKS) : []
  const byNumber = new Map((plan?.labels || []).map(l => [l.number, l]))
  const out = []
  for (const p of list) {
    if (!p) continue
    const target = whole(p.target)
    if (target === null || target >= plan.size) continue
    const label = byNumber.get(p.from) || (plan.labels || []).find(l => l.offset === p.offset)
    if (!label) continue
    out.push({ label, target, targetLabel: p.targetLabel ?? null })
  }
  return out
}

function tagText(target, more) {
  return `→ ${hex(target)}${more ? ` +${more}` : ''}`
}

/** Room to reserve to the right of the dump for the rail and tags (0 when there are no pointers). */
export function railWidth(plan) {
  const pointers = usablePointers(plan)
  if (!pointers.length) return 0
  const shown = pointers.filter(p => rowOf(plan.items, p.target) >= 0).length
  const lanes = Math.min(MAX_CONNECTORS, shown)
  let tagW = 0
  for (const p of pointers) tagW = Math.max(tagW, textWidth(tagText(p.target, pointers.length > 1 ? 9 : 0), TAG_F))
  return RAIL_GAP + lanes * LANE + TAG_GAP + tagW + 4
}

/** Index of the drawn row holding `offset`, or -1. */
function rowOf(items, offset) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.type === 'row' && offset >= it.start && offset < it.end) return i
  }
  return -1
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
 * @param {number} input.insertAt  index in out.elements to put the lines at (behind the dump)
 * @param {Function} input.fieldRuns  layout.js's fieldRuns (passed in to keep the modules acyclic)
 */
export function drawDumpPointers({ plan, columns, entryOffset, shadeOf, colors, out, insertAt, fieldRuns }) {
  const pointers = usablePointers(plan)
  if (!pointers.length || !columns.length) return { connectors: 0, tags: 0 }
  const items = plan.items
  const bpr = plan.bytesPerRow
  const columnOf = index => columns.findIndex(c => index >= c.start && index < c.end)

  // Where each pointer starts and ends
  const candidates = pointers.map(p => {
    const runs = fieldRuns(items, bpr, p.label.start, p.label.end)
    const run = runs[0]
    const targetIndex = rowOf(items, p.target)
    return { ...p, run, targetIndex }
  }).filter(p => p.run)
  const rank = p => (entryOffset !== null && p.target === entryOffset ? 0 : p.targetLabel !== null ? 1 : 2)
  const drawable = candidates
    .filter(p => p.targetIndex >= 0 && columnOf(p.targetIndex) === columnOf(p.run[0].index))
    .sort((a, b) => rank(a) - rank(b) || a.label.number - b.label.number)

  // Tabs per column, as obstacles in the row gaps
  const tabs = columns.map(() => new Map())
  for (const label of plan.labels) {
    const runs = fieldRuns(items, bpr, label.start, label.end)
    const first = runs[0]?.[0]
    if (!first) continue
    const ci = columnOf(first.index)
    if (ci < 0) continue
    const g = columns[ci].g
    const w = Math.max(14, String(label.number).length * TAB_F * ADVANCE + 7)
    const gap = first.index - columns[ci].start
    const list = tabs[ci].get(gap) || []
    list.push([g.left(first.c0), g.left(first.c0) + w])
    tabs[ci].set(gap, list)
  }

  const chosen = []
  const tracks = columns.map(() => new Map()) // gap -> [track0 intervals, track1 intervals]
  const used = new Set()
  for (const p of drawable) {
    if (chosen.length >= MAX_CONNECTORS) break
    const ci = columnOf(p.run[0].index)
    const col = columns[ci]
    const g = col.g
    const laneEdge = g.asciiEnd + RAIL_GAP
    const local = i => i - col.start
    const tc = p.target - items[p.targetIndex].row * bpr
    const cellRight = g.right(tc)
    let best = null
    for (const srcSide of ['below', 'above']) {
      const seg = srcSide === 'below' ? p.run[p.run.length - 1] : p.run[0]
      const sx = g.right(seg.c1) - 6
      const sGap = local(seg.index) + (srcSide === 'below' ? 1 : 0)
      for (const tgtSide of ['above', 'below']) {
        const tGap = local(p.targetIndex) + (tgtSide === 'below' ? 1 : 0)
        // Aim at the middle of the target byte, or past a tab sitting on it
        let tx = g.colX(tc) + CW
        const onTab = (tabs[ci].get(tGap) || []).find(([a, b]) => tx > a - 3 && tx < b + 3)
        if (onTab && onTab[1] + 4 <= cellRight - 2) tx = onTab[1] + 4
        for (const sTrack of [0, 1]) {
          for (const tTrack of [0, 1]) {
            if (sGap === tGap && sTrack === tTrack) continue
            const sSpan = [Math.min(sx, laneEdge), laneEdge]
            const tSpan = [Math.min(tx, laneEdge), laneEdge]
            const busy = (gap, track, span) => (tracks[ci].get(gap)?.[track] || []).some(([a, b]) => span[0] < b + 3 && a < span[1] + 3)
            if (busy(sGap, sTrack, sSpan) || busy(tGap, tTrack, tSpan)) continue
            const crossings = (gap, span) => (tabs[ci].get(gap) || []).filter(([a, b]) => span[0] < b && a < span[1]).length
            // The arrow's last stretch must not land on a tab
            const tipBlocked = tgtSide === 'above' && (tabs[ci].get(tGap) || []).some(([a, b]) => tx > a - 3 && tx < b + 3)
            const stubBlocked = srcSide === 'above' && (tabs[ci].get(sGap) || []).some(([a, b]) => sx > a - 2 && sx < b + 2)
            // The arrowhead wants room: a far track for a tip from above, a near one from below
            const tipRoom = tgtSide === 'above' ? (tTrack === 0 ? 0 : 1) : (tTrack === 1 ? 0 : 1)
            const score = 0.6 * (crossings(sGap, sSpan) + crossings(tGap, tSpan)) + Math.min(3, Math.abs(tGap - sGap)) + (tipBlocked ? 100 : 0) + (stubBlocked ? 6 : 0) + tipRoom * 2 +
              (tgtSide === 'below' ? 0.5 : 0) + (srcSide === 'above' ? 0.5 : 0)
            if (!best || score < best.score) best = { score, srcSide, tgtSide, sGap, tGap, sTrack, tTrack, sx, tx, sSpan, tSpan, seg }
          }
        }
      }
    }
    if (!best || best.score >= 100) continue
    const mark = (gap, track, span) => {
      const entry = tracks[ci].get(gap) || [[], []]
      entry[track].push(span)
      tracks[ci].set(gap, entry)
    }
    mark(best.sGap, best.sTrack, best.sSpan)
    mark(best.tGap, best.tTrack, best.tSpan)
    chosen.push({ p, ci, ...best })
    used.add(p)
  }

  // Lanes: the shortest connectors nearest the dump, one lane each
  const elements = []
  const arrows = []
  const lanesPerColumn = columns.map(() => 0)
  const gapY = (gap, track) => HEADER_H + gap * ROW_PITCH + (track ? 7.5 : 3)
  const byColumn = columns.map((_, ci) => chosen.filter(c => c.ci === ci).sort((a, b) => Math.abs(a.tGap - a.sGap) - Math.abs(b.tGap - b.sGap)))
  byColumn.forEach((list, ci) => {
    const col = columns[ci]
    const g = col.g
    list.forEach((c, lane) => {
      lanesPerColumn[ci]++
      const color = shadeOf(c.p.label)
      const laneX = col.ox + g.asciiEnd + RAIL_GAP + lane * LANE + LANE / 2
      const sEdge = col.oy + g.boxTop(c.seg.index - col.start) + (c.srcSide === 'below' ? BOX_H : 0)
      const sY = col.oy + gapY(c.sGap, c.sTrack)
      const tY = col.oy + gapY(c.tGap, c.tTrack)
      const tRow = c.p.targetIndex - col.start
      const tEdge = col.oy + g.boxTop(tRow) + (c.tgtSide === 'below' ? BOX_H : 0)
      const sx = col.ox + c.sx
      const tx = col.ox + c.tx
      const head = 4.5
      const dir = c.tgtSide === 'above' ? 1 : -1
      const tipBase = tEdge - dir * head
      const d = `M${fx(sx)} ${fx(sEdge)}V${fx(sY)}H${fx(laneX)}V${fx(tY)}H${fx(tx)}V${fx(tipBase)}`
      elements.push({ t: 'path', d, stroke: color, sw: 1.4, g: `pointer:${c.p.label.number}` })
      elements.push({ t: 'rect', x: sx - 1.8, y: sEdge - 1.8, w: 3.6, h: 3.6, rx: 1, fill: color, g: `pointer:${c.p.label.number}` })
      arrows.push({ t: 'poly', points: [[tx, tEdge], [tx - 3.2, tipBase], [tx + 3.2, tipBase]], fill: color, g: `pointer:${c.p.label.number}` })
      out.boxes.push({ role: 'rail', x: laneX - 0.7, y: Math.min(sY, tY) - 0.7, w: 1.4, h: Math.abs(tY - sY) + 1.4, id: c.p.label.number })
    })
  })

  // Tags for the rest, one per row, after the rail
  const tagRows = new Map()
  for (const p of candidates) {
    if (used.has(p)) continue
    const index = p.run[0].index
    const list = tagRows.get(index) || []
    list.push(p)
    tagRows.set(index, list)
  }
  let tagCount = 0
  for (const [index, list] of tagRows) {
    const ci = columnOf(index)
    if (ci < 0) continue
    const col = columns[ci]
    const g = col.g
    const x = col.ox + g.asciiEnd + RAIL_GAP + lanesPerColumn[ci] * LANE + TAG_GAP
    const baseline = col.oy + g.boxTop(index - col.start) + BOX_H / 2 + TAG_F * 0.36
    const first = list[0]
    const spans = [{ text: `→ ${hex(first.target)}`, fill: shadeOf(first.label) }]
    if (list.length > 1) spans.push({ text: ` +${list.length - 1}`, fill: colors.faint })
    const text = spans.map(s => s.text).join('')
    out.elements.push({ t: 'text', x, y: baseline, size: TAG_F, fill: colors.muted, spans, preserve: true, g: `ptag:${index}` })
    out.boxes.push({ role: 'ptag', x, y: baseline - 9, w: textWidth(text, TAG_F), h: 12 })
    tagCount++
  }

  out.elements.splice(insertAt, 0, ...elements)
  out.elements.push(...arrows)
  return { connectors: chosen.length, tags: tagCount, lanes: lanesPerColumn }
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
  const n = links.length
  const sw = n <= 8 ? 1.4 : n <= 40 ? 1.1 : n <= 150 ? 0.8 : 0.55
  const opacity = n <= 8 ? 0.95 : n <= 40 ? 0.7 : n <= 150 ? 0.45 : 0.32
  const color = colors.shades.offset[0]
  const heads = new Set()
  const top = barY - 2
  const arcs = []
  const tips = []
  for (const l of links) {
    const x1 = sx(l.from)
    const x2 = sx(l.target)
    const dx = Math.abs(x2 - x1)
    const tipKey = Math.round(x2 * 2)
    if (!heads.has(tipKey)) {
      heads.add(tipKey)
      const s = n <= 40 ? 3.4 : 2.4
      tips.push({ t: 'poly', points: [[x2, top + 1], [x2 - s * 0.8, top - s * 1.3], [x2 + s * 0.8, top - s * 1.3]], fill: color, fillOpacity: Math.min(1, opacity + 0.2) })
    }
    if (dx < 2) continue
    const h = 6 + (ARC_ZONE - 8) * Math.min(1, dx / width)
    // A quadratic curve: arcs leaving one place spread out like a fan
    arcs.push({ t: 'path', d: `M${fx(x1)} ${fx(top)}Q${fx((x1 + x2) / 2)} ${fx(top - 2 * h)} ${fx(x2)} ${fx(top - 3)}`, stroke: color, sw, opacity })
  }
  out.elements.push(...arcs, ...tips)
  out.boxes.push({ role: 'arcs', x, y: barY - ARC_ZONE, w: width, h: ARC_ZONE - 2 })
}
