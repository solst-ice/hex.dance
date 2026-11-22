// Disk versus memory: two bars to scale, the file on top and the loaded
// image below, with a band joining each section's bytes in the file to its
// place in memory. Readable from one section to a thousand: bands get thin
// and lose their outlines and labels as they get crowded, and sections that
// fall on the same pixels are drawn once.

import { truncate } from './escape.js'
import { textWidth, charsFor, hex, count, plural, whole, bytesText, placeOnRows } from './measure.js'
import { entrySection } from './tiles.js'

const MAX_SECTIONS = 1024
const HEAD_H = 22
const LABEL_W = 84
const BAR_H = 16
const BAND_H = 74
const SCALE_F = 10.5
const NAME_F = 9.5
const HEIGHT = HEAD_H + 22 + BAR_H + BAND_H + BAR_H + 40

/** Sections that can be drawn, with their disk and memory spans; null when nothing can. */
export function memoryParts(image, fileSize) {
  if (!image || !Array.isArray(image.sections)) return null
  const parts = []
  image.sections.slice(0, MAX_SECTIONS).forEach((s, index) => {
    const address = whole(s?.address)
    const memSize = whole(s?.memSize) ?? 0
    const offset = whole(s?.offset)
    const size = whole(s?.size) ?? 0
    const onDisk = offset !== null && size > 0 && offset < fileSize
    if (address === null || !Number.isFinite(address + memSize)) return
    if (memSize === 0 && !onDisk) return
    parts.push({
      index,
      name: String(s?.name ?? ''),
      address,
      memSize,
      offset: onDisk ? offset : null,
      size: onDisk ? Math.min(size, fileSize - offset) : 0,
      pastEnd: offset !== null && size > 0 && offset + size > fileSize
    })
  })
  if (!parts.length) return null
  let low = Infinity
  let high = -Infinity
  for (const p of parts) {
    low = Math.min(low, p.address)
    high = Math.max(high, p.address + Math.max(p.memSize, 1))
  }
  return { parts, low, high, total: Math.max(image.sections.length, whole(image.total) ?? 0) }
}

/**
 * @returns {null | { id: string, measure: (w: number) => number, draw: (x: number, y: number, w: number, out: Object) => void }}
 */
export function memoryBand({ analysis, colors, fileSize }) {
  const image = analysis?.image
  const info = memoryParts(image, fileSize)
  if (!info || fileSize <= 0) return null
  const label = image.addressLabel === 'RVA' ? 'RVA ' : ''
  const entry = image.entry || null
  const entryAddress = whole(entry?.address)
  const entryOffset = whole(entry?.offset)
  const entryIndex = entrySection(image)

  return {
    id: 'memory',
    measure: () => HEIGHT,
    draw(x, y, w, out) {
      const el = out.elements
      const bx = x + LABEL_W
      const bw = w - LABEL_W
      const span = Math.max(1, info.high - info.low)
      const dx = n => bx + (Math.min(fileSize, Math.max(0, n)) / fileSize) * bw
      const mx = n => bx + ((Math.min(info.high, Math.max(info.low, n)) - info.low) / span) * bw
      const n = info.parts.length
      const crowded = n > 64
      const shade = i => colors.shades.data[i % 2 ? 2 : 0]
      const diskY = y + HEAD_H + 22
      const memY = diskY + BAR_H + BAND_H

      const title = 'ON DISK AND IN MEMORY'
      el.push({ t: 'text', x, y: y + 12, size: 11, fill: colors.accent2, weight: 700, text: title, ls: 1.5 })
      out.boxes.push({ role: 'memory', x, y, w: textWidth(title, 11) + 10, h: 14 })
      const memOnly = info.parts.filter(p => p.offset === null).length
      const pastEnd = info.parts.filter(p => p.pastEnd).length
      const notes = [`${plural(info.total, 'section')}, both bars to scale`]
      if (memOnly) notes.push(`${count(memOnly)} only in memory`)
      if (pastEnd) notes.push(`${count(pastEnd)} cut off by the end of the file`)
      if (info.total > n) notes.push(`showing ${count(n)}`)
      const note = truncate(notes.join(' · '), charsFor(w - textWidth(title, 11) - 30, 11))
      el.push({ t: 'text', x: x + w, y: y + 12, size: 11, fill: colors.faint, anchor: 'end', text: note })
      out.boxes.push({ role: 'memory', x: x + w - textWidth(note, 11), y, w: textWidth(note, 11), h: 14 })

      el.push({ t: 'text', x, y: diskY + 12, size: 11.5, fill: colors.muted, weight: 700, text: 'on disk' })
      el.push({ t: 'text', x, y: memY + 12, size: 11.5, fill: colors.muted, weight: 700, text: 'in memory' })

      // Bars
      el.push({ t: 'rect', x: bx, y: diskY, w: bw, h: BAR_H, rx: 2, fill: colors.panel, stroke: colors.rule, sw: 1 })
      el.push({ t: 'rect', x: bx, y: memY, w: bw, h: BAR_H, rx: 2, fill: colors.panel, stroke: colors.rule, sw: 1 })
      // Headers: the bytes before the first section's data
      const firstData = Math.min(fileSize, ...info.parts.filter(p => p.offset !== null).map(p => p.offset))
      if (firstData > 0) {
        const hw = dx(firstData) - bx
        el.push({ t: 'rect', x: bx + 0.5, y: diskY + 0.5, w: Math.max(1, hw - 0.5), h: BAR_H - 1, fill: colors.shades.header[0], fillOpacity: 0.55 })
        if (hw > textWidth('headers', NAME_F) + 6) el.push({ t: 'text', x: bx + 3, y: diskY + 11.5, size: NAME_F, fill: colors.text, text: 'headers' })
      }

      // Bands, behind the bars' contents
      const bands = []
      let last = ''
      info.parts.forEach((p, i) => {
        if (p.offset === null || p.memSize === 0) return
        const d1 = dx(p.offset)
        const d2 = Math.max(d1 + 0.6, dx(p.offset + p.size))
        const m1 = mx(p.address)
        const m2 = Math.max(m1 + 0.6, mx(p.address + p.memSize))
        const key = `${Math.round(d1)},${Math.round(d2)},${Math.round(m1)},${Math.round(m2)}`
        if (crowded && key === last) return
        last = key
        const top = diskY + BAR_H
        const bottom = memY
        bands.push({ t: 'poly', points: [[d1, top], [d2, top], [m2, bottom], [m1, bottom]], fill: shade(i), fillOpacity: crowded ? 0.2 : 0.24, stroke: crowded ? undefined : shade(i), sw: 0.6 })
      })
      el.push(...bands)

      // Sections on both bars
      let lastDisk = -1
      let lastMem = -1
      const names = []
      info.parts.forEach((p, i) => {
        const color = shade(i)
        if (p.offset !== null) {
          const d1 = dx(p.offset)
          const d2 = Math.max(d1 + 0.8, dx(p.offset + p.size))
          if (!crowded || Math.round(d1) !== lastDisk) {
            el.push({ t: 'rect', x: d1, y: diskY + 1, w: d2 - d1, h: BAR_H - 2, fill: color, fillOpacity: 0.85 })
            lastDisk = Math.round(d1)
          }
        }
        if (p.memSize > 0) {
          const m1 = mx(p.address)
          const m2 = Math.max(m1 + 0.8, mx(p.address + p.memSize))
          if (!crowded || Math.round(m1) !== lastMem) {
            if (p.offset === null) {
              el.push({ t: 'rect', x: m1 + 0.5, y: memY + 1.5, w: Math.max(0.5, m2 - m1 - 1), h: BAR_H - 3, fill: 'none', stroke: color, sw: 1, dash: '3 2' })
            } else {
              el.push({ t: 'rect', x: m1, y: memY + 1, w: m2 - m1, h: BAR_H - 2, fill: color, fillOpacity: 0.85 })
            }
            lastMem = Math.round(m1)
          }
          names.push({ p, m1, m2 })
        }
      })
      // Section names where they fit; numbers for unnamed sections only when every one fits
      if (!crowded) {
        const unnamed = names.filter(e => !e.p.name.trim())
        const numbersFit = unnamed.every(e => textWidth(String(e.p.index + 1), NAME_F) + 4 <= e.m2 - e.m1)
        for (const e of names) {
          const text = e.p.name.trim() ? truncate(e.p.name, charsFor(e.m2 - e.m1 - 4, NAME_F)) : numbersFit ? String(e.p.index + 1) : ''
          if (!text || textWidth(text, NAME_F) + 4 > e.m2 - e.m1 || (e.p.name.trim() && text.length < 2)) continue
          el.push({ t: 'text', x: (e.m1 + e.m2) / 2, y: memY + 11.5, size: NAME_F, fill: e.p.offset === null ? colors.text : colors.tabText, weight: 700, anchor: 'middle', text })
        }
      }

      // Scale ends and the entry point
      const above = [[]]
      const below = [[], []]
      const put = (rows, ax, text, fill, baseline, step, anchor) => {
        const tw = textWidth(text, SCALE_F)
        let left = anchor === 'end' ? ax - tw : anchor === 'middle' ? ax - tw / 2 : ax
        left = Math.max(bx, Math.min(bx + bw - tw, left))
        const r = placeOnRows(rows, left, tw)
        if (r < 0) return false
        el.push({ t: 'text', x: left, y: baseline + r * step, size: SCALE_F, fill, text })
        out.boxes.push({ role: 'memory', x: left, y: baseline + r * step - 10, w: tw, h: 12 })
        return true
      }
      put(above, bx, '0x0', colors.faint, diskY - 6, 0)
      put(above, bx + bw, `${hex(fileSize)} · ${bytesText(fileSize)}`, colors.faint, diskY - 6, 0, 'end')
      put(below, bx, `${label}${hex(info.low)}`, colors.faint, memY + BAR_H + 18, 14)
      put(below, bx + bw, `${label}${hex(info.high)}`, colors.faint, memY + BAR_H + 18, 14, 'end')
      if (entryAddress !== null && entryAddress >= info.low && entryAddress <= info.high) {
        const ex = mx(entryAddress)
        const where = entryIndex >= 0 ? ` (section ${entryIndex + 1})` : ''
        el.push({ t: 'poly', points: [[ex, memY + BAR_H + 1], [ex - 4, memY + BAR_H + 7], [ex + 4, memY + BAR_H + 7]], fill: colors.accent3 })
        el.push({ t: 'line', x1: ex, y1: memY - 3, x2: ex, y2: memY + BAR_H, stroke: colors.accent3, sw: 1.5 })
        put(below, ex, `entry point ${label}${hex(entryAddress)}${where}`, colors.accent3, memY + BAR_H + 18, 14, 'middle') ||
          put(below, ex, 'entry point', colors.accent3, memY + BAR_H + 18, 14, 'middle')
      }
      if (entryOffset !== null && entryOffset < fileSize) {
        const ex = dx(entryOffset)
        el.push({ t: 'line', x1: ex, y1: diskY - 2, x2: ex, y2: diskY + BAR_H + 4, stroke: colors.accent3, sw: 1.5 })
        el.push({ t: 'poly', points: [[ex, diskY + BAR_H + 1], [ex - 4, diskY + BAR_H + 7], [ex + 4, diskY + BAR_H + 7]], fill: colors.accent3 })
      }
      out.boxes.push({ role: 'memory', x: bx, y: diskY, w: bw, h: memY + BAR_H - diskY })
    }
  }
}
