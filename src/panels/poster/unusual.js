// The "what's unusual" box: plain sentences from the parsers (untrusted text,
// cleaned, wrapped and cut to fit) plus facts the poster works out itself,
// each with the offset that shows it. At most a handful of lines, in one or
// two columns.

import { cleanText } from './escape.js'
import { textWidth, charsFor, hex, plural, whole, wrapLines } from './measure.js'

const F = 13
const LINE = 18
const PAD_X = 16
const PAD_TOP = 34
const PAD_BOTTOM = 12
const NOTE_GAP = 5
const MAX_NOTES = 24
const TWO_COLUMNS_AT = 840
const COLUMN_GAP = 28

/** The notes to show: parser notes first, then computed facts; empty texts and repeats dropped. */
export function unusualNotes(analysis, facts = []) {
  const raw = Array.isArray(analysis?.unusual) ? analysis.unusual.slice(0, MAX_NOTES) : []
  const seen = new Set()
  const notes = []
  const add = (text, offset) => {
    const clean = cleanText(text).trim()
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    notes.push({ text: clean, offset })
  }
  for (const note of raw) {
    if (!note || (typeof note.text !== 'string' && typeof note.text !== 'number')) continue
    add(note.text, whole(note.offset))
  }
  for (const fact of facts) if (fact) add(fact.text ?? fact, whole(fact.offset))
  return notes
}

function layout(notes, w) {
  const columns = w >= TWO_COLUMNS_AT && notes.length >= 2 ? 2 : 1
  const maxLines = columns === 2 ? 7 : 10
  const colW = (w - 2 * PAD_X - (columns - 1) * COLUMN_GAP) / columns
  const offW = notes.some(n => n.offset !== null) ? Math.max(...notes.map(n => (n.offset !== null ? textWidth(hex(n.offset), 11) : 0))) + 10 : 0
  const textChars = charsFor(colW - offW - 12, F)
  const cols = Array.from({ length: columns }, () => ({ items: [], lines: 0 }))
  let shown = 0
  // Two columns: the split in reading order that shows every note in the
  // fewest lines, when there is one
  if (columns === 2) {
    const wrapped = notes.map(note => ({ note, lines: wrapLines(note.text, textChars, 3) }))
    const total = wrapped.reduce((n, x) => n + x.lines.length, 0)
    let bestSplit = -1
    let bestH = Infinity
    let first = 0
    for (let i = 1; i < wrapped.length; i++) {
      first += wrapped[i - 1].lines.length
      const h = Math.max(first, total - first)
      if (first <= maxLines && total - first <= maxLines && h < bestH) {
        bestH = h
        bestSplit = i
      }
    }
    if (bestSplit > 0) {
      wrapped.forEach((x, i) => {
        const col = cols[i < bestSplit ? 0 : 1]
        col.items.push({ note: x.note, lines: x.lines, y: col.lines })
        col.lines += x.lines.length
      })
      const lineCount = Math.max(...cols.map(col => col.lines + col.items.length * (NOTE_GAP / LINE)))
      return { columns, colW, offW, cols, more: 0, height: PAD_TOP + lineCount * LINE + PAD_BOTTOM }
    }
  }
  // Otherwise fill columns in reading order: the first column, then the second
  let c = 0
  for (const note of notes) {
    let col = cols[c]
    let room = maxLines - col.lines
    const whole_ = wrapLines(note.text, textChars, 3)
    if (whole_.length > room && c < columns - 1) {
      c++
      col = cols[c]
      room = maxLines - col.lines
    }
    if (room < 1) break
    const lines = whole_.length <= room ? whole_ : wrapLines(note.text, textChars, room)
    if (!lines.length) continue
    col.items.push({ note, lines, y: col.lines })
    col.lines += lines.length
    shown++
  }
  // Balance two columns when everything fit in the first
  if (columns === 2 && cols[1].items.length === 0 && cols[0].items.length > 1) {
    const half = cols[0].lines / 2
    const moved = []
    while (cols[0].items.length > 1 && cols[0].lines - cols[0].items[cols[0].items.length - 1].lines.length >= half) {
      const item = cols[0].items.pop()
      cols[0].lines -= item.lines.length
      moved.unshift(item)
    }
    let y = 0
    for (const item of moved) {
      item.y = y
      y += item.lines.length
    }
    cols[1].items = moved
    cols[1].lines = y
  }
  const more = notes.length - shown
  const lineCount = Math.max(...cols.map(col => col.lines + col.items.length * (NOTE_GAP / LINE)))
  const height = PAD_TOP + lineCount * LINE + (more > 0 ? LINE : 0) + PAD_BOTTOM
  return { columns, colW, offW, cols, more, height }
}

/**
 * The band, or null when there is nothing to say.
 * @param {{ analysis: Object, colors: Object, facts?: Array<string|{text: string, offset?: number}> }} input
 */
export function unusualBand({ analysis, colors, facts = [] }) {
  const notes = unusualNotes(analysis, facts)
  if (!notes.length) return null
  return {
    id: 'unusual',
    notes,
    measure: w => layout(notes, w).height,
    /** Notes that do not fit at width `w` */
    hidden: w => layout(notes, w).more,
    draw(x, y, w, out) {
      const L = layout(notes, w)
      const el = out.elements
      el.push({ t: 'rect', x, y, w, h: L.height, rx: 5, fill: colors.panel, stroke: colors.accent3, sw: 1.5, g: 'unusual' })
      el.push({ t: 'rect', x, y, w: 5, h: L.height, rx: 2, fill: colors.accent3, g: 'unusual' })
      el.push({ t: 'text', x: x + PAD_X, y: y + 22, size: 12.5, weight: 700, fill: colors.accent3, ls: 1.5, text: "WHAT'S UNUSUAL", g: 'unusual' })
      out.boxes.push({ role: 'unusual', x, y, w, h: L.height })
      L.cols.forEach((col, ci) => {
        const cx = x + PAD_X + ci * (L.colW + COLUMN_GAP)
        for (const item of col.items) {
          const iy = y + PAD_TOP + item.y * LINE + col.items.indexOf(item) * NOTE_GAP
          if (item.note.offset !== null) {
            el.push({ t: 'text', x: cx, y: iy + 10, size: 11, fill: colors.accent3, text: hex(item.note.offset), g: 'unusual' })
          } else {
            el.push({ t: 'rect', x: cx + 1, y: iy + 4, w: 5, h: 5, rx: 1, fill: colors.accent3, g: 'unusual' })
          }
          item.lines.forEach((line, li) => {
            el.push({ t: 'text', x: cx + L.offW + (L.offW ? 0 : 12), y: iy + 11 + li * LINE, size: F, fill: colors.text, text: line, g: 'unusual' })
          })
        }
      })
      if (L.more > 0) {
        const rows = Math.max(...L.cols.map(col => col.lines + col.items.length * (NOTE_GAP / LINE)))
        el.push({ t: 'text', x: x + PAD_X, y: y + PAD_TOP + rows * LINE + 11, size: 11, fill: colors.muted, text: `… and ${plural(L.more, 'more')}.`, g: 'unusual' })
      }
    }
  }
}
