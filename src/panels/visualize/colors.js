// Reads theme colours from CSS variables so the canvases follow the theme.

import { BYTE_CLASSES } from '../../components/hex/bytes.js'

let probe = null

/** Any CSS colour string -> [r, g, b], or the fallback when it cannot be parsed. */
export function parseColor(value, fallback = [128, 128, 128]) {
  if (typeof document === 'undefined') return fallback
  if (!probe) probe = document.createElement('canvas').getContext('2d')
  if (!probe) return fallback
  // An invalid value leaves the sentinel in place
  probe.fillStyle = '#010203'
  probe.fillStyle = value || ''
  const normal = probe.fillStyle
  if (normal === '#010203') return fallback
  if (normal.startsWith('#')) {
    return [1, 3, 5].map(i => parseInt(normal.slice(i, i + 2), 16))
  }
  const match = normal.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : fallback
}

export function cssVar(name, element = document.documentElement) {
  return getComputedStyle(element).getPropertyValue(name).trim()
}

export function cssColor(name, fallback) {
  return parseColor(cssVar(name), fallback)
}

const CLASS_FALLBACK = {
  zero: [61, 69, 96], print: [247, 247, 28], ctrl: [95, 215, 255], ff: [255, 143, 64], high: [195, 141, 255]
}

let lastClassColors = null

/** RGB triples for the hex view's byte classes, in BYTE_CLASSES order. Same array while the theme is unchanged. */
export function byteClassColors() {
  const next = BYTE_CLASSES.map(name => cssColor(`--hx-byte-${name}`, CLASS_FALLBACK[name]))
  if (lastClassColors && String(lastClassColors) === String(next)) return lastClassColors
  lastClassColors = next
  return next
}

export function rgbString([r, g, b], alpha = 1) {
  return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** 256-entry RGB lookup running through the given colour stops. */
export function rampTable(stops) {
  const table = new Uint8ClampedArray(256 * 3)
  const segments = stops.length - 1
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * segments
    const k = Math.min(segments - 1, Math.floor(t))
    const f = t - k
    for (let c = 0; c < 3; c++) table[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f
  }
  return table
}

/** Sizes a canvas's backing store to its CSS box times the device pixel ratio; returns the ratio. */
export function fitCanvas(canvas, cssWidth, cssHeight) {
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(cssWidth * dpr))
  const height = Math.max(1, Math.round(cssHeight * dpr))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  return dpr
}
