// Reads the current theme's colours from CSS variables and resolves them to
// literal #rrggbb values, so an exported poster carries no var() references.

import { KINDS, BYTE_CLASSES } from './palette.js'

const VARS = {
  background: '--darker-bg',
  panel: '--dark-bg',
  text: '--text',
  muted: '--text-muted',
  accent: '--neon-blue',
  accent2: '--neon-pink',
  accent3: '--neon-yellow'
}

/** @returns {import('./palette.js').PosterThemeInput|null} */
export function readTheme() {
  if (typeof document === 'undefined' || !document.body) return null
  const root = getComputedStyle(document.documentElement)
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const resolve = name => {
    const raw = root.getPropertyValue(name).trim()
    if (!raw || !ctx) return null
    probe.style.color = ''
    probe.style.color = raw
    if (!probe.style.color) return null
    const computed = getComputedStyle(probe).color
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = computed
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    if (a < 128) return null
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
  }

  try {
    const theme = { bytes: {}, kinds: {} }
    for (const [key, name] of Object.entries(VARS)) theme[key] = resolve(name)
    for (const cls of BYTE_CLASSES) theme.bytes[cls] = resolve(`--hx-byte-${cls}`)
    for (const kind of KINDS) theme.kinds[kind] = resolve(`--sx-field-${kind}`)
    return theme
  } catch {
    return null
  } finally {
    probe.remove()
  }
}
