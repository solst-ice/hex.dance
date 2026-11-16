// Theme colours for canvases and generated graphics. Themes are sets of CSS
// custom properties (src/styles/theme.css); a canvas cannot use var(), so it
// resolves them here to concrete colours, and redraws when the theme changes
// (the root element's data-theme attribute) through onThemeChange or
// useThemeVersion.

import { useEffect, useState } from 'react'
import { BYTE_CLASSES } from '../components/hex/bytes.js'

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

function channel(text) {
  const value = parseFloat(text)
  return text.endsWith('%') ? (value / 100) * 255 : value
}

function alpha(text) {
  if (text === undefined) return 1
  const value = parseFloat(text)
  return text.endsWith('%') ? value / 100 : value
}

/**
 * Parses the colour forms browsers produce for computed styles and canvas
 * fill styles: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() with commas or
 * spaces, and color(srgb r g b / a). Pure, so it runs without a DOM.
 *
 * @param {string} text
 * @returns {[number, number, number, number] | null} r, g, b in 0-255 and alpha in 0-1
 */
export function parseCssColor(text) {
  const value = String(text ?? '').trim().toLowerCase()
  let match = /^#([0-9a-f]{3,8})$/.exec(value)
  if (match) {
    let hex = match[1]
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map(c => c + c).join('')
    if (hex.length !== 6 && hex.length !== 8) return null
    const n = i => parseInt(hex.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), hex.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1]
  }
  match = /^rgba?\(([^)]*)\)$/.exec(value)
  if (match) {
    const parts = match[1].split(/\s*[,/]\s*|\s+/).filter(Boolean)
    if (parts.length < 3 || parts.slice(0, 3).some(p => Number.isNaN(parseFloat(p)))) return null
    return [...parts.slice(0, 3).map(p => clamp(channel(p), 0, 255)), clamp(alpha(parts[3]), 0, 1)]
  }
  match = /^color\(srgb\s+([^)]*)\)$/.exec(value)
  if (match) {
    const parts = match[1].split(/\s*\/\s*|\s+/).filter(Boolean)
    if (parts.length < 3 || parts.slice(0, 3).some(p => Number.isNaN(parseFloat(p)))) return null
    const unit = p => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p))
    return [...parts.slice(0, 3).map(p => clamp(unit(p) * 255, 0, 255)), clamp(alpha(parts[3]), 0, 1)]
  }
  return null
}

/** [r, g, b] (and optional alpha) -> a CSS colour a canvas accepts. */
export function rgbString([r, g, b], a = 1) {
  const [R, G, B] = [r, g, b].map(Math.round)
  return a >= 1 ? `rgb(${R}, ${G}, ${B})` : `rgba(${R}, ${G}, ${B}, ${Math.round(a * 1000) / 1000})`
}

/** [r, g, b] -> #rrggbb */
export function hexString([r, g, b]) {
  return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')
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

// Resolving: a custom property's computed value already has its var()
// references substituted. Plain colours are parsed directly; anything else
// (color-mix() and the like) goes through a short-lived probe element whose
// computed colour the browser works out, with a canvas as the last resort for
// forms parseCssColor does not know.
let canvasProbe = null

function hostFor(element) {
  // Canvases and images do not render children, so their colours are read from the page
  const usable = element && element.isConnected && element !== document.documentElement && !/^(CANVAS|IMG|svg)$/.test(element.tagName)
  return usable ? element : document.body || document.documentElement
}

function viaCanvas(value) {
  if (!canvasProbe) {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    canvasProbe = canvas.getContext('2d', { willReadFrequently: true })
  }
  if (!canvasProbe) return null
  canvasProbe.clearRect(0, 0, 1, 1)
  canvasProbe.fillStyle = '#000'
  canvasProbe.fillStyle = value
  canvasProbe.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = canvasProbe.getImageData(0, 0, 1, 1).data
  return [r, g, b, a / 255]
}

/**
 * Resolves a CSS colour, which may use var() and color-mix(), as seen from
 * `element` (the page by default).
 *
 * @returns {[number, number, number, number] | null}
 */
export function resolveColor(value, element) {
  const direct = parseCssColor(value)
  if (direct || typeof document === 'undefined' || !value) return direct
  // A new probe each time: a reused element can report a stale colour
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.color = value
  if (!probe.style.color) return null
  const host = hostFor(element)
  host.appendChild(probe)
  let computed
  try {
    computed = getComputedStyle(probe).color
  } finally {
    probe.remove()
  }
  return parseCssColor(computed) || viaCanvas(computed)
}

/** A custom property's colour as [r, g, b, a], or null when it is not set. */
export function cssColorAlpha(name, element) {
  if (typeof document === 'undefined') return null
  const raw = getComputedStyle(hostFor(element)).getPropertyValue(name).trim()
  return raw ? resolveColor(raw, element) : null
}

/** A custom property's colour as [r, g, b] (alpha dropped), or the fallback. */
export function cssColor(name, fallback = [128, 128, 128], element) {
  const color = cssColorAlpha(name, element)
  return color ? color.slice(0, 3) : fallback
}

/**
 * Canvas-ready colour strings for a map of { key: '--custom-property' },
 * keeping each colour's alpha. Unset properties fall back to grey.
 */
export function themeColors(element, names) {
  const out = {}
  for (const [key, name] of Object.entries(names)) {
    const color = cssColorAlpha(name, element)
    out[key] = color ? rgbString(color, color[3]) : 'rgb(128, 128, 128)'
  }
  return out
}

let lastClassColors = null

/** RGB triples for the hex view's byte classes, in BYTE_CLASSES order. Same array while the colours are unchanged. */
export function byteClassColors() {
  const next = BYTE_CLASSES.map(name => cssColor(`--hx-byte-${name}`, [128, 128, 128]))
  if (lastClassColors && String(lastClassColors) === String(next)) return lastClassColors
  lastClassColors = next
  return next
}

const listeners = new Set()
let observer = null
let media = null

function notify() {
  for (const listener of [...listeners]) listener()
}

/**
 * Calls `listener` after the theme changes: the root's data-theme attribute,
 * or the system colour scheme. Returns an unsubscribe function.
 */
export function onThemeChange(listener) {
  if (typeof document === 'undefined') return () => {}
  listeners.add(listener)
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(notify)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    media = window.matchMedia?.('(prefers-color-scheme: dark)') || null
    media?.addEventListener('change', notify)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size && observer) {
      observer.disconnect()
      observer = null
      media?.removeEventListener('change', notify)
      media = null
    }
  }
}

/** A number that changes whenever the theme does; use it as an effect dependency to redraw. */
export function useThemeVersion() {
  const [version, setVersion] = useState(0)
  useEffect(() => onThemeChange(() => setVersion(v => v + 1)), [])
  return version
}

/** The byte-class colours, updated when the theme changes. */
export function useByteClassColors() {
  const [colors, setColors] = useState(byteClassColors)
  useEffect(() => onThemeChange(() => setColors(byteClassColors())), [])
  return colors
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
