// Turns a poster scene into a standalone SVG document. Every string from the
// file goes through escapeXml; numbers are rounded; nothing references
// anything outside the document.

import { escapeXml } from './escape.js'
import { planPoster } from './plan.js'
import { layoutPoster } from './layout.js'
import { posterColors } from './palette.js'

export const FONT_STACK = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace"

const n = v => {
  const r = Math.round(v * 100) / 100
  return Number.isFinite(r) ? String(r) : '0'
}

const attr = (name, value) => (value === undefined || value === null || value === '' ? '' : ` ${name}="${escapeXml(value)}"`)

function paint(el) {
  let out = ''
  if (el.fill !== undefined) out += attr('fill', el.fill)
  if (el.fillOpacity !== undefined && el.fillOpacity !== 1) out += attr('fill-opacity', n(el.fillOpacity))
  if (el.stroke) out += attr('stroke', el.stroke) + attr('stroke-width', n(el.sw ?? 1))
  if (el.dash) out += attr('stroke-dasharray', el.dash)
  if (typeof el.opacity === 'number' && el.opacity >= 0 && el.opacity < 1) out += attr('opacity', n(el.opacity))
  return out
}

function textElement(el) {
  let out = `<text x="${n(el.x)}" y="${n(el.y)}" font-size="${n(el.size)}"`
  if (el.fill) out += attr('fill', el.fill)
  if (el.weight) out += attr('font-weight', el.weight)
  if (el.anchor) out += attr('text-anchor', el.anchor)
  if (el.ls) out += attr('letter-spacing', n(el.ls))
  if (el.cls) out += attr('class', el.cls)
  if (el.preserve) out += ' xml:space="preserve"'
  out += '>'
  if (el.spans) {
    for (const span of el.spans) {
      out += '<tspan'
      if (span.xs) out += ` x="${span.xs.map(n).join(' ')}"`
      if (span.fill) out += attr('fill', span.fill)
      if (span.weight) out += attr('font-weight', span.weight)
      out += `>${escapeXml(span.text)}</tspan>`
    }
  } else {
    out += escapeXml(el.text)
  }
  return out + '</text>'
}

function element(el) {
  switch (el.t) {
    case 'rect':
    case 'tab':
      return `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(Math.max(0, el.w))}" height="${n(Math.max(0, el.h))}"${el.rx || el.t === 'tab' ? ` rx="${n(el.rx ?? 2)}"` : ''}${paint(el)}/>`
    case 'poly':
      return `<polygon points="${el.points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" stroke-linejoin="round"${paint(el)}/>`
    case 'line':
      return `<line x1="${n(el.x1)}" y1="${n(el.y1)}" x2="${n(el.x2)}" y2="${n(el.y2)}"${paint(el)}/>`
    case 'path':
      return `<path d="${escapeXml(el.d)}" fill="none" stroke-linecap="round" stroke-linejoin="round"${paint({ ...el, fill: undefined })}/>`
    case 'text':
      return textElement(el)
    default:
      return ''
  }
}

/**
 * @param {ReturnType<typeof layoutPoster>} scene
 * @param {{ title: string, description: string, background: string }} meta
 */
export function sceneToSvg(scene, meta) {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" font-family="${escapeXml(FONT_STACK)}" text-rendering="geometricPrecision">`,
    `<title>${escapeXml(meta.title)}</title>`,
    `<desc>${escapeXml(meta.description)}</desc>`
  ]
  let group = null
  for (const el of scene.elements) {
    if ((el.g || null) !== group) {
      if (group) parts.push('</g>')
      group = el.g || null
      if (group) parts.push(`<g class="${escapeXml(group.split(':')[0])}" data-id="${escapeXml(group)}">`)
    }
    parts.push(element(el))
  }
  if (group) parts.push('</g>')
  parts.push('</svg>')
  return parts.join('\n')
}

/**
 * Everything from bytes to SVG text.
 * @param {Object} input
 * @param {Uint8Array} input.bytes
 * @param {import('../../analysis/types.js').Analysis|null} input.analysis
 * @param {string} input.fileName
 * @param {Object} input.options   plan options plus `style` and `proportion`
 * @param {Object} [input.theme]   colours read from the page, for the dark style
 * @param {string} [input.date]
 */
export function buildPoster({ bytes, analysis, fileName, options = {}, theme, date = '' }) {
  const data = bytes || new Uint8Array(0)
  const plan = planPoster({ ...options, analysis, bytes: data, size: data.length })
  const colors = posterColors(options.style === 'print' ? 'print' : 'dark', theme)
  const scene = layoutPoster({ plan, bytes: data, analysis, fileName, colors, proportion: options.proportion, date })
  const svg = sceneToSvg(scene, {
    title: `${fileName || 'untitled'}: ${analysis?.formatName || 'file'} poster`,
    description: `Annotated hex dump of ${fileName || 'a file'} made with hex.dance${date ? ` on ${date}` : ''}.`
  })
  return { svg, plan, scene, width: scene.width, height: scene.height }
}
