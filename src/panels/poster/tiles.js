// Sections as tiles coloured by content: one small tile per section (or per
// comparable part of the file when the format has no memory layout), the
// same colour and letter for byte-for-byte identical contents. Bounded: at
// most MAX_TILES tiles and HASH_CAP bytes read, whatever the file says.

import { crc32 } from '../../lib/crc32.js'
import { truncate } from './escape.js'
import { textWidth, charsFor, count, plural, whole, wrapLines } from './measure.js'

export const MAX_TILES = 512
export const HASH_CAP = 16 << 20

const HEAD_H = 22
const CAPTION_F = 12.5
const KEY_F = 10.5

// FNV-1a over bytes[start, end), 32 bits
function fnv1a(bytes, start, end) {
  let h = 0x811c9dc5
  for (let i = start; i < end; i++) h = Math.imul(h ^ bytes[i], 0x01000193)
  return h >>> 0
}

function sameBytes(bytes, a, b, length) {
  if (a === b) return true
  for (let i = 0; i < length; i++) if (bytes[a + i] !== bytes[b + i]) return false
  return true
}

/**
 * The parts to draw as tiles: the memory layout's sections, or, for formats
 * that are not loaded into memory, the file's data regions when there are at
 * least three of them (archive members, for instance).
 * @returns {{ kind: 'sections'|'parts', parts: Array<{ name: string, offset: number|null, size: number }>, total: number }|null}
 */
export function tileParts(analysis, fileSize) {
  const image = analysis?.image
  if (image && Array.isArray(image.sections)) {
    const list = image.sections.slice(0, MAX_TILES)
    if (!list.length) return null
    const total = Math.max(image.sections.length, whole(image.total) ?? 0)
    return {
      kind: 'sections',
      total,
      parts: list.map(s => {
        const offset = whole(s?.offset)
        const size = whole(s?.size) ?? 0
        return { name: String(s?.name ?? ''), offset, size }
      })
    }
  }
  if (image || analysis?.category === 'executable') return null
  const regions = Array.isArray(analysis?.regions) ? analysis.regions : []
  const data = []
  for (const r of regions) {
    if (!r || r.kind !== 'data') continue
    const offset = whole(r.offset)
    const size = whole(r.length)
    if (offset === null || size === null || offset >= fileSize) continue
    data.push({ name: String(r.name ?? ''), offset, size })
    if (data.length >= MAX_TILES) break
  }
  if (data.length < 3) return null
  return { kind: 'parts', total: data.length, parts: data }
}

/**
 * Groups parts by content. Each part gets `group` (index into `groups`, in
 * order of first appearance) or a `state` of 'empty' (no bytes in the file)
 * or 'unchecked' (beyond the hashing cap).
 * @param {Array<{ offset: number|null, size: number }>} parts
 * @param {Uint8Array} bytes
 */
export function contentGroups(parts, bytes, cap = HASH_CAP) {
  const length = bytes ? bytes.length : 0
  let budget = cap
  const groups = []
  const byKey = new Map()
  const out = parts.map(part => {
    const start = part.offset
    if (start === null || part.size <= 0 || start >= length) return { state: 'empty', group: -1 }
    const end = Math.min(length, start + part.size)
    const n = end - start
    if (n > budget) {
      budget = 0
      return { state: 'unchecked', group: -1 }
    }
    budget -= n
    const key = `${n}:${fnv1a(bytes, start, end)}:${crc32(bytes, start, end)}`
    let candidates = byKey.get(key)
    if (!candidates) byKey.set(key, (candidates = []))
    for (const index of candidates) {
      const g = groups[index]
      // Equal hashes are confirmed byte for byte, within the same budget
      if (n > budget) return { state: 'unchecked', group: -1 }
      budget -= n
      if (sameBytes(bytes, g.start, start, n)) {
        g.members++
        return { state: 'ok', group: index }
      }
    }
    groups.push({ start, size: n, members: 1 })
    candidates.push(groups.length - 1)
    return { state: 'ok', group: groups.length - 1 }
  })
  return { groups, parts: out, partial: parts.some((p, i) => out[i].state === 'unchecked') }
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export function groupName(index) {
  let s = ''
  let n = index
  do {
    s = LETTERS[n % 26] + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

// Hues for groups, in order of use: blue and yellow first (they differ in
// lightness as well as hue, so they stay apart for colour-blind readers),
// then pink, green, orange, purple, cyan, red
const GROUP_KINDS = ['data', 'size', 'magic', 'string', 'offset', 'flags', 'header', 'checksum']

/** One colour per group: the biggest groups get the most distinct hues; parts found once share grey when there are many groups. */
export function groupColors(groups, colors) {
  const order = groups.map((g, i) => i).sort((a, b) => groups[b].members - groups[a].members || a - b)
  const many = groups.length > GROUP_KINDS.length
  const result = new Array(groups.length)
  let next = 0
  for (const i of order) {
    if (many && groups[i].members < 2) result[i] = colors.shades.padding[0]
    else {
      const k = next++
      result[i] = colors.shades[GROUP_KINDS[k % GROUP_KINDS.length]][Math.floor(k / GROUP_KINDS.length) % 3]
    }
  }
  return result
}

/** The caption, in words: "96 sections. 2 different contents: 95 are identical." */
export function tilesCaption(info, grouped) {
  const noun = info.kind === 'sections' ? 'section' : 'part'
  const n = info.parts.length
  const sentences = []
  const compared = grouped.parts.filter(p => p.state === 'ok').length
  const g = grouped.groups.length
  const repeated = grouped.groups.filter(x => x.members > 1).sort((a, b) => b.members - a.members)
  const first = info.total > n ? `${plural(info.total, noun)}, the first ${count(n)} shown` : plural(info.total, noun)
  if (compared === 0) sentences.push(`${first}.`)
  else if (g === 1 && compared === n && n > 1) sentences.push(`${first}, all with identical contents.`)
  else if (!repeated.length) sentences.push(n === 1 ? `${first}.` : `${first}${compared === n ? ', all with different contents' : ''}.`)
  else {
    if (g === 1) sentences.push(`${first}. ${count(repeated[0].members)} have identical contents.`)
    else if (repeated.length === 1) sentences.push(`${first}. ${count(g)} different contents: ${count(repeated[0].members)} are identical.`)
    else {
      const shared = repeated.slice(0, 3).map((x, i) => `${i ? 'one' : 'one shared'} by ${count(x.members)}`)
      const rest = repeated.length > 3 ? `, and ${plural(repeated.length - 3, 'more shared one')}` : ''
      sentences.push(`${first}. ${count(g)} different contents: ${shared.join(', ')}${rest}.`)
    }
  }
  const empty = grouped.parts.filter(p => p.state === 'empty').length
  if (empty) sentences.push(`${count(empty)} ${empty === 1 ? 'has' : 'have'} no bytes in the file.`)
  const unchecked = grouped.parts.filter(p => p.state === 'unchecked').length
  if (unchecked) sentences.push(`${count(unchecked)} past the first ${Math.round(HASH_CAP / (1 << 20))} MB ${unchecked === 1 ? 'was' : 'were'} not compared.`)
  return sentences.join(' ')
}

/** A fact for the unusual box, when many sections share their contents. */
export function identicalFact(info, grouped) {
  if (!info || info.kind !== 'sections') return null
  const repeated = grouped.groups.filter(x => x.members > 1).sort((a, b) => b.members - a.members)
  if (!repeated.length) return null
  const n = info.parts.length
  const of = info.total > n ? `of the first ${count(n)}` : `of the ${count(n)}`
  if (repeated.length === 1) return `${count(repeated[0].members)} ${of} sections have identical contents.`
  const shared = repeated.reduce((s, x) => s + x.members, 0)
  return `${count(shared)} ${of} sections share their contents with another section.`
}

/** Index of the section that holds the entry point (by address, else by file offset), or -1. */
export function entrySection(image) {
  const entry = image?.entry
  const sections = Array.isArray(image?.sections) ? image.sections.slice(0, MAX_TILES) : []
  if (!entry) return -1
  const address = whole(entry.address)
  if (address !== null) {
    const i = sections.findIndex(s => whole(s?.address) !== null && whole(s?.memSize) > 0 && address >= s.address && address < s.address + s.memSize)
    if (i >= 0) return i
  }
  const offset = whole(entry.offset)
  if (offset === null) return -1
  return sections.findIndex(s => whole(s?.offset) !== null && whole(s?.size) > 0 && offset >= s.offset && offset < s.offset + s.size)
}

function tileSize(n) {
  if (n <= 48) return { w: 30, h: 26, gap: 5 }
  if (n <= 128) return { w: 24, h: 22, gap: 4 }
  if (n <= 256) return { w: 18, h: 18, gap: 3 }
  return { w: 13, h: 13, gap: 2 }
}

/**
 * The tiles band.
 * @returns {null | { id: string, measure: (w: number) => number, draw: (x: number, y: number, w: number, out: Object) => void, fact: string|null }}
 */
export function tilesBand({ analysis, bytes, colors }) {
  const size = bytes ? bytes.length : 0
  const info = tileParts(analysis, size)
  if (!info) return null
  const grouped = contentGroups(info.parts, bytes)
  const palette = groupColors(grouped.groups, colors)
  const caption = tilesCaption(info, grouped)
  const t = tileSize(info.parts.length)
  const entryIndex = info.kind === 'sections' ? entrySection(analysis.image) : -1
  const key = ['Same letter and colour: byte-for-byte the same contents']
  if (entryIndex >= 0) key.push('outlined: where execution starts')
  if (grouped.parts.some(p => p.state === 'empty')) key.push('dashed: no bytes in the file')
  if (grouped.parts.some(p => p.state === 'unchecked')) key.push('?: not compared')
  const keyText = key.join(' · ')

  const layout = w => {
    const most = Math.max(1, Math.floor((w + t.gap) / (t.w + t.gap)))
    const rows = Math.ceil(info.parts.length / most)
    // Rows of even length look deliberate; a short last row looks cut off
    const perRow = Math.ceil(info.parts.length / rows)
    const captionLines = wrapLines(caption, charsFor(w, CAPTION_F), 3)
    const keyLines = wrapLines(keyText, charsFor(w, KEY_F), 2)
    const tilesTop = HEAD_H + captionLines.length * 17 + 6
    const tilesH = rows * t.h + (rows - 1) * t.gap
    return { perRow, rows, captionLines, keyLines, tilesTop, tilesH, height: tilesTop + tilesH + 10 + keyLines.length * 14 }
  }

  return {
    id: 'tiles',
    fact: identicalFact(info, grouped),
    measure: w => layout(w).height,
    draw(x, y, w, out) {
      const L = layout(w)
      const el = out.elements
      const title = info.kind === 'sections' ? 'SECTIONS BY CONTENT' : 'PARTS BY CONTENT'
      el.push({ t: 'text', x, y: y + 12, size: 11, fill: colors.accent2, weight: 700, text: title, ls: 1.5 })
      out.boxes.push({ role: 'tiles', x, y, w: textWidth(title, 11) + 20, h: 14 })
      L.captionLines.forEach((line, i) => {
        el.push({ t: 'text', x, y: y + HEAD_H + 12 + i * 17, size: CAPTION_F, fill: colors.text, text: line })
        out.boxes.push({ role: 'tiles', x, y: y + HEAD_H + i * 17, w: textWidth(line, CAPTION_F), h: 15 })
      })
      const top = y + L.tilesTop
      const letterSize = Math.min(11, t.h * 0.5)
      info.parts.forEach((part, i) => {
        const col = i % L.perRow
        const row = Math.floor(i / L.perRow)
        const tx = x + col * (t.w + t.gap)
        const ty = top + row * (t.h + t.gap)
        const state = grouped.parts[i]
        const g = `tile:${i}`
        if (state.state === 'ok') {
          const color = palette[state.group]
          el.push({ t: 'rect', x: tx, y: ty, w: t.w, h: t.h, rx: 2, fill: color, fillOpacity: colors.style === 'print' ? 0.32 : 0.5, stroke: color, sw: 1, g })
          const letter = groupName(state.group)
          if (t.w >= 13 && textWidth(letter, letterSize) <= t.w - 3) {
            el.push({ t: 'text', x: tx + t.w / 2, y: ty + t.h / 2 + letterSize * 0.36, size: letterSize, weight: 700, fill: colors.text, anchor: 'middle', text: letter, g })
          }
        } else if (state.state === 'empty') {
          el.push({ t: 'rect', x: tx + 0.5, y: ty + 0.5, w: t.w - 1, h: t.h - 1, rx: 2, fill: 'none', stroke: colors.muted, sw: 1, dash: '2 2', g })
        } else {
          el.push({ t: 'rect', x: tx + 0.5, y: ty + 0.5, w: t.w - 1, h: t.h - 1, rx: 2, fill: colors.panel, stroke: colors.rule, sw: 1, g })
          if (t.w >= 13) el.push({ t: 'text', x: tx + t.w / 2, y: ty + t.h / 2 + letterSize * 0.36, size: letterSize, fill: colors.faint, anchor: 'middle', text: '?', g })
        }
        if (i === entryIndex) {
          el.push({ t: 'rect', x: tx - 2.5, y: ty - 2.5, w: t.w + 5, h: t.h + 5, rx: 3.5, fill: 'none', stroke: colors.accent3, sw: 2, g })
        }
      })
      out.boxes.push({ role: 'tiles', x: x - 2.5, y: top - 2.5, w: Math.min(info.parts.length, L.perRow) * (t.w + t.gap) - t.gap + 5, h: L.tilesH + 5 })
      const ky = top + L.tilesH + 10
      L.keyLines.forEach((line, i) => {
        el.push({ t: 'text', x, y: ky + 10 + i * 14, size: KEY_F, fill: colors.faint, text: truncate(line, charsFor(w, KEY_F)) })
        out.boxes.push({ role: 'tiles', x, y: ky + i * 14, w: textWidth(line, KEY_F), h: 12 })
      })
    }
  }
}
