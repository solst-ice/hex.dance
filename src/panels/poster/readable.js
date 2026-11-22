// The "readable text" band: the opening lines of the longest stretch of
// readable text on the poster, set as a page of a listing, so prose hidden in
// a file (the source text inside corkami's quine.exe, a licence, a script)
// reads as text rather than sixteen characters per hex row.
//
// Which stretches are text is the planner's call (plan.texts); this file only
// draws them. The bytes are untrusted: at most READ_CAP of them are read,
// decoded one byte per character (Latin-1) unless they are valid UTF-8, and
// every line goes through visibleText, so control, invisible and
// direction-changing characters show as markers such as ⟨U+202E⟩. The scene
// is rendered by render.js like every other text.

import { visibleText } from '../../lib/visibleText.js'
import { cleanText, truncate } from './escape.js'
import { textWidth, charsFor, hex, count, whole } from './measure.js'

/** Bytes read from the stretch, whatever its length. */
export const READ_CAP = 4096
/** Rows of text shown, wrapped rows included. */
export const MAX_ROWS = 12
const TAB_STOP = 4
const MIN_COLS = 16

const F = 13 // text size
const LINE = 18
const HEAD_H = 46 // title row and the "where" row
const PAD_X = 18
const PAD_TOP = 12
const PAD_BOTTOM = 10
const GUTTER = 14 // room for the mark on continued rows
const OTHERS_H = 24
const TAB_H = 15
const TAB_F = 10
const TITLE = 'READABLE TEXT'

// --- Decoding ---------------------------------------------------------------

/**
 * Whether bytes[start, end) are valid UTF-8. With `open` the stretch goes on
 * past `end`, so a sequence cut short by `end` is not held against it.
 */
export function isUtf8(bytes, start, end, open = false) {
  let i = start
  while (i < end) {
    const b = bytes[i]
    if (b < 0x80) {
      i++
      continue
    }
    let n
    let lo = 0x80
    let hi = 0xbf
    if (b >= 0xc2 && b <= 0xdf) n = 2
    else if (b >= 0xe0 && b <= 0xef) {
      n = 3
      if (b === 0xe0) lo = 0xa0 // overlong
      if (b === 0xed) hi = 0x9f // surrogates
    } else if (b >= 0xf0 && b <= 0xf4) {
      n = 4
      if (b === 0xf0) lo = 0x90
      if (b === 0xf4) hi = 0x8f
    } else return false
    for (let k = 1; k < n; k++) {
      if (i + k >= end) return open
      const c = bytes[i + k]
      if (c < (k === 1 ? lo : 0x80) || c > (k === 1 ? hi : 0xbf)) return false
    }
    i += n
  }
  return true
}

/**
 * Characters of bytes[start, end) with the byte offset (from `start`) where
 * each begins: UTF-8 when the bytes are valid UTF-8, otherwise one character
 * per byte (Latin-1). `used` is how many bytes the characters cover.
 */
export function decodeText(bytes, start, end, open = false) {
  const utf8 = isUtf8(bytes, start, end, open)
  const chars = []
  const at = []
  let ascii = true
  let i = start
  while (i < end) {
    const b = bytes[i]
    if (b < 0x80 || !utf8) {
      if (b >= 0x80) ascii = false
      chars.push(String.fromCharCode(b))
      at.push(i - start)
      i++
      continue
    }
    ascii = false
    const n = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2
    if (i + n > end) break // cut short by the read cap
    let cp = b & (n === 2 ? 0x1f : n === 3 ? 0x0f : 0x07)
    for (let k = 1; k < n; k++) cp = (cp << 6) | (bytes[i + k] & 0x3f)
    chars.push(String.fromCodePoint(cp))
    at.push(i - start)
    i += n
  }
  return { chars, at, used: i - start, encoding: ascii ? 'ascii' : utf8 ? 'utf-8' : 'latin-1' }
}

// One token per character of the line: a marker such as ⟨U+0007⟩ stands for one
const TOKEN = /⟨U\+[0-9A-F]{4,6}⟩|[\s\S]/gu
const blank = chars => chars.every(c => c === ' ' || c === '\t')

/**
 * The excerpt: rows of text that fit `cols` columns, at most `maxRows` of
 * them, made of whole lines of the text (only a first line too long for every
 * row is shown in part), and how many bytes of the stretch follow them.
 * @returns {{ rows: Array<{ text: string, continued: boolean }>, more: number, encoding: string }}
 */
export function excerpt(bytes, offset, length, cols, maxRows = MAX_ROWS) {
  const end = Math.min(bytes.length, offset + length)
  const readEnd = Math.min(end, offset + READ_CAP)
  const open = readEnd < offset + length
  const { chars, at, used, encoding } = decodeText(bytes, offset, readEnd, open)
  const byteAt = k => (k < at.length ? at[k] : used)
  cols = Math.max(MIN_COLS, cols)

  // Lines, broken at CR, LF or CR LF; leading blank lines dropped
  const lines = []
  let first = 0
  let i = 0
  while (i < chars.length && lines.length <= maxRows) {
    const c = chars[i]
    if (c === '\r' || c === '\n') {
      const next = c === '\r' && chars[i + 1] === '\n' ? i + 2 : i + 1
      const line = chars.slice(first, i)
      if (lines.length || !blank(line)) lines.push({ start: first, chars: line, end: byteAt(next) })
      first = next
      i = next
      continue
    }
    i++
  }
  if (i >= chars.length && first < chars.length && lines.length <= maxRows) {
    const line = chars.slice(first)
    if (lines.length || !blank(line)) lines.push({ start: first, chars: line, end: used, open })
  }

  const rows = []
  let shown = 0 // bytes of the stretch behind the rows shown
  for (const line of lines) {
    const tokens = visibleText(line.chars.join('')).match(TOKEN) || []
    while (tokens.length && (tokens[tokens.length - 1] === ' ' || tokens[tokens.length - 1] === '\t')) tokens.pop()
    const wrapped = wrapTokens(tokens, cols)
    if (rows.length + wrapped.length > maxRows) {
      // Whole lines only, unless not even the first one fits
      if (rows.length === 0) {
        const part = wrapped.slice(0, maxRows)
        rows.push(...part.map((r, k) => ({ text: r.text, continued: k > 0 })))
        shown = byteAt(line.start + part[part.length - 1].next)
      }
      break
    }
    rows.push(...wrapped.map((r, k) => ({ text: r.text, continued: k > 0 })))
    shown = line.end
  }
  let more = Math.max(0, end - offset - shown)
  // Nothing but blank space after the rows: the text ends there
  if (more > 0 && !open && end - offset <= used) {
    const after = at.findIndex(a => a >= shown)
    if (after < 0 || chars.slice(after).every(c => /\s/.test(c))) more = 0
  }
  return { rows, more, encoding }
}

/**
 * Wraps one line's tokens into rows of at most `cols` columns: at the last
 * space in the second half of the row, or anywhere when there is none. Tabs
 * become spaces to the next tab stop. `next` is the token index after each row.
 */
function wrapTokens(tokens, cols) {
  if (!tokens.length) return [{ text: '', next: 0 }]
  const rows = []
  let i = 0
  while (i < tokens.length) {
    let col = 0
    let j = i
    let lastSpace = -1
    const widths = []
    while (j < tokens.length) {
      const t = tokens[j]
      const w = t === '\t' ? TAB_STOP - (col % TAB_STOP) : t.length > 1 && t.startsWith('⟨') ? t.length : 1
      if (col + w > cols && j > i) break
      if (t === ' ' || t === '\t') lastSpace = j
      widths.push(w)
      col += w
      j++
    }
    let stop = j
    let skip = 0
    if (j < tokens.length && lastSpace > i && lastSpace - i >= cols / 2) {
      stop = lastSpace
      skip = 1 // the space the row breaks at
    }
    let text = ''
    for (let k = i; k < stop; k++) text += tokens[k] === '\t' ? ' '.repeat(widths[k - i]) : tokens[k]
    rows.push({ text: text.replace(/\s+$/u, ''), next: stop + skip })
    i = stop + skip
  }
  return rows
}

// --- The band -----------------------------------------------------------------

/** The stretches to show: well-formed entries of plan.texts inside the file, longest first. */
export function textStretches(plan, size) {
  const list = Array.isArray(plan?.texts) ? plan.texts.slice(0, 16) : []
  const out = []
  for (const t of list) {
    const offset = whole(t?.offset)
    const length = whole(t?.length)
    if (offset === null || !length || offset >= size) continue
    out.push({ offset, length: Math.min(length, size - offset), label: Number.isSafeInteger(t.label) ? t.label : null, name: cleanText(t.name ?? '').trim() })
  }
  out.sort((a, b) => b.length - a.length || a.offset - b.offset)
  return out.slice(0, 3)
}

const ENCODING_NOTE = { ascii: 'ASCII', 'utf-8': 'UTF-8', 'latin-1': 'one byte per character (Latin-1)' }

/**
 * The band, or null when the plan marks no readable text.
 * @param {{ plan: Object, bytes: Uint8Array, colors: Object, tabFor?: (number: number|null) => ({ number: number, color: string }|null) }} input
 */
export function textBand({ plan, bytes, colors, tabFor = () => null }) {
  const size = Math.min(bytes?.length ?? 0, whole(plan?.size) ?? Infinity)
  const stretches = textStretches(plan, size)
  if (!stretches.length) return null
  const [main, ...others] = stretches
  // Nothing to show when the stretch holds no visible line at all
  if (!excerpt(bytes, main.offset, main.length, 80, 1).rows.length) return null
  const tab = tabFor(main.label)
  const name = main.name || 'Text'
  const where = `${hex(main.offset)} · ${count(main.length)} B`

  const cache = new Map()
  const layout = w => {
    const key = Math.round(w)
    if (cache.has(key)) return cache.get(key)
    const cols = charsFor(w - 2 * PAD_X - GUTTER, F)
    const ex = excerpt(bytes, main.offset, main.length, cols)
    const panelH = PAD_TOP + ex.rows.length * LINE + (ex.more > 0 ? LINE + 4 : 0) + PAD_BOTTOM
    const L = { ...ex, cols, panelH, height: HEAD_H + panelH + (others.length ? OTHERS_H : 0) }
    if (cache.size > 64) cache.clear()
    cache.set(key, L)
    return L
  }

  return {
    id: 'text',
    stretches,
    measure: w => layout(w).height,
    draw(x, y, w, out) {
      const L = layout(w)
      const el = out.elements
      el.push({ t: 'text', x, y: y + 12, size: 11, fill: colors.accent2, weight: 700, text: TITLE, ls: 1.5 })
      const note = truncate(`the opening lines · ${ENCODING_NOTE[L.encoding]}`, charsFor(w - textWidth(TITLE, 11) - 40, 11))
      if (note) el.push({ t: 'text', x: x + w, y: y + 12, size: 11, fill: colors.faint, anchor: 'end', text: note })

      // Where the text is, in the legend's words
      let wx = x
      const color = tab?.color || colors.accent2
      if (tab) {
        const number = String(tab.number)
        const tw = Math.max(20, number.length * TAB_F * 0.6 + 9)
        el.push({ t: 'tab', x, y: y + 22, w: tw, h: TAB_H, fill: tab.color, round: 'all' })
        el.push({ t: 'text', x: x + tw / 2, y: y + 33, size: TAB_F, weight: 700, fill: colors.tabText, anchor: 'middle', text: number })
        wx += tw + 8
      }
      const whereW = textWidth(where, 10.5)
      const nameText = truncate(name, charsFor(x + w - wx - whereW - 12, 12.5))
      el.push({ t: 'text', x: wx, y: y + 34, size: 12.5, weight: 700, fill: colors.text, text: nameText })
      el.push({ t: 'text', x: wx + textWidth(nameText, 12.5) + 10, y: y + 34, size: 10.5, fill: colors.faint, text: where })

      // The page of text
      const py = y + HEAD_H
      el.push({ t: 'rect', x, y: py, w, h: L.panelH, rx: 4, fill: colors.panel, stroke: colors.rule, sw: 1 })
      el.push({ t: 'rect', x, y: py, w: 4, h: L.panelH, rx: 2, fill: color })
      const tx = x + PAD_X + GUTTER
      L.rows.forEach((row, i) => {
        const baseline = py + PAD_TOP + i * LINE + F * 0.95
        if (row.continued) el.push({ t: 'text', x: x + PAD_X, y: baseline, size: F * 0.8, fill: colors.faint, text: '↪' })
        if (row.text) el.push({ t: 'text', x: tx, y: baseline, size: F, fill: colors.text, text: row.text, preserve: true, cls: 'txt' })
      })
      if (L.more > 0) {
        const baseline = py + PAD_TOP + L.rows.length * LINE + 4 + F * 0.95
        const text = `${count(L.more)} more byte${L.more === 1 ? '' : 's'} of text follow${L.more === 1 ? 's' : ''}`
        el.push({ t: 'text', x: tx, y: baseline, size: 11.5, fill: colors.muted, text: `… ${text}` })
      }

      // The other stretches, named in one line
      if (others.length) {
        const oy = py + L.panelH + 17
        const lead = `Also readable text: `
        el.push({ t: 'text', x, y: oy, size: 11, fill: colors.muted, text: lead })
        let ox = x + textWidth(lead, 11)
        others.forEach((t, i) => {
          const otab = tabFor(t.label)
          const words = `${t.name || 'text'} ${hex(t.offset)} · ${count(t.length)} B${i < others.length - 1 ? ';' : ''}`
          const tw = otab ? Math.max(18, String(otab.number).length * 9 * 0.6 + 8) : 0
          const room = x + w - ox - (otab ? tw + 6 : 0)
          const text = truncate(words, charsFor(room, 11))
          if (!text || text === '…') return
          if (otab) {
            el.push({ t: 'tab', x: ox, y: oy - 10.5, w: tw, h: 13, fill: otab.color, round: 'all' })
            el.push({ t: 'text', x: ox + tw / 2, y: oy - 1, size: 9, weight: 700, fill: colors.tabText, anchor: 'middle', text: String(otab.number) })
            ox += tw + 6
          }
          el.push({ t: 'text', x: ox, y: oy, size: 11, fill: colors.muted, text })
          ox += textWidth(text, 11) + 12
        })
      }
      out.boxes.push({ role: 'text', x, y, w, h: L.height })
    }
  }
}
