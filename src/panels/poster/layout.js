// Poster geometry. Everything is laid out in SVG user units with a monospace
// face whose advance is assumed to be 0.6em; hex and text columns position
// every character explicitly, so the dump lines up whatever font the viewer
// has. The result is a flat scene (shapes and text with absolute
// coordinates) plus the boxes of every label, which tests check for overlaps.

import { truncate, textLength } from './escape.js'
import { KIND_LABELS, BYTE_CLASSES, BYTE_CLASS_LABELS, byteClass, assignShades, kindOf, regionKindOf } from './palette.js'

export const ADVANCE = 0.6
export const PROPORTIONS = { landscape: Math.SQRT2, portrait: 1 / Math.SQRT2, square: 1 }

const F = 14 // hex font size
const CW = F * ADVANCE
const ROW_PITCH = 32
const BOX_H = 21
const ROW_GAP = ROW_PITCH - BOX_H
const PAD = 2.4
const TAB_H = 10
const TAB_F = 8.5
const HEADER_H = 30
const BRACKET_STEP = 7

const LF = 12.5 // legend font size
const LEGEND_W = 384
const COL_GAP = 28
const BODY_GAP = 48

const MARGIN = 56
const MIN_INNER_W = 920
const HEAD_H = 196
const FOOT_H = 44

const HEX = Array.from({ length: 256 }, (_, v) => v.toString(16).toUpperCase().padStart(2, '0'))

export function hexOffset(n, digits = 1) {
  return '0x' + n.toString(16).toUpperCase().padStart(digits, '0')
}

export function formatCount(n) {
  return Math.round(n).toLocaleString('en-US')
}

export function formatSize(n) {
  if (n < 1024) return `${formatCount(n)} byte${n === 1 ? '' : 's'}`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

// Text is measured a little wide so fonts slightly broader than 0.6em still fit
const MEASURE = 0.62
const textWidth = (text, size) => textLength(text) * size * MEASURE

function charsFor(width, size) {
  return Math.max(0, Math.floor(width / (size * MEASURE)))
}

// --- Hex dump -------------------------------------------------------------

function hexGeometry(plan) {
  const bpr = plan.bytesPerRow
  const digits = Math.max(4, Math.max(0, plan.size - 1).toString(16).length)
  const levels = plan.labels.reduce((max, l) => Math.max(max, l.parents.length), 0)
  const offW = (digits + 2) * CW
  const gutterX = offW + 12
  // Two bracket columns per level, so neighbouring parents never share one
  const gutterW = levels ? levels * 2 * BRACKET_STEP : 0
  const hexX = gutterX + gutterW + (levels ? 12 : 4)
  const colX = c => hexX + c * 3 * CW + Math.floor(c / 8) * CW
  const hexEnd = colX(bpr - 1) + 2 * CW
  const asciiX = hexEnd + 2.5 * CW
  const asciiEnd = asciiX + bpr * CW
  const rowTop = i => HEADER_H + i * ROW_PITCH
  const boxTop = i => rowTop(i) + ROW_GAP
  return {
    bpr, digits, levels, offW, gutterX, hexX, colX, hexEnd, asciiX, asciiEnd, rowTop, boxTop,
    left: c => colX(c) - PAD,
    right: c => colX(c) + 2 * CW + PAD,
    width: asciiEnd,
    height: plan.items.length ? HEADER_H + plan.items.length * ROW_PITCH + 6 : 0
  }
}

/** Visible pieces of a byte range, grouped into runs of consecutive drawn rows. */
export function fieldRuns(items, bpr, start, end) {
  const runs = []
  let current = null
  let lastIndex = -2
  items.forEach((item, index) => {
    if (item.type !== 'row') return
    const s = Math.max(start, item.start)
    const e = Math.min(end, item.end)
    if (e <= s) return
    const segment = { index, c0: s - item.row * bpr, c1: e - 1 - item.row * bpr }
    const previousItem = items[lastIndex]
    if (current && index === lastIndex + 1 && previousItem && previousItem.row === item.row - 1) current.push(segment)
    else {
      current = [segment]
      runs.push(current)
    }
    lastIndex = index
  })
  return runs
}

/**
 * Outline of one run as rectangles or a single polygon that follows the
 * bytes across row ends.
 * @returns {Array<{ type: 'rect', x: number, y: number, w: number, h: number } | { type: 'poly', points: number[][] }>}
 */
export function runShapes(run, g) {
  const top = i => g.boxTop(i)
  const bottom = i => g.boxTop(i) + BOX_H
  const rect = s => ({ type: 'rect', x: g.left(s.c0), y: top(s.index), w: g.right(s.c1) - g.left(s.c0), h: BOX_H })
  if (run.length === 1) return [rect(run[0])]
  const first = run[0]
  const last = run[run.length - 1]
  if (run.length === 2 && last.c1 < first.c0) return [rect(first), rect(last)]
  const x0 = g.left(0)
  const xe = g.right(g.bpr - 1)
  const xa = g.left(first.c0)
  const xb = g.right(last.c1)
  const raw = [
    [xa, top(first.index)], [xe, top(first.index)], [xe, bottom(last.index - 1)], [xb, bottom(last.index - 1)],
    [xb, bottom(last.index)], [x0, bottom(last.index)], [x0, top(first.index + 1)], [xa, top(first.index + 1)]
  ]
  const points = []
  for (const p of raw) {
    const prev = points[points.length - 1]
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) points.push(p)
  }
  if (points.length > 1 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]) points.pop()
  return [{ type: 'poly', points }]
}

function breakText(item) {
  const n = item.end - item.start
  const count = n === 1 ? '1 byte' : `${formatCount(n)} bytes`
  const range = `${hexOffset(item.start)}–${hexOffset(item.end - 1)}`
  if (item.where === 'after') return [`… ${count} more to the end of the file (${range}) …`, `… ${count} more …`]
  if (item.where === 'before') return [`… first ${count} not shown (${range}) …`, `… ${count} before …`]
  return [`… ${count} not shown (${range}) …`, `… ${count} not shown …`, `… ${formatSize(n)} …`]
}

function hexDump(plan, bytes, colors, shadeOf, parentShade, ox, oy, out) {
  const g = hexGeometry(plan)
  const { bpr } = g
  const el = out.elements
  const muted = colors.muted

  // Column header
  const headerXs = []
  let header = ''
  for (let c = 0; c < bpr; c++) {
    const x = ox + g.colX(c)
    if (c) {
      header += ' '
      headerXs.push(x - CW * 0.5)
    }
    header += HEX[c]
    headerXs.push(x + CW * 0.1, x + CW * 1.1)
  }
  el.push({ t: 'text', x: ox + g.hexX, y: oy + 16, size: F * 0.72, fill: colors.faint, spans: [{ text: header, xs: headerXs }] })
  el.push({ t: 'text', x: ox + g.offW, y: oy + 16, size: F * 0.72, fill: colors.faint, anchor: 'end', text: 'offset' })
  el.push({ t: 'text', x: ox + g.asciiX, y: oy + 16, size: F * 0.72, fill: colors.faint, text: 'text' })

  // Field boxes (behind the text)
  const inField = []
  for (const label of plan.labels) {
    const color = shadeOf(label)
    const runs = fieldRuns(plan.items, bpr, label.start, label.end)
    runs.forEach((run, r) => {
      for (const shape of runShapes(run, g)) {
        if (shape.type === 'rect') {
          el.push({ t: 'rect', x: ox + shape.x, y: oy + shape.y, w: shape.w, h: shape.h, rx: 3, fill: color, fillOpacity: colors.fillOpacity, stroke: color, sw: 1.3 })
        } else {
          el.push({ t: 'poly', points: shape.points.map(([x, y]) => [ox + x, oy + y]), fill: color, fillOpacity: colors.fillOpacity, stroke: color, sw: 1.3 })
        }
      }
      for (const seg of run) {
        inField.push({ index: seg.index, c0: seg.c0, c1: seg.c1 })
        el.push({ t: 'rect', x: ox + g.asciiX + seg.c0 * CW, y: oy + g.boxTop(seg.index) + 1.5, w: (seg.c1 - seg.c0 + 1) * CW, h: BOX_H - 3, fill: color, fillOpacity: colors.textFillOpacity * 1.6 })
      }
      if (r === 0) {
        const first = run[0]
        const label_ = String(label.number)
        const w = Math.max(14, label_.length * TAB_F * ADVANCE + 7)
        const x = ox + g.left(first.c0)
        const y = oy + g.boxTop(first.index) - TAB_H
        const g_ = `tab:${label.number}`
        el.push({ t: 'tab', x, y, w, h: TAB_H, fill: color, g: g_ })
        el.push({ t: 'text', x: x + w / 2, y: y + TAB_H - 2.2, size: TAB_F, fill: colors.tabText, weight: 700, anchor: 'middle', text: label_, g: g_ })
        out.boxes.push({ role: 'tab', x, y, w, h: TAB_H, id: label.number })
      }
    })
  }

  // Parent brackets in the gutter
  const lastAtLevel = []
  for (const parent of plan.parents) {
    const alt = lastAtLevel[parent.level] === 0 ? 1 : 0
    lastAtLevel[parent.level] = alt
    const items = plan.items
    let first = -1
    let last = -1
    const pEnd = parent.offset + parent.length
    items.forEach((item, index) => {
      if (item.end > parent.offset && item.start < pEnd && (item.type === 'row' || (first >= 0))) {
        if (first < 0) first = index
        last = index
      }
    })
    while (last > first && items[last].type === 'break') last--
    if (first < 0) continue
    const color = parentShade(parent)
    const x = ox + g.gutterX + (parent.level * 2 + alt) * BRACKET_STEP
    const y1 = oy + g.boxTop(first) + 1
    const y2 = oy + g.boxTop(last) + BOX_H - 1
    const openTop = parent.offset < items[first].start
    const openBottom = pEnd > items[last].end
    const d = `M${fx(x + 4)} ${fx(y1)}${openTop ? 'm-4 0' : 'h-4'}V${fx(y2)}${openBottom ? '' : 'h4'}`
    el.push({ t: 'path', d, stroke: color, sw: 2, fill: 'none' })
  }

  // Rows and breaks
  const fieldCells = new Map()
  for (const seg of inField) {
    let set = fieldCells.get(seg.index)
    if (!set) fieldCells.set(seg.index, (set = new Set()))
    for (let c = seg.c0; c <= seg.c1; c++) set.add(c)
  }
  plan.items.forEach((item, index) => {
    const baseline = oy + g.boxTop(index) + BOX_H / 2 + F * 0.35
    if (item.type === 'break') {
      const y = oy + g.boxTop(index) + BOX_H / 2
      const x1 = ox + g.hexX - PAD
      const x2 = ox + g.asciiEnd
      el.push({ t: 'line', x1, y1: y, x2, y2: y, stroke: colors.rule, sw: 1.2, dash: '2 5' })
      const room = x2 - x1 - 24
      const size = F * 0.8
      const options = breakText(item)
      const text = options.find(t => textWidth(t, size) <= room) || truncate(options[options.length - 1], charsFor(room, size))
      const w = textWidth(text, size) + 16
      const cx = (x1 + x2) / 2
      el.push({ t: 'rect', x: cx - w / 2, y: y - 9, w, h: 18, rx: 9, fill: colors.background, stroke: colors.rule, sw: 1, g: `break:${index}` })
      el.push({ t: 'text', x: cx, y: y + size * 0.35, size, fill: colors.muted, anchor: 'middle', text, g: `break:${index}` })
      out.boxes.push({ role: 'break', x: cx - w / 2, y: y - 9, w, h: 18 })
      el.push({ t: 'text', x: ox + g.offW, y: baseline, size: F * 0.85, fill: colors.faint, anchor: 'end', text: '⋮' })
      return
    }
    el.push({ t: 'text', x: ox + g.offW, y: baseline, size: F * 0.85, fill: muted, anchor: 'end', text: hexOffset(item.row * bpr, g.digits) })
    const cells = fieldCells.get(index)
    const hexSpans = []
    const textSpans = []
    for (let offset = item.start; offset < item.end; offset++) {
      const c = offset - item.row * bpr
      const v = bytes[offset] ?? 0
      const boxed = cells?.has(c)
      const fill = boxed ? colors.text : colors.bytes[byteClass(v)]
      const x = ox + g.colX(c)
      const leading = hexSpans.length > 0 || offset > item.start
      pushSpan(hexSpans, fill, (leading ? ' ' : '') + HEX[v], leading ? [x - CW * 0.5, x, x + CW] : [x, x + CW])
      const ch = v > 0x20 && v < 0x7f ? String.fromCharCode(v) : v === 0x20 ? '\u00a0' : v === 0 ? '·' : '.'
      pushSpan(textSpans, boxed ? colors.text : colors.bytes[byteClass(v)], ch, [ox + g.asciiX + c * CW])
    }
    if (hexSpans.length) el.push({ t: 'text', x: hexSpans[0].xs[0], y: baseline, size: F, spans: hexSpans, cls: 'hex' })
    if (textSpans.length) el.push({ t: 'text', x: textSpans[0].xs[0], y: baseline, size: F, spans: textSpans, cls: 'txt' })
  })
  return g
}

function pushSpan(spans, fill, text, xs) {
  const last = spans[spans.length - 1]
  if (last && last.fill === fill) {
    last.text += text
    last.xs.push(...xs)
  } else {
    spans.push({ fill, text, xs: [...xs] })
  }
}

const fx = n => (Math.round(n * 100) / 100).toString()

// --- Legend ---------------------------------------------------------------

function chainName(plan, ids) {
  const byId = new Map(plan.parents.map(p => [p.id, p]))
  return ids.map(id => byId.get(id)?.name ?? '').filter(Boolean).join(' › ')
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (textLength(candidate) <= maxChars) line = candidate
    else {
      if (line) lines.push(line)
      line = textLength(word) > maxChars ? truncate(word, maxChars) : word
    }
  }
  if (line) lines.push(line)
  return lines
}

/** Blocks of the legend column, each with a height and a draw function. */
function legendBlocks(plan, colors, shadeOf, parentShade, notes) {
  const blocks = []
  const width = LEGEND_W

  // Kinds present on this poster
  const kinds = [...new Set(plan.labels.map(l => kindOf(l.kind)))]
  if (kinds.length) {
    const chips = kinds.map(k => ({ kind: k, text: KIND_LABELS[k], w: 14 + textWidth(KIND_LABELS[k], 11) + 14 }))
    const lines = [[]]
    let used = 0
    for (const chip of chips) {
      if (used + chip.w > width && lines[lines.length - 1].length) {
        lines.push([])
        used = 0
      }
      lines[lines.length - 1].push(chip)
      used += chip.w
    }
    blocks.push({
      type: 'kinds',
      h: lines.length * 18 + 14,
      draw(x, y, out) {
        lines.forEach((line, i) => {
          let cx = x
          const cy = y + i * 18
          for (const chip of line) {
            const color = colors.shades[chip.kind][0]
            out.elements.push({ t: 'rect', x: cx, y: cy + 3, w: 10, h: 10, rx: 2, fill: color })
            out.elements.push({ t: 'text', x: cx + 14, y: cy + 12, size: 11, fill: colors.muted, text: chip.text })
            cx += chip.w
          }
        })
        out.boxes.push({ role: 'legend', x, y, w: width, h: lines.length * 18 })
      }
    })
  }

  for (const note of notes) {
    const lines = wrapText(note, charsFor(width - 12, 12))
    blocks.push({
      type: 'note',
      h: lines.length * 17 + 12,
      draw(x, y, out) {
        out.elements.push({ t: 'rect', x, y, w: 3, h: lines.length * 17 - 2, fill: colors.accent3 })
        lines.forEach((line, i) => out.elements.push({ t: 'text', x: x + 12, y: y + 12 + i * 17, size: 12, fill: colors.muted, text: line }))
        out.boxes.push({ role: 'legend', x, y, w: width, h: lines.length * 17 })
      }
    })
  }

  let chainKey = ''
  for (const label of plan.labels) {
    const key = label.parents.join('/')
    if (key !== chainKey && label.parents.length) {
      const parent = plan.parents.find(p => p.id === label.parents[label.parents.length - 1])
      const name = chainName(plan, label.parents)
      const color = parent ? parentShade(parent) : colors.muted
      const range = parent ? `${hexOffset(parent.offset)} · ${formatSize(parent.length)}` : ''
      blocks.push({
        type: 'heading',
        h: 30,
        draw(x, y, out) {
          const rangeW = textWidth(range, 10.5)
          const text = truncate(name, charsFor(width - 14 - rangeW - 12, 12.5))
          out.elements.push({ t: 'rect', x, y: y + 8, w: 4, h: 16, rx: 1, fill: color })
          out.elements.push({ t: 'text', x: x + 12, y: y + 21, size: 12.5, weight: 700, fill: color, text })
          if (range) out.elements.push({ t: 'text', x: x + width, y: y + 21, size: 10.5, fill: colors.faint, anchor: 'end', text: range })
          out.elements.push({ t: 'line', x1: x + 12, y1: y + 27.5, x2: x + width, y2: y + 27.5, stroke: colors.rule, sw: 0.75 })
          out.boxes.push({ role: 'legend', x, y: y + 6, w: width, h: 24 })
        }
      })
    }
    chainKey = key
    const hasDescription = Boolean(label.description.trim())
    blocks.push({
      type: 'entry',
      h: 44,
      draw(x, y, out) {
        const color = shadeOf(label)
        const number = String(label.number)
        const tabW = Math.max(20, number.length * 10 * ADVANCE + 9)
        out.elements.push({ t: 'tab', x, y: y + 4, w: tabW, h: 15, fill: color, round: 'all' })
        out.elements.push({ t: 'text', x: x + tabW / 2, y: y + 15, size: 10, weight: 700, fill: colors.tabText, anchor: 'middle', text: number })

        const textX = x + 28
        const total = charsFor(x + width - textX, LF)
        const nameLen = textLength(label.name)
        const valueLen = textLength(label.value)
        let nameChars = nameLen
        if (label.value && nameLen + 2 + valueLen > total) nameChars = Math.min(nameLen, Math.max(12, total - 2 - Math.max(10, valueLen)))
        const name = truncate(label.name || '(unnamed)', Math.min(nameChars || total, total))
        const spans = [{ text: name, fill: colors.text, weight: 700 }]
        const left = total - textLength(name) - 2
        if (label.value && left >= 3) spans.push({ text: '  ' + truncate(label.value, left), fill: color })
        out.elements.push({ t: 'text', x: textX, y: y + 16, size: LF, fill: colors.text, spans, preserve: true })

        const where = `${hexOffset(label.offset)} · ${formatCount(label.length)} B`
        out.elements.push({ t: 'text', x: textX, y: y + 31, size: 10.5, fill: colors.faint, text: where })
        if (hasDescription) {
          const dx = textX + textWidth(where, 10.5) + 10
          out.elements.push({ t: 'text', x: dx, y: y + 31, size: 11, fill: colors.muted, text: truncate(label.description, charsFor(x + width - dx, 11)) })
        }
        out.boxes.push({ role: 'legend', x, y, w: width, h: 35, id: label.number })
      }
    })
  }
  return blocks
}

/** Splits blocks into at most `columns` columns no taller than needed; headings stay with their first entry. */
export function flowColumns(blocks, columns, minHeight = 0) {
  const total = blocks.reduce((s, b) => s + b.h, 0)
  const target = Math.max(minHeight, total / columns)
  const cols = [[]]
  let height = 0
  blocks.forEach((block, i) => {
    const next = blocks[i + 1]
    const need = block.type === 'heading' && next ? block.h + next.h : block.h
    if (height > 0 && height + need > target + 0.5 && cols.length < columns) {
      cols.push([])
      height = 0
    }
    cols[cols.length - 1].push(block)
    height += block.h
  })
  const heights = cols.map(col => col.reduce((s, b) => s + b.h, 0))
  return { cols, height: Math.max(0, ...heights) }
}

// --- Overview strip -------------------------------------------------------

function overviewStrip(plan, regions, colors, x, y, width, out) {
  const el = out.elements
  const size = plan.size
  el.push({ t: 'text', x, y: y + 12, size: 11, fill: colors.accent2, weight: 700, text: 'FILE MAP', ls: 1.5 })
  const regionNote = regions.length ? `${formatCount(regions.length)} region${regions.length === 1 ? '' : 's'}, to scale` : 'no region map for this format'
  el.push({ t: 'text', x: x + width, y: y + 12, size: 11, fill: colors.faint, anchor: 'end', text: regionNote })
  if (size === 0) {
    el.push({ t: 'rect', x, y: y + 44, w: width, h: 20, rx: 3, fill: colors.panel, stroke: colors.rule, sw: 1 })
    el.push({ t: 'text', x: x + width / 2, y: y + 58, size: 11, fill: colors.muted, anchor: 'middle', text: 'empty file' })
    return
  }
  const barY = y + 44
  const barH = 20
  const sx = n => x + (n / size) * width
  el.push({ t: 'rect', x, y: barY, w: width, h: barH, rx: 3, fill: colors.panel, stroke: colors.rule, sw: 1 })

  const shades = colors.shades
  let lastPixel = -1
  let drawn = 0
  regions.forEach((region, i) => {
    if (drawn > 800) return
    const rx = sx(region.offset)
    const rw = Math.max(1, sx(region.offset + region.length) - rx)
    if (rw < 1.5 && Math.floor(rx) === lastPixel) return
    lastPixel = Math.floor(rx)
    drawn++
    const color = shades[region.kind][i % 2]
    el.push({ t: 'rect', x: rx, y: barY + 1, w: Math.min(rw, x + width - rx), h: barH - 2, fill: color, fillOpacity: colors.style === 'print' ? 0.75 : 0.85 })
    const name = String(region.name ?? '')
    if (rw > 40) {
      const text = truncate(name, charsFor(rw - 10, 10))
      if (textLength(text) >= 3) el.push({ t: 'text', x: rx + 5, y: barY + 14, size: 10, fill: colors.tabText, weight: 700, text })
    }
  })

  // What this poster covers
  const shown = plan.shown || plan.window
  const c1 = sx(shown.start)
  const c2 = Math.max(c1 + 3, sx(shown.end))
  el.push({ t: 'rect', x: c1 - 1, y: barY - 3, w: Math.min(c2 - c1 + 2, x + width - c1 + 1), h: barH + 6, rx: 2, fill: 'none', stroke: colors.accent3, sw: 2 })
  el.push({ t: 'path', d: `M${fx(c1)} ${fx(barY - 6)}V${fx(barY - 11)}H${fx(c2)}V${fx(barY - 6)}`, stroke: colors.accent3, sw: 1.5, fill: 'none' })
  const coverage = `this poster: ${hexOffset(shown.start)}–${hexOffset(Math.max(shown.start, shown.end - 1))}`
  const tw = textWidth(coverage, 10.5)
  let tx = c1
  if (tx + tw > x + width) tx = Math.max(x, c2 - tw)
  el.push({ t: 'text', x: tx, y: barY - 15, size: 10.5, fill: colors.accent3, text: coverage })
  out.boxes.push({ role: 'strip', x: tx, y: barY - 25, w: tw, h: 12 })

  el.push({ t: 'text', x, y: barY + barH + 15, size: 10.5, fill: colors.faint, text: '0x0' })
  el.push({ t: 'text', x: x + width, y: barY + barH + 15, size: 10.5, fill: colors.faint, anchor: 'end', text: `${hexOffset(size)} · ${formatSize(size)}` })
}

// --- Page -----------------------------------------------------------------

function summaryFacts(analysis) {
  const skip = /^(file size|file type|size)$/i
  const facts = []
  for (const item of Array.isArray(analysis?.summary) ? analysis.summary : []) {
    if (!item || item.group || skip.test(String(item.label))) continue
    const value = String(item.value ?? '')
    if (!value || textLength(value) > 48) continue
    facts.push({ label: String(item.label ?? ''), value })
    if (facts.length >= 8) break
  }
  return facts
}

function notesFor(plan) {
  const notes = []
  if (plan.size === 0) notes.push('This file is empty, so there are no bytes to show.')
  else if (plan.source === 'none') notes.push('hex.dance has no field map for this format, so the bytes are coloured by class only (see the key below).')
  else if (plan.source === 'regions') notes.push('This format has no field map, so the boxes show the coarse regions of the file instead.')
  if (plan.size > 0 && plan.source !== 'none' && plan.labels.length === 0) notes.push('No fields fall inside the bytes shown here.')
  if (plan.omittedLabels > 0) {
    const where = plan.mode === 'auto' ? 'further into the file' : 'in this range'
    notes.push(`${formatCount(plan.omittedLabels)} more field${plan.omittedLabels === 1 ? '' : 's'} ${where} ${plan.omittedLabels === 1 ? 'is' : 'are'} not labelled.`)
  }
  return notes
}

/**
 * @param {Object} input
 * @param {ReturnType<import('./plan.js').planPoster>} input.plan
 * @param {Uint8Array} input.bytes
 * @param {import('../../analysis/types.js').Analysis|null} input.analysis
 * @param {string} input.fileName
 * @param {import('./palette.js').PosterColors} input.colors
 * @param {'landscape'|'portrait'|'square'} [input.proportion]
 * @param {string} [input.date]
 */
export function layoutPoster({ plan, bytes, analysis, fileName, colors, proportion = 'landscape', date = '' }) {
  const ratio = PROPORTIONS[proportion] || PROPORTIONS.landscape
  const shades = assignShades(plan.labels)
  const shadeOf = label => colors.shades[label.kind][shades[label.number - 1] ?? 0]
  const parentShadeIdx = assignShades(plan.parents)
  const parentShade = parent => colors.shades[parent.kind][(parentShadeIdx[plan.parents.indexOf(parent)] ?? 0)]

  const geometry = hexGeometry(plan)
  const blocks = legendBlocks(plan, colors, shadeOf, parentShade, notesFor(plan))

  // Pick the arrangement that wastes the least page for this proportion
  let best = null
  for (const stacked of [false, true]) {
    for (let k = 1; k <= 4; k++) {
      const flow = flowColumns(blocks, k, stacked ? 0 : geometry.height)
      const legendW = flow.cols.length * LEGEND_W + (flow.cols.length - 1) * COL_GAP
      const bodyW = stacked ? Math.max(geometry.width, legendW) : geometry.width + BODY_GAP + legendW
      const bodyH = stacked ? geometry.height + 36 + flow.height : Math.max(geometry.height, flow.height)
      const innerW = Math.max(MIN_INNER_W, bodyW)
      let w = innerW + 2 * MARGIN
      let h = HEAD_H + bodyH + FOOT_H + 2 * MARGIN + 40
      if (w / h < ratio) w = h * ratio
      else h = w / ratio
      const area = w * h
      if (!best || area < best.area * 0.97) best = { stacked, flow, legendW, bodyW, bodyH, w, h, area }
      if (flow.cols.length < k) break
    }
  }

  const width = Math.ceil(best.w)
  const height = Math.ceil(best.h)
  const out = { elements: [], boxes: [] }
  const innerX = MARGIN
  const innerW = width - 2 * MARGIN
  out.elements.push({ t: 'rect', x: 0, y: 0, w: width, h: height, fill: colors.background })

  // Title block
  const title = truncate(fileName || 'untitled', charsFor(innerW, 30))
  out.elements.push({ t: 'text', x: innerX, y: MARGIN + 26, size: 30, weight: 700, fill: colors.accent, text: title, cls: 'title' })
  out.boxes.push({ role: 'head', x: innerX, y: MARGIN, w: textWidth(title, 30), h: 34 })
  const formatName = analysis?.formatName || 'Unknown format'
  const sizeText = plan.size < 1024 ? formatSize(plan.size) : `${formatSize(plan.size)} (${formatCount(plan.size)} bytes)`
  const subtitle = truncate(`${formatName} · ${sizeText}`, charsFor(innerW, 15))
  out.elements.push({ t: 'text', x: innerX, y: MARGIN + 54, size: 15, fill: colors.text, text: subtitle })
  out.boxes.push({ role: 'head', x: innerX, y: MARGIN + 41, w: textWidth(subtitle, 15), h: 17 })

  const facts = summaryFacts(analysis)
  if (facts.length) {
    const budget = charsFor(innerW, 12.5)
    const spans = []
    let used = 0
    for (const fact of facts) {
      const sep = spans.length ? '   ' : ''
      const piece = textLength(sep + fact.label + ' ' + fact.value)
      if (used + piece > budget) {
        const room = budget - used - textLength(sep + fact.label + ' ')
        if (room >= 6) {
          spans.push({ text: sep + fact.label + ' ', fill: colors.faint })
          spans.push({ text: truncate(fact.value, room), fill: colors.text })
        }
        break
      }
      spans.push({ text: sep + fact.label + ' ', fill: colors.faint })
      spans.push({ text: fact.value, fill: colors.text })
      used += piece
    }
    if (spans.length) out.elements.push({ t: 'text', x: innerX, y: MARGIN + 78, size: 12.5, fill: colors.text, spans, preserve: true })
  }

  const regions = (Array.isArray(analysis?.regions) ? analysis.regions : [])
    .filter(r => r && Number.isSafeInteger(r.offset) && r.offset >= 0 && r.offset < plan.size && r.length > 0)
    .map(r => ({ name: r.name, offset: r.offset, length: Math.min(r.length, plan.size - r.offset), kind: regionKindOf(r.kind) }))
  overviewStrip(plan, regions, colors, innerX, MARGIN + 100, innerW, out)

  // Body, centred in the space between the header and the footer
  const bodyTop = MARGIN + HEAD_H
  const bodyArea = height - MARGIN - FOOT_H - 20 - bodyTop
  const by = bodyTop + Math.max(0, (bodyArea - best.bodyH) / 2)
  const bx = innerX + Math.max(0, (innerW - best.bodyW) / 2)
  let hexX = bx
  let legendX
  let legendY
  if (best.stacked) {
    hexX = bx + (best.bodyW - geometry.width) / 2
    legendX = bx + (best.bodyW - best.legendW) / 2
    legendY = by + geometry.height + 36
  } else {
    legendX = bx + geometry.width + BODY_GAP
    legendY = by
  }
  if (plan.items.length) hexDump(plan, bytes, colors, shadeOf, parentShade, hexX, by, out)
  best.flow.cols.forEach((col, i) => {
    let y = legendY
    const x = legendX + i * (LEGEND_W + COL_GAP)
    for (const block of col) {
      const first = out.elements.length
      block.draw(x, y, out)
      const g = `legend:${blocks.indexOf(block)}`
      for (let e = first; e < out.elements.length; e++) out.elements[e].g = g
      y += block.h
    }
  })
  if (!best.stacked && best.flow.cols.length && blocks.length) {
    out.elements.push({ t: 'line', x1: legendX - BODY_GAP / 2, y1: by + 4, x2: legendX - BODY_GAP / 2, y2: by + best.bodyH - 4, stroke: colors.rule, sw: 0.75 })
  }

  // Footer
  const fy = height - MARGIN - 18
  out.elements.push({ t: 'line', x1: innerX, y1: fy - 18, x2: innerX + innerW, y2: fy - 18, stroke: colors.rule, sw: 0.75 })
  const credit = [{ text: 'made with ', fill: colors.muted }, { text: 'hex.dance', fill: colors.accent, weight: 700 }]
  if (date) credit.push({ text: ` · ${date}`, fill: colors.muted })
  out.elements.push({ t: 'text', x: innerX, y: fy, size: 12, fill: colors.muted, spans: credit })
  const shown = plan.shown
  const coverage = shown
    ? `showing ${hexOffset(shown.start)}–${hexOffset(shown.end - 1)} · ${plan.bytesPerRow} bytes per row · ${plan.labels.length} label${plan.labels.length === 1 ? '' : 's'}`
    : 'nothing to show'
  out.elements.push({ t: 'text', x: innerX, y: fy + 17, size: 10.5, fill: colors.faint, text: truncate(coverage, charsFor(innerW / 2, 10.5)) })

  let kx = innerX + innerW
  for (const cls of [...BYTE_CLASSES].reverse()) {
    const label = BYTE_CLASS_LABELS[cls]
    const w = textWidth(label, 11)
    kx -= w
    out.elements.push({ t: 'text', x: kx, y: fy, size: 11, fill: colors.bytes[cls], text: label })
    kx -= 16
    out.elements.push({ t: 'rect', x: kx, y: fy - 9, w: 10, h: 10, rx: 2, fill: colors.bytes[cls] })
    kx -= 14
  }
  out.elements.push({ t: 'text', x: kx, y: fy, size: 11, fill: colors.faint, anchor: 'end', text: 'bytes outside fields' })

  return { width, height, elements: out.elements, boxes: out.boxes, arrangement: { stacked: best.stacked, columns: best.flow.cols.length } }
}
