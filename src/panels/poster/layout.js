// Poster geometry. Everything is laid out in SVG user units with a monospace
// face whose advance is assumed to be 0.6em; hex and text columns position
// every character explicitly, so the dump lines up whatever font the viewer
// has. The result is a flat scene (shapes and text with absolute
// coordinates) plus the boxes of every label, which tests check for overlaps.

import { truncate, textLength, cleanText } from './escape.js'
import { KIND_LABELS, BYTE_CLASSES, BYTE_CLASS_LABELS, byteClass, assignShades, kindOf, regionKindOf } from './palette.js'
import { placeOnRows } from './measure.js'
import { drawDumpPointers, drawMapArcs, mapLinks, railWidth, storyConnectors, ARC_ZONE } from './pointers.js'
import { unusualBand } from './unusual.js'
import { tilesBand } from './tiles.js'
import { memoryBand } from './memory.js'
import { textBand } from './readable.js'

export const ADVANCE = 0.6
export const PROPORTIONS = { landscape: Math.SQRT2, portrait: 1 / Math.SQRT2, square: 1, tall: 0.5 }

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
const FOOT_H = 44
const BAND_GAP = 24
const DUMP_GAP = 40
const SIDE_MIN = 720
const PAIR_GAP = 28
const PAIR_MIN = 1000

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
  if (item.repeat) {
    const { count, start, end } = item.repeat
    const unit = item.repeat.unit === 'regions' ? (count === 1 ? 'region' : 'regions') : count === 1 ? 'entry' : 'entries'
    const what = `${formatCount(count)} more ${unit}`
    const range = end > start ? ` (${hexOffset(start)}–${hexOffset(end - 1)})` : ''
    return [`… ${what}, same layout${range} …`, `… ${what}, same layout …`, `… ${what} …`, `… ${formatCount(count)} more …`]
  }
  const n = item.end - item.start
  const count = n === 1 ? '1 byte' : `${formatCount(n)} bytes`
  const range = `${hexOffset(item.start)}–${hexOffset(item.end - 1)}`
  if (Number.isInteger(item.fill) && n > 1) {
    // The plan checked every byte: say what they all are
    const all = item.fill === 0 ? 'all zero' : `all ${HEX[item.fill & 0xff]}`
    if (item.where === 'after') return [`… ${count} more to the end of the file, ${all} (${range}) …`, `… ${count} more, ${all} …`, `… ${count} more …`]
    if (item.where === 'before') return [`… first ${count}, ${all} (${range}) …`, `… ${count} before, ${all} …`, `… ${count} before …`]
    return [`… ${count}, ${all} (${range}) …`, `… ${count}, ${all} …`, `… ${formatSize(n)}, ${all} …`, `… ${all} …`]
  }
  if (item.text) return [`… ${count} more of the text (${range}) …`, `… ${count} more of the text …`, `… ${formatSize(n)} more of the text …`, `… ${formatSize(n)} of text …`]
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
      // Regions of the file map (not fields) get a dashed outline and a lighter fill
      const dash = label.region ? '5 3' : undefined
      const fillOpacity = label.region ? colors.fillOpacity * 0.6 : colors.fillOpacity
      for (const shape of runShapes(run, g)) {
        if (shape.type === 'rect') {
          el.push({ t: 'rect', x: ox + shape.x, y: oy + shape.y, w: shape.w, h: shape.h, rx: 3, fill: color, fillOpacity, stroke: color, sw: 1.3, dash })
        } else {
          el.push({ t: 'poly', points: shape.points.map(([x, y]) => [ox + x, oy + y]), fill: color, fillOpacity, stroke: color, sw: 1.3, dash })
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

// Lines a legend text may take before it is cut: text the poster or a parser
// wrote is never that long; text from the file (names, strings) may be
const NAME_LINES = 3
const VALUE_LINES = 4
const FILE_VALUE_LINES = 3
const DESCRIPTION_LINES = 4
const HEADING_LINES = 3
const REPEAT_TITLE_LINES = 2
const REPEAT_LINES = 12

/** Splits one word into a piece of at most `max` characters and the rest, never inside a marker such as ⟨U+202E⟩. */
function splitWord(word, max) {
  const chars = Array.from(word)
  let head = chars.slice(0, Math.max(1, max)).join('')
  const open = head.lastIndexOf('⟨')
  if (open > 0 && open > head.lastIndexOf('⟩')) head = head.slice(0, open)
  return [head, chars.slice(Array.from(head).length).join('')]
}

/**
 * Wraps text into lines of at most `maxChars` characters (the first line
 * `firstChars`), at spaces; a word longer than a line is split. A ' › '
 * stays with the name after it. Past `maxLines` the last line ends in '…'.
 * The first line is empty when the first word only fits on a full line.
 */
function wrapText(text, maxChars, maxLines = Infinity, firstChars = maxChars) {
  const words = []
  for (const word of cleanText(text).split(' ')) {
    if (!word) continue
    if (words.length && words[words.length - 1] === '›') words[words.length - 1] += ' ' + word
    else words.push(word)
  }
  const lines = []
  let line = ''
  const room = () => Math.max(1, lines.length === 0 ? firstChars : maxChars)
  for (let word of words) {
    while (word) {
      const candidate = line ? `${line} ${word}` : word
      if (textLength(candidate) <= room()) {
        line = candidate
        break
      }
      if (line) {
        lines.push(line)
        line = ''
      } else if (lines.length === 0 && firstChars < maxChars && textLength(word) <= maxChars) {
        lines.push('')
      } else {
        const [head, rest] = splitWord(word, room())
        lines.push(head)
        word = rest
      }
      if (lines.length > maxLines) break
    }
    if (lines.length > maxLines) break
  }
  if (line && lines.length <= maxLines) lines.push(line)
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    const width = maxLines === 1 ? Math.max(1, firstChars) : maxChars
    kept[maxLines - 1] = truncate(kept[maxLines - 1], Math.max(1, width - 1)).replace(/…$/, '') + '…'
    return kept
  }
  return lines
}

/**
 * Wraps a chain of names ("Optional header › Windows-specific fields")
 * between its names where it can, and like wrapText where it cannot.
 */
function wrapChain(name, maxChars, maxLines, firstChars = maxChars) {
  const parts = cleanText(name).split(' › ')
  const plain = () => wrapText(name, maxChars, maxLines, firstChars)
  if (parts.length < 2) return plain()
  const lines = []
  let line = ''
  for (const [i, part] of parts.entries()) {
    const unit = i ? `› ${part}` : part
    const candidate = line ? `${line} ${unit}` : unit
    if (textLength(candidate) <= (lines.length ? maxChars : firstChars)) {
      line = candidate
      continue
    }
    if (!line || textLength(unit) > maxChars) return plain()
    lines.push(line)
    line = unit
  }
  lines.push(line)
  return lines.length > maxLines ? plain() : lines
}

/** The value an entry shows: for a box of text, how much text it is. */
function entryValue(label, lineChars) {
  const value = cleanText(label.value).trim()
  if (!label.text) return value
  const fits = value && textLength(value) <= lineChars
  if (fits && label.length < 64) return value
  // The parser already said how much text there is
  if (fits && /\bof (readable )?text$/i.test(value)) return value
  const amount = `${formatSize(label.length)} of text`
  // A short value stays, with how much text the box holds; a long one (a
  // sentence from the file) gives way to that
  if (/^[\d,.]+ ?(bytes?|KB|MB|GB)$/i.test(value)) return amount
  if (fits && textLength(`${value} · ${amount}`) <= lineChars) return `${value} · ${amount}`
  return `${formatCount(label.length)} bytes of readable text`
}

/**
 * Lines of a legend entry: the name (bold) with the value on its last line
 * when it fits, or on lines of its own below; then the position, with the
 * description after it wrapping onto further lines.
 */
function entryLines(label) {
  const lineChars = charsFor(LEGEND_W - 28, LF)
  const nameLines = wrapText(label.name || '(unnamed)', lineChars, NAME_LINES)
  const value = entryValue(label, lineChars)
  let inline = ''
  let valueLines = []
  if (value) {
    const last = nameLines[nameLines.length - 1]
    if (textLength(last) + 2 + textLength(value) <= lineChars) inline = value
    else valueLines = wrapText(value, lineChars, label.kind === 'string' ? FILE_VALUE_LINES : VALUE_LINES)
  }
  const where = `${hexOffset(label.offset)} · ${formatCount(label.length)} B`
  const description = cleanText(label.description).trim()
  const descriptionLines = description
    ? wrapText(description, charsFor(LEGEND_W - 28, 11), DESCRIPTION_LINES, charsFor(LEGEND_W - 28 - textWidth(where, 10.5) - 10, 11))
    : []
  const top = nameLines.length + valueLines.length
  const whereY = 16 + (top - 1) * 16 + 15
  const boxH = whereY + Math.max(0, descriptionLines.length - 1) * 14 + 4
  return { nameLines, inline, valueLines, where, descriptionLines, whereY, boxH }
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

  // What the entries of each repeat share, just before the labels of its first entry
  const repeatsAt = new Map()
  for (const rep of plan.repeats || []) {
    if (!repeatsAt.has(rep.firstLabel)) repeatsAt.set(rep.firstLabel, [])
    repeatsAt.get(rep.firstLabel).push(rep)
  }
  const byId = new Map(plan.parents.map(p => [p.id, p]))
  const isPrefix = (a, b) => a.length <= b.length && a.every((id, i) => id === b[i])
  // The chain of the last heading, and the chains headed since the last
  // heading at the top of a chain (so a return to one reads "continued")
  let chain = null
  let headed = []
  for (const label of plan.labels) {
    for (const rep of repeatsAt.get(label.number) || []) {
      const titleLines = wrapText(`Repeated: ${rep.first} to ${rep.last}`, charsFor(width - 12, 12), REPEAT_TITLE_LINES)
      const lines = wrapText(rep.text, charsFor(width - 12, 11.5), REPEAT_LINES)
      const h = 4 + titleLines.length * 16 + lines.length * 16
      blocks.push({
        type: 'repeat',
        h: h + 12,
        draw(x, y, out) {
          out.elements.push({ t: 'rect', x, y: y + 4, w: 3, h: h - 4, fill: colors.accent2 })
          titleLines.forEach((line, i) => out.elements.push({ t: 'text', x: x + 12, y: y + 16 + i * 16, size: 12, weight: 700, fill: colors.accent2, text: line }))
          const top = y + 17 + titleLines.length * 16
          lines.forEach((line, i) => out.elements.push({ t: 'text', x: x + 12, y: top + i * 16, size: 11.5, fill: colors.muted, text: line }))
          out.boxes.push({ role: 'legend', x, y: y + 4, w: width, h: h - 2 })
        }
      })
      chain = null
      headed = []
    }
    const ids = label.parents
    const key = ids.join('/')
    if (ids.length && (chain === null || key !== chain.join('/'))) {
      const parent = byId.get(ids[ids.length - 1])
      const color = parent ? parentShade(parent) : colors.muted
      const range = parent ? `${hexOffset(parent.offset)} · ${formatSize(parent.length)}` : ''
      // Inside the chain headed just before: name only what is added.
      // Back to a chain already headed: say it continues
      let name
      let indent = 0
      let continued = false
      if (chain && chain.length && ids.length > chain.length && isPrefix(chain, ids)) {
        name = `› ${chainName(plan, ids.slice(chain.length))}`
        indent = 12
      } else if (headed.includes(key)) {
        name = chainName(plan, ids)
        continued = true
      } else {
        name = chainName(plan, ids)
        if (!chain || !isPrefix(chain, ids)) headed = []
      }
      headed.push(key)
      const rangeW = range ? textWidth(range, 10.5) + 12 : 0
      const lineChars = charsFor(width - 12 - indent, 12.5)
      const tail = continued ? 11 : 0
      const lines = wrapChain(name, lineChars - tail, HEADING_LINES, charsFor(width - 12 - indent - rangeW, 12.5) - tail)
      const extra = (lines.length - 1) * 16
      blocks.push({
        type: 'heading',
        h: 30 + extra,
        draw(x, y, out) {
          out.elements.push({ t: 'rect', x: x + indent, y: y + 8, w: 4, h: 16 + extra, rx: 1, fill: color })
          lines.forEach((line, i) => {
            const spans = [{ text: line, fill: color, weight: 700 }]
            if (continued && i === lines.length - 1) spans.push({ text: ', continued', fill: colors.faint })
            out.elements.push({ t: 'text', x: x + indent + 12, y: y + 21 + i * 16, size: 12.5, fill: color, spans })
          })
          if (range) out.elements.push({ t: 'text', x: x + width, y: y + 21, size: 10.5, fill: colors.faint, anchor: 'end', text: range })
          out.elements.push({ t: 'line', x1: x + indent + 12, y1: y + 27.5 + extra, x2: x + width, y2: y + 27.5 + extra, stroke: colors.rule, sw: 0.75 })
          out.boxes.push({ role: 'legend', x, y: y + 6, w: width, h: 24 + extra })
        }
      })
    }
    chain = ids
    const lines = entryLines(label)
    blocks.push({
      type: 'entry',
      h: lines.boxH + 9,
      draw(x, y, out) {
        const color = shadeOf(label)
        const number = String(label.number)
        const tabW = Math.max(20, number.length * 10 * ADVANCE + 9)
        out.elements.push({ t: 'tab', x, y: y + 4, w: tabW, h: 15, fill: color, round: 'all' })
        out.elements.push({ t: 'text', x: x + tabW / 2, y: y + 15, size: 10, weight: 700, fill: colors.tabText, anchor: 'middle', text: number })

        const textX = x + 28
        let ly = y + 16
        lines.nameLines.forEach((line, i) => {
          const spans = [{ text: line, fill: colors.text, weight: 700 }]
          if (i === lines.nameLines.length - 1 && lines.inline) spans.push({ text: '  ' + lines.inline, fill: color })
          out.elements.push({ t: 'text', x: textX, y: ly, size: LF, fill: colors.text, spans, preserve: true })
          ly += 16
        })
        for (const line of lines.valueLines) {
          out.elements.push({ t: 'text', x: textX, y: ly, size: LF, fill: color, text: line })
          ly += 16
        }
        const wy = y + lines.whereY
        out.elements.push({ t: 'text', x: textX, y: wy, size: 10.5, fill: colors.faint, text: lines.where })
        lines.descriptionLines.forEach((line, i) => {
          if (!line) return
          const dx = i === 0 ? textX + textWidth(lines.where, 10.5) + 10 : textX
          out.elements.push({ t: 'text', x: dx, y: wy + i * 14, size: 11, fill: colors.muted, text: line })
        })
        out.boxes.push({ role: 'legend', x, y, w: width, h: lines.boxH, id: label.number })
      }
    })
  }

  // The notes on what the poster leaves out, and how to read it, come last
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
  return blocks
}

/** Greedy fill: a new column whenever the next block (a heading with its first entry) would pass `target`. */
function fillColumns(blocks, target, columns) {
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
  return cols
}

const columnHeight = col => col.reduce((s, b) => s + b.h, 0)

/**
 * Splits blocks into at most `columns` columns no taller than needed;
 * headings stay with their first entry. Columns may be as tall as
 * `minHeight`; beyond that, the shortest height at which the blocks fit
 * the columns is found by bisection, so blocks of very different heights
 * do not pile up in the last column.
 */
export function flowColumns(blocks, columns, minHeight = 0) {
  const total = blocks.reduce((s, b) => s + b.h, 0)
  let low = Math.max(minHeight, total / columns)
  let cols = fillColumns(blocks, low, columns)
  let height = Math.max(0, ...cols.map(columnHeight))
  if (columns > 1 && height > low + 0.5) {
    // The greedy fill overflowed into the last column: look for the lowest
    // target whose tallest column is lowest
    let high = height
    for (let step = 0; step < 24 && high - low > 1; step++) {
      const mid = (low + high) / 2
      const trial = fillColumns(blocks, mid, columns)
      const h = Math.max(0, ...trial.map(columnHeight))
      if (h <= mid + 0.5 || h < height) {
        if (h < height) {
          cols = trial
          height = h
        }
        high = Math.min(mid, h)
      } else low = mid
    }
  }
  return { cols, height: Math.max(0, ...cols.map(columnHeight)) }
}

// --- Overview strip -------------------------------------------------------

const STRIP_TITLE_H = 20
const STRIP_BAR_H = 20
const STRIP_BELOW = 46

/** Height of the file map: taller when it carries pointer arcs. */
function stripHeight(links) {
  return STRIP_TITLE_H + (links.length ? ARC_ZONE : 8) + STRIP_BAR_H + STRIP_BELOW
}

/** Runs of consecutive drawn rows, as [start, end) byte ranges. */
function shownParts(items) {
  const parts = []
  for (const item of items) {
    if (item.type !== 'row') continue
    const last = parts[parts.length - 1]
    if (last && last[1] === item.start) last[1] = item.end
    else parts.push([item.start, item.end])
  }
  return parts
}

function overviewStrip(plan, regions, colors, x, y, width, out, extras = {}) {
  const links = extras.links || []
  const entryOffset = extras.entryOffset ?? null
  const el = out.elements
  const size = plan.size
  el.push({ t: 'text', x, y: y + 12, size: 11, fill: colors.accent2, weight: 700, text: 'FILE MAP', ls: 1.5 })
  const notes = [regions.length ? `${formatCount(regions.length)} region${regions.length === 1 ? '' : 's'}, to scale` : 'no region map for this format']
  if (links.length) notes.push(`${formatCount(links.length)} pointer${links.length === 1 ? '' : 's'} drawn as arcs`)
  const regionNote = truncate(notes.join(' · '), charsFor(width - 110, 11))
  el.push({ t: 'text', x: x + width, y: y + 12, size: 11, fill: colors.faint, anchor: 'end', text: regionNote })
  out.boxes.push({ role: 'strip', x: x + width - textWidth(regionNote, 11), y, w: textWidth(regionNote, 11), h: 14 })
  const barY = y + STRIP_TITLE_H + (links.length ? ARC_ZONE : 8)
  const barH = STRIP_BAR_H
  if (size === 0) {
    el.push({ t: 'rect', x, y: barY, w: width, h: barH, rx: 3, fill: colors.panel, stroke: colors.rule, sw: 1 })
    el.push({ t: 'text', x: x + width / 2, y: barY + 14, size: 11, fill: colors.muted, anchor: 'middle', text: 'empty file' })
    return
  }
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
      // The whole name or none: a name cut to a few letters says less than the legend does
      const text = truncate(name, charsFor(rw - 10, 10))
      if (text && !text.endsWith('…')) el.push({ t: 'text', x: rx + 5, y: barY + 14, size: 10, fill: colors.tabText, weight: 700, text })
    }
  })

  drawMapArcs({ links, x, width, barY, size, colors, out })

  // Below the bar: what this poster covers, the scale and the entry point
  const below = barY + barH
  const rows = [[], []]
  const baseline = r => below + 22 + r * 14
  const place = (ax, text, fill, anchor) => {
    const tw = textWidth(text, 10.5)
    let left = anchor === 'end' ? ax - tw : anchor === 'middle' ? ax - tw / 2 : ax
    left = Math.max(x, Math.min(x + width - tw, left))
    const r = placeOnRows(rows, left, tw)
    if (r < 0) return false
    el.push({ t: 'text', x: left, y: baseline(r), size: 10.5, fill, text })
    out.boxes.push({ role: 'strip', x: left, y: baseline(r) - 10, w: tw, h: 12 })
    return true
  }
  place(x, '0x0', colors.faint)
  place(x + width, `${hexOffset(size)} · ${formatSize(size)}`, colors.faint, 'end')

  if (entryOffset !== null && entryOffset < size) {
    const ex = sx(entryOffset)
    el.push({ t: 'line', x1: ex, y1: barY - 2, x2: ex, y2: below + 9, stroke: colors.accent3, sw: 1.5 })
    el.push({ t: 'poly', points: [[ex, below + 5], [ex - 4, below + 11], [ex + 4, below + 11]], fill: colors.accent3 })
    if (!place(ex, `entry point ${hexOffset(entryOffset)}`, colors.accent3, 'middle')) place(ex, 'entry', colors.accent3, 'middle')
  }

  if (plan.mode === 'tour') {
    // Where the rows on this poster come from
    const parts = shownParts(plan.items)
    let last = -Infinity
    for (const [s, e] of parts.slice(0, 400)) {
      const a = sx(s)
      const b = Math.max(a + 2, sx(e))
      if (b <= last + 0.5) continue
      el.push({ t: 'rect', x: Math.max(x, Math.max(a, last + 0.5)), y: below + 2, w: Math.max(1, Math.min(b, x + width) - Math.max(a, last + 0.5)), h: 4, fill: colors.text, fillOpacity: 0.8 })
      last = b
    }
    if (parts.length) {
      const text = `rows from ${formatCount(parts.length)} place${parts.length === 1 ? '' : 's'} in the file (marked under the bar)`
      place(x + width / 2, text, colors.muted, 'middle') || place(x + width / 2, `rows from ${formatCount(parts.length)} places`, colors.muted, 'middle')
    }
  } else {
    const shown = plan.shown || plan.window
    const c1 = sx(shown.start)
    const c2 = Math.max(c1 + 3, sx(shown.end))
    el.push({ t: 'rect', x: c1 - 1, y: barY - 3, w: Math.min(c2 - c1 + 2, x + width - c1 + 1), h: barH + 6, rx: 2, fill: 'none', stroke: colors.accent3, sw: 2 })
    el.push({ t: 'path', d: `M${fx(c1)} ${fx(below + 6)}V${fx(below + 10)}H${fx(c2)}V${fx(below + 6)}`, stroke: colors.accent3, sw: 1.5, fill: 'none' })
    const coverage = `this poster: ${hexOffset(shown.start)}–${hexOffset(Math.max(shown.start, shown.end - 1))}`
    place(c1, coverage, colors.accent3) || place((c1 + c2) / 2, coverage, colors.accent3, 'middle')
  }
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

const fieldsWord = n => `${formatCount(n)} field${n === 1 ? '' : 's'}`

/** Plain-words notes on what the poster leaves out, and why. */
function notesFor(plan) {
  const notes = []
  const labels = plan.labels
  if (plan.size === 0) notes.push('This file is empty, so there are no bytes to show.')
  else if (plan.source === 'none') notes.push('hex.dance has no field map for this format, so the bytes are coloured by class only (see the key below).')
  else if (plan.source === 'regions') notes.push('This format has no field map, so the boxes show the coarse regions of the file instead.')
  if (plan.size > 0 && plan.source !== 'none' && labels.length === 0) notes.push('No fields fall inside the bytes shown here.')
  const pins = plan.pins || { asked: 0, labelled: 0, ignored: 0 }
  if (pins.ignored > 0) notes.push(`${formatCount(pins.ignored)} pinned range${pins.ignored === 1 ? ' does' : 's do'} not match a field, so ${pins.ignored === 1 ? 'it is' : 'they are'} left out.`)
  const unplaced = pins.asked - pins.ignored - pins.labelled
  if (plan.mode === 'tour' && unplaced > 0) notes.push(`${formatCount(unplaced)} pinned field${unplaced === 1 ? '' : 's'} did not fit on the poster.`)
  if ((plan.repeats || []).length) notes.push('Runs of entries with the same layout show only their first and last entry; the note before each run says what they share.')
  if (labels.some(l => l.merged)) notes.push('Neighbouring fields that hold nothing, or one repeated byte, share one box.')
  if (labels.some(l => l.region)) notes.push('Dashed boxes are parts of the file described only as a whole, such as a section\'s contents.')
  if (plan.rootsLeft > 0) notes.push(`${formatCount(plan.rootsLeft)} top-level part${plan.rootsLeft === 1 ? '' : 's'} of the file did not fit and ${plan.rootsLeft === 1 ? 'has' : 'have'} no box.`)
  if (plan.omittedLabels > 0) {
    const n = plan.omittedLabels
    const are = n === 1 ? 'is' : 'are'
    if (plan.mode === 'tour') {
      const limit = plan.limitedBy === 'rows' ? `, to fit in ${formatCount(plan.maxRows)} rows` : plan.limitedBy === 'labels' ? `, to keep to ${formatCount(plan.maxLabels ?? labels.length)} labels` : ''
      notes.push(`${fieldsWord(n)} ${are} not labelled${limit}; the dullest went first.`)
    } else {
      const where = plan.mode === 'auto' ? 'further into the file' : 'in this range'
      notes.push(`${formatCount(n)} more field${n === 1 ? '' : 's'} ${where} ${are} not labelled.`)
    }
  }
  if (plan.mode === 'tour' && plan.size > 0 && plan.items.length < plan.maxRows - 4 && plan.items.some(i => i.fill !== undefined)) {
    notes.push('Some rows are left unused: stretches that hold only one repeated byte are shown as a single gap.')
  }
  if (plan.partialTree) notes.push('The field map is very large, so only part of it was read for this poster.')
  return notes
}

/**
 * @param {Object} input
 * @param {ReturnType<import('./plan.js').planPoster>} input.plan
 * @param {Uint8Array} input.bytes
 * @param {import('../../analysis/types.js').Analysis|null} input.analysis
 * @param {string} input.fileName
 * @param {import('./palette.js').PosterColors} input.colors
 * @param {'landscape'|'portrait'|'square'|'tall'} [input.proportion]
 * @param {{ pointers?: boolean, unusual?: boolean, tiles?: boolean, memory?: boolean, text?: boolean }} [input.show]
 *        which of the extra drawings to include (each only when there is data for it); all on by default
 * @param {string} [input.date]
 * @param {Array<{ type: string, h: number, draw: Function }>} [input.legend]  for tests: legend blocks to lay out instead of the plan's
 */
export function layoutPoster({ plan, bytes, analysis, fileName, colors, proportion = 'landscape', date = '', show, legend }) {
  const ratio = PROPORTIONS[proportion] || PROPORTIONS.landscape
  const flags = { pointers: true, unusual: true, tiles: true, memory: true, text: true }
  if (show && typeof show === 'object') for (const key of Object.keys(flags)) if (show[key] === false) flags[key] = false
  const shades = assignShades(plan.labels)
  const shadeOf = label => colors.shades[label.kind][shades[label.number - 1] ?? 0]
  const parentShadeIdx = assignShades(plan.parents)
  const parentShade = parent => colors.shades[parent.kind][(parentShadeIdx[plan.parents.indexOf(parent)] ?? 0)]

  const geometry = hexGeometry(plan)
  const blocks = Array.isArray(legend) ? legend : legendBlocks(plan, colors, shadeOf, parentShade, notesFor(plan))

  // The extra drawings, each only with its flag on and data to show
  const image = analysis?.image && typeof analysis.image === 'object' ? analysis.image : null
  const entryAt = Number.isSafeInteger(image?.entry?.offset) && image.entry.offset >= 0 && image.entry.offset < plan.size ? image.entry.offset : null
  // Each is worked out once, whatever the flags, so `available` can say which
  // switches would draw something
  const allLinks = mapLinks(plan)
  const allRail = plan.items.length ? railWidth(plan, entryAt) : 0
  // The numbered box on the poster for a label number, and the smallest drawn box that holds an offset
  const labelByNumber = new Map(plan.labels.map(l => [l.number, l]))
  const drawn = new Set(plan.labels.filter(l => fieldRuns(plan.items, plan.bytesPerRow, l.start, l.end).length).map(l => l.number))
  const tabFor = number => {
    const label = labelByNumber.get(number)
    return label && drawn.has(number) ? { number, color: shadeOf(label) } : null
  }
  const boxAt = offset => {
    let found = null
    for (const l of plan.labels) {
      if (offset >= l.start && offset < l.end && drawn.has(l.number) && (!found || l.end - l.start < found.end - found.start)) found = l
    }
    return found ? tabFor(found.number) : null
  }
  const tilesAll = tilesBand({ analysis, bytes, colors })
  const unusualAll = unusualBand({ analysis, colors, facts: tilesAll?.fact ? [tilesAll.fact] : [], boxAt })
  const memoryAll = memoryBand({ analysis, colors, fileSize: plan.size })
  const textAll = textBand({ plan, bytes, colors, tabFor })
  const available = { pointers: allLinks.length > 0 || allRail > 0, unusual: Boolean(unusualAll), tiles: Boolean(tilesAll), memory: Boolean(memoryAll), text: Boolean(textAll) }
  const links = flags.pointers ? allLinks : []
  const rail = flags.pointers ? allRail : 0
  const tiles = flags.tiles ? tilesAll : null
  // The tiles' caption already says how many sections are identical; the
  // unusual box repeats it only when the tiles are not drawn
  const unusual = flags.unusual ? (tiles && tilesAll?.fact ? unusualBand({ analysis, colors, boxAt }) || unusualAll : unusualAll) : null
  const memory = flags.memory ? memoryAll : null
  const text = flags.text ? textAll : null

  const facts = summaryFacts(analysis)
  const regions = (Array.isArray(analysis?.regions) ? analysis.regions : [])
    .filter(r => r && Number.isSafeInteger(r.offset) && r.offset >= 0 && r.offset < plan.size && r.length > 0)
    .map(r => ({ name: r.name, offset: r.offset, length: Math.min(r.length, plan.size - r.offset), kind: regionKindOf(r.kind) }))
  const titleBand = { id: 'title', measure: w => titleHeight(facts, w), draw: (x, y, w, out) => titleBlock({ x, y, w, out, fileName, analysis, plan, colors, facts }) }
  const mapBand = { id: 'map', measure: () => stripHeight(links), draw: (x, y, w, out) => overviewStrip(plan, regions, colors, x, y, w, out, { links, entryOffset: entryAt }) }
  const pair = unusual && tiles ? pairBand(unusual, tiles) : null
  const pairTM = tiles && memory ? pairBand(tiles, memory) : null
  const headBand = pairBand(titleBand, mapBand, { share: 0.34, min: 1500 })
  const pairWidth = w => (w < PAIR_MIN ? w : Math.floor((w - PAIR_GAP) / 2))
  // The readable text comes right after the unusual box, unless it leads, just under the title
  const middle = (paired, lead) => {
    const after = lead ? [] : [text]
    return (paired === 'UT' ? [pair, ...after, memory] : paired === 'TM' ? [unusual, ...after, pairTM] : [unusual, ...after, tiles, memory]).filter(Boolean)
  }
  const stackHeight = (list, w) => list.reduce((s, b) => s + b.measure(w) + BAND_GAP, 0)

  // The arrangements tried. 'stack': every band across the page above the
  // body. 'side': the dump on the left at full height, and on its right a
  // column with the bands above the legend; the file map either heads that
  // column or spans the page under the title.
  // The readable text either leads (right under the title) or follows the
  // unusual box; leading is tried first, so it wins a tie
  const specs = []
  for (const lead of text ? [true, false] : [false]) {
    const first = lead ? [text] : []
    for (const paired of [false, ...(pair ? ['UT'] : []), ...(pairTM ? ['TM'] : [])]) {
      const mid = middle(paired, lead)
      specs.push({ layout: 'stack', paired, lead, top: [titleBand, ...first, mapBand, ...mid], side: [] })
      if (plan.items.length) {
        specs.push({ layout: 'side', paired, lead, top: [titleBand, ...first], side: [mapBand, ...mid] })
        specs.push({ layout: 'side-map', paired, lead, top: [titleBand, ...first, mapBand], side: mid })
        // The title beside the file map: one header band instead of two
        specs.push({ layout: 'side-head', paired, lead, top: [headBand, ...first], side: mid })
        // The column on the left with the title at its head, the dump on the right
        specs.push({ layout: 'left', paired, lead, top: [], side: [titleBand, ...first, mapBand, ...mid] })
      }
    }
  }

  // Splitting the dump into columns must not cost the connectors that tell
  // the story: a split that loses one has to save a third of the page
  const dumpW = geometry.width + rail
  const rowsTotal = plan.items.length
  const splits = []
  for (const dumpColumns of [1, 2, 3, 4]) {
    if (dumpColumns > 1 && rowsTotal < dumpColumns * 20) break
    const split = splitItems(plan.items, dumpColumns)
    const dumpH = Math.max(0, ...split.map(([a, b]) => (b > a ? hexGeometry({ ...plan, items: plan.items.slice(a, b) }).height : 0)))
    splits.push({ dumpColumns, split, dumpH, allDumpW: dumpColumns * dumpW + (dumpColumns - 1) * DUMP_GAP })
  }
  const story = rail ? splits.map(s => storyConnectors(plan, entryAt, s.split)) : splits.map(() => 0)

  // Pick the arrangement that wastes the least page for this proportion
  let best = null
  const consider = candidate => {
    let w = candidate.innerW + 2 * MARGIN
    let h = 2 * MARGIN + stackHeight(candidate.spec.top, candidate.innerW) + candidate.bodyH + FOOT_H + 20
    if (w / h < ratio) w = h * ratio
    else h = w / ratio
    // Notes the unusual box cannot show count against an arrangement
    const unusualW = !unusual ? 0 : candidate.spec.side.includes(unusual) ? candidate.sideW : candidate.spec.side.includes(pair) ? pairWidth(candidate.sideW) : candidate.spec.top.includes(pair) ? pairWidth(candidate.innerW) : candidate.innerW
    const hidden = unusual ? unusual.hidden(unusualW) : 0
    const area = w * h * candidate.penalty * (1 + 0.04 * hidden)
    if (!best || area < best.area * 0.97) best = { ...candidate, w, h, area }
  }
  splits.forEach((s, si) => {
    const penalty = story[si] < story[0] ? 1.5 : 1
    for (const spec of specs) {
      if (spec.layout === 'stack') {
        for (const stacked of [false, true]) {
          for (let k = 1; k <= 4; k++) {
            const flow = flowColumns(blocks, k, stacked ? 0 : s.dumpH)
            const legendW = flow.cols.length * LEGEND_W + (flow.cols.length - 1) * COL_GAP
            const bodyW = stacked ? Math.max(s.allDumpW, legendW) : s.allDumpW + (flow.cols.length ? BODY_GAP + legendW : 0)
            const bodyH = stacked ? s.dumpH + (flow.height ? 36 + flow.height : 0) : Math.max(s.dumpH, flow.height)
            consider({ spec, ...s, penalty, stacked, flow, legendW, bodyW, bodyH, innerW: Math.max(MIN_INNER_W, bodyW) })
            if (flow.cols.length < k) break
          }
        }
      } else {
        for (let k = 1; k <= 5; k++) {
          const sideW = Math.max(SIDE_MIN, k * LEGEND_W + (k - 1) * COL_GAP)
          const sideH = stackHeight(spec.side, sideW)
          const flow = flowColumns(blocks, k, Math.max(0, s.dumpH - sideH))
          const bodyW = s.allDumpW + BODY_GAP + sideW
          const bodyH = Math.max(s.dumpH, sideH + flow.height)
          consider({ spec, ...s, penalty, flow, sideW, bodyW, bodyH, innerW: Math.max(MIN_INNER_W, bodyW) })
        }
      }
    }
  })

  const width = Math.ceil(best.w)
  const height = Math.ceil(best.h)
  const out = { elements: [], boxes: [] }
  const innerX = MARGIN
  const innerW = width - 2 * MARGIN
  out.elements.push({ t: 'rect', x: 0, y: 0, w: width, h: height, fill: colors.background })

  const drawBands = (list, x, y, w) => {
    for (const band of list) {
      const first = out.elements.length
      band.draw(x, y, w, out)
      for (let e = first; e < out.elements.length; e++) if (!out.elements[e].g) out.elements[e].g = `band:${band.id}`
      y += band.measure(w) + BAND_GAP
    }
    return y
  }
  const drawLegend = (flow, x0, y0) => {
    flow.cols.forEach((col, i) => {
      let ly = y0
      const x = x0 + i * (LEGEND_W + COL_GAP)
      for (const block of col) {
        const first = out.elements.length
        block.draw(x, ly, out)
        const g = `legend:${blocks.indexOf(block)}`
        for (let e = first; e < out.elements.length; e++) out.elements[e].g = g
        ly += block.h
      }
    })
  }
  const drawDump = (x0, y0) => {
    if (!plan.items.length) return
    const columns = []
    best.split.forEach(([a, b], i) => {
      if (b <= a) return
      const sub = best.split.length > 1 ? { ...plan, items: plan.items.slice(a, b) } : plan
      const ox = x0 + i * (dumpW + DUMP_GAP)
      const g = hexDump(sub, bytes, colors, shadeOf, parentShade, ox, y0, out) || hexGeometry(sub)
      columns.push({ start: a, end: b, ox, oy: y0, g })
      out.boxes.push({ role: 'dumptext', x: ox + g.hexX - 3, y: y0 + 30, w: g.asciiEnd - g.hexX + 3, h: Math.max(0, g.height - 36) })
      if (i > 0) out.elements.push({ t: 'line', x1: ox - DUMP_GAP / 2, y1: y0 + 4, x2: ox - DUMP_GAP / 2, y2: y0 + best.dumpH - 4, stroke: colors.rule, sw: 0.75, dash: '2 4' })
    })
    if (rail) drawDumpPointers({ plan, columns, entryOffset: entryAt, shadeOf, colors, out })
  }

  // Bands across the top; spare height goes below the body
  const by = drawBands(best.spec.top, innerX, MARGIN, innerW)

  if (best.spec.layout === 'stack') {
    const bx = innerX + Math.max(0, (innerW - best.bodyW) / 2)
    if (best.stacked) {
      drawDump(bx + (best.bodyW - best.allDumpW) / 2, by)
      drawLegend(best.flow, bx + (best.bodyW - best.legendW) / 2, by + best.dumpH + 36)
    } else {
      drawDump(bx, by)
      const legendX = bx + best.allDumpW + BODY_GAP
      drawLegend(best.flow, legendX, by)
      if (best.flow.cols.length && blocks.length) {
        out.elements.push({ t: 'line', x1: legendX - BODY_GAP / 2, y1: by + 4, x2: legendX - BODY_GAP / 2, y2: by + best.bodyH - 4, stroke: colors.rule, sw: 0.75 })
      }
    }
  } else {
    // The side column takes any width the proportion adds, and the legend
    // spreads into more columns when that keeps it within the body's height
    const left = best.spec.layout === 'left'
    const sideW = innerW - best.allDumpW - BODY_GAP
    const sx = left ? innerX : innerX + best.allDumpW + BODY_GAP
    drawDump(left ? innerX + sideW + BODY_GAP : innerX, by)
    const legendY = drawBands(best.spec.side, sx, by, sideW)
    const room = height - MARGIN - FOOT_H - 20 - legendY
    let flow = best.flow
    const most = Math.max(1, Math.min(6, Math.floor((sideW + COL_GAP) / (LEGEND_W + COL_GAP))))
    if (most > flow.cols.length) {
      const wider = flowColumns(blocks, most, Math.max(0, by + best.dumpH - legendY))
      if (wider.height <= room) flow = wider
    }
    drawLegend(flow, sx, legendY)
    const rule = left ? sx + sideW + BODY_GAP / 2 : sx - BODY_GAP / 2
    out.elements.push({ t: 'line', x1: rule, y1: by + 4, x2: rule, y2: Math.max(by + best.dumpH, legendY + flow.height) - 4, stroke: colors.rule, sw: 0.75 })
  }

  // Footer
  const fy = height - MARGIN - 18
  out.elements.push({ t: 'line', x1: innerX, y1: fy - 18, x2: innerX + innerW, y2: fy - 18, stroke: colors.rule, sw: 0.75 })
  const credit = [{ text: 'made with ', fill: colors.muted }, { text: 'hex.dance', fill: colors.accent, weight: 700 }]
  if (date) credit.push({ text: ` · ${date}`, fill: colors.muted })
  out.elements.push({ t: 'text', x: innerX, y: fy, size: 12, fill: colors.muted, spans: credit })
  const shown = plan.shown
  const what = plan.mode === 'tour' ? 'showing rows from across the file' : shown ? `showing ${hexOffset(shown.start)}–${hexOffset(shown.end - 1)}` : ''
  const coverage = shown
    ? `${what} · ${plan.bytesPerRow} bytes per row · ${plan.labels.length} label${plan.labels.length === 1 ? '' : 's'}`
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

  return {
    width,
    height,
    elements: out.elements,
    boxes: out.boxes,
    arrangement: {
      layout: best.spec.layout,
      paired: best.spec.paired,
      stacked: Boolean(best.stacked),
      columns: best.flow.cols.length,
      dumpColumns: best.dumpColumns,
      textLeads: Boolean(text && best.spec.lead),
      bands: [titleBand, mapBand, unusual, text, tiles, memory].filter(Boolean).map(b => b.id)
    },
    available
  }
}

/**
 * Two bands side by side, half the width each, when the width allows; one
 * above the other otherwise.
 */
function pairBand(a, b, { share = 0.5, min = PAIR_MIN } = {}) {
  const halves = w => {
    const wa = Math.floor((w - PAIR_GAP) * share)
    return [wa, w - PAIR_GAP - wa]
  }
  return {
    id: `${a.id}+${b.id}`,
    measure(w) {
      if (w < min) return a.measure(w) + BAND_GAP + b.measure(w)
      const [wa, wb] = halves(w)
      return Math.max(a.measure(wa), b.measure(wb))
    },
    draw(x, y, w, out) {
      if (w < min) {
        a.draw(x, y, w, out)
        b.draw(x, y + a.measure(w) + BAND_GAP, w, out)
        return
      }
      const [wa, wb] = halves(w)
      a.draw(x, y, wa, out)
      b.draw(x + wa + PAIR_GAP, y, wb, out)
    }
  }
}

/** Splits the dump's items into `n` columns of about the same length, preferring to end a column on a break. */
function splitItems(items, n) {
  if (n <= 1) return [[0, items.length]]
  const out = []
  let start = 0
  for (let c = 1; c < n; c++) {
    let cut = Math.round((items.length * c) / n)
    for (let d = 0; d <= 4; d++) {
      if (items[cut + d - 1]?.type === 'break') { cut += d; break }
      if (items[cut - d - 1]?.type === 'break' && cut - d > start + 1) { cut -= d; break }
    }
    cut = Math.max(start + 1, Math.min(items.length, cut))
    out.push([start, cut])
    start = cut
  }
  out.push([start, items.length])
  return out
}

const FACT_F = 12.5
const FACT_LINE = 17
const FACT_SEP = '   '

/**
 * The summary facts broken into lines of width `w`: each fact whole on one
 * line; only a value longer than a line by itself is cut.
 * @returns {Array<Array<{ label: string, value: string }>>}
 */
export function factLines(facts, w) {
  const budget = charsFor(w, FACT_F)
  const lines = []
  let line = []
  let used = 0
  for (const fact of facts) {
    const label = truncate(fact.label, Math.max(1, Math.floor(budget / 2)))
    const piece = textLength(label + ' ' + fact.value)
    const sep = line.length ? FACT_SEP.length : 0
    if (line.length && used + sep + piece > budget) {
      lines.push(line)
      line = []
      used = 0
    }
    const value = piece > budget ? truncate(fact.value, Math.max(1, budget - textLength(label) - 1)) : fact.value
    line.push({ label, value })
    used += (line.length > 1 ? FACT_SEP.length : 0) + textLength(label + ' ' + value)
  }
  if (line.length) lines.push(line)
  return lines
}

/** Height of the title block at width `w`. */
function titleHeight(facts, w) {
  if (!facts.length) return 62
  return 84 + (factLines(facts, w).length - 1) * FACT_LINE
}

function titleBlock({ x, y, w, out, fileName, analysis, plan, colors, facts }) {
  const title = truncate(fileName || 'untitled', charsFor(w, 30))
  out.elements.push({ t: 'text', x, y: y + 26, size: 30, weight: 700, fill: colors.accent, text: title, cls: 'title' })
  out.boxes.push({ role: 'head', x, y, w: textWidth(title, 30), h: 34 })
  const formatName = analysis?.formatName || 'Unknown format'
  const sizeText = plan.size < 1024 ? formatSize(plan.size) : `${formatSize(plan.size)} (${formatCount(plan.size)} bytes)`
  const subtitle = truncate(`${formatName} · ${sizeText}`, charsFor(w, 15))
  out.elements.push({ t: 'text', x, y: y + 54, size: 15, fill: colors.text, text: subtitle })
  out.boxes.push({ role: 'head', x, y: y + 41, w: textWidth(subtitle, 15), h: 17 })
  factLines(facts, w).forEach((line, i) => {
    const spans = []
    let used = 0
    line.forEach((fact, k) => {
      const sep = k ? FACT_SEP : ''
      spans.push({ text: sep + fact.label + ' ', fill: colors.faint })
      spans.push({ text: fact.value, fill: colors.text })
      used += textLength(sep + fact.label + ' ' + fact.value)
    })
    const baseline = y + 78 + i * FACT_LINE
    out.elements.push({ t: 'text', x, y: baseline, size: FACT_F, fill: colors.text, spans, preserve: true })
    out.boxes.push({ role: 'head', x, y: baseline - 11, w: Math.min(w, used * FACT_F * MEASURE), h: 14 })
  })
}
