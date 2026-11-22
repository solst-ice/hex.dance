// Small text and number helpers shared by the poster's drawings (file map
// arcs, pointer connectors, the unusual box, section tiles, the disk and
// memory diagram). They match the measurements in layout.js: monospace text
// measured a little wide so fonts slightly broader than 0.6em still fit.

import { truncate, textLength } from './escape.js'

export const MEASURE = 0.62

/** Width of `text` at font size `size`, in SVG units. */
export const textWidth = (text, size) => textLength(text) * size * MEASURE

/** How many characters of size `size` fit in `width`. */
export function charsFor(width, size) {
  return Math.max(0, Math.floor(width / (size * MEASURE)))
}

/** '0x1A2B': the same spelling as hexOffset in layout.js. */
export function hex(n) {
  return Number.isFinite(n) && n >= 0 ? '0x' + Math.floor(n).toString(16).toUpperCase() : '?'
}

export function count(n) {
  return Math.round(n).toLocaleString('en-US')
}

export function plural(n, one, many = one + 's') {
  return `${count(n)} ${n === 1 ? one : many}`
}

/** A finite, non-negative whole number, or null. */
export function whole(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

/**
 * Splits text into lines of at most `maxChars` characters, at spaces; a word
 * longer than a line is cut. At most `maxLines` lines: the last one ends with
 * an ellipsis when anything was left out.
 */
export function wrapLines(text, maxChars, maxLines = Infinity) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  let cut = false
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (textLength(candidate) <= maxChars) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    if (lines.length >= maxLines) {
      cut = true
      line = ''
      break
    }
    line = textLength(word) > maxChars ? truncate(word, maxChars) : word
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    lines.length = maxLines
    cut = true
  }
  if (cut && lines.length) lines[lines.length - 1] = truncate(lines[lines.length - 1] + ' …', maxChars)
  return lines
}

export const overlaps = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01

/**
 * Places text labels on one of a few rows so that none overlap: tries each
 * row in turn and keeps the first where the label's box is free. Returns the
 * row index, or -1 when no row has room.
 * @param {Array<Array<{x: number, w: number}>>} taken  per row, boxes already placed
 */
export function placeOnRows(taken, x, w, gap = 8) {
  for (let r = 0; r < taken.length; r++) {
    if (taken[r].every(b => x + w + gap <= b.x || b.x + b.w + gap <= x)) {
      taken[r].push({ x, w })
      return r
    }
  }
  return -1
}

/** '52.5 KB': the same spelling as formatSize in layout.js. */
export function bytesText(n) {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return `${count(n)} byte${n === 1 ? '' : 's'}`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB', 'EB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
