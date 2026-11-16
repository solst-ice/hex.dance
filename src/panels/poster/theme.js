// Reads the current theme's colours from CSS variables and resolves them to
// literal #rrggbb values, so an exported poster carries no var() references.

import { cssColorAlpha, hexString } from '../../lib/canvasColors.js'
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
  const resolve = name => {
    const color = cssColorAlpha(name)
    return color && color[3] >= 0.5 ? hexString(color) : null
  }
  try {
    const theme = { bytes: {}, kinds: {} }
    for (const [key, name] of Object.entries(VARS)) theme[key] = resolve(name)
    for (const cls of BYTE_CLASSES) theme.bytes[cls] = resolve(`--hx-byte-${cls}`)
    for (const kind of KINDS) theme.kinds[kind] = resolve(`--sx-field-${kind}`)
    return theme
  } catch {
    return null
  }
}
