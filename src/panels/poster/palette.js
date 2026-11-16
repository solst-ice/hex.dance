// Poster colours. A field's hue comes from its kind, so every poster uses the
// same colour for, say, sizes; neighbouring fields of the same kind get
// different shades of that hue so their boxes stay distinguishable.

export const KINDS = ['magic', 'header', 'size', 'count', 'offset', 'flags', 'string', 'checksum', 'data', 'padding', 'other']

export const KIND_LABELS = {
  magic: 'Magic',
  header: 'Header',
  size: 'Size',
  count: 'Count',
  offset: 'Offset',
  flags: 'Flags',
  string: 'Text',
  checksum: 'Checksum',
  data: 'Data',
  padding: 'Padding',
  other: 'Other'
}

export const DEFAULT_KIND_COLORS = {
  magic: '#ff36ab',
  header: '#00d7ff',
  size: '#f7f71c',
  count: '#ffb000',
  offset: '#ff8f40',
  flags: '#c38dff',
  string: '#4dff88',
  checksum: '#ff5c5c',
  data: '#5f87ff',
  padding: '#7d8aa8',
  other: '#2ec4b6'
}

// Region kinds borrow the field palette
const REGION_TO_KIND = {
  header: 'header',
  code: 'checksum',
  data: 'data',
  table: 'count',
  metadata: 'flags',
  padding: 'padding',
  other: 'other'
}

export function kindOf(kind) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_KIND_COLORS, kind) ? kind : 'other'
}

export function regionKindOf(kind) {
  return REGION_TO_KIND[kind] || 'other'
}

/** @returns {{ r: number, g: number, b: number, a: number } | null} */
export function parseColor(text) {
  const value = String(text || '').trim().toLowerCase()
  let m = /^#([0-9a-f]{3,8})$/.exec(value)
  if (m) {
    let hex = m[1]
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map(c => c + c).join('')
    if (hex.length !== 6 && hex.length !== 8) return null
    const n = parseInt(hex.slice(0, 6), 16)
    const a = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a }
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value)
  if (m) {
    let a = m[4] === undefined ? 1 : parseFloat(m[4])
    if (m[4] && m[4].endsWith('%')) a /= 100
    const clamp = v => Math.max(0, Math.min(255, Math.round(parseFloat(v))))
    return { r: clamp(m[1]), g: clamp(m[2]), b: clamp(m[3]), a: Math.max(0, Math.min(1, a)) }
  }
  return null
}

export function toHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}

function toHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return { h: h / 6, s, l }
}

function fromHsl({ h, s, l }) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const hue = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return { r: hue(p, q, h + 1 / 3) * 255, g: hue(p, q, h) * 255, b: hue(p, q, h - 1 / 3) * 255 }
}

/** Relative luminance (0 black … 1 white). */
export function luminance(color) {
  const c = typeof color === 'string' ? parseColor(color) : color
  if (!c) return 0
  const lin = v => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** Mixes `a` into `b`: amount 1 gives `a`, 0 gives `b`. Returns #rrggbb. */
export function mix(a, b, amount) {
  const ca = parseColor(a) || { r: 0, g: 0, b: 0 }
  const cb = parseColor(b) || { r: 0, g: 0, b: 0 }
  return toHex({
    r: ca.r * amount + cb.r * (1 - amount),
    g: ca.g * amount + cb.g * (1 - amount),
    b: ca.b * amount + cb.b * (1 - amount)
  })
}

/** Moves a colour's lightness to `l` (0–1), keeping hue and saturation. */
export function withLightness(color, l, saturation) {
  const c = parseColor(color)
  if (!c) return color
  const hsl = toHsl(c)
  return toHex(fromHsl({ h: hsl.h, s: saturation === undefined ? hsl.s : saturation, l }))
}

/**
 * Three shades per kind. Dark posters use bright shades on a dark page;
 * print posters use darker, ink-friendly shades on white.
 * @param {Record<string, string>} kindColors
 * @param {'dark'|'print'} style
 */
export function kindShades(kindColors, style) {
  const shades = {}
  for (const kind of KINDS) {
    const base = kindColors[kind] || DEFAULT_KIND_COLORS[kind]
    const parsed = parseColor(base) || parseColor(DEFAULT_KIND_COLORS[kind])
    const hsl = toHsl(parsed)
    const s = Math.min(1, Math.max(hsl.s, kind === 'padding' ? 0.12 : 0.55))
    if (style === 'print') {
      shades[kind] = [0.36, 0.27, 0.45].map(l => toHex(fromHsl({ h: hsl.h, s: Math.min(1, s * 0.95), l })))
    } else {
      const l = Math.min(0.68, Math.max(0.5, hsl.l))
      shades[kind] = [toHex(parsed), toHex(fromHsl({ h: hsl.h, s, l: Math.min(0.85, l + 0.17) })), toHex(fromHsl({ h: hsl.h, s, l: Math.max(0.38, l - 0.14) }))]
    }
  }
  return shades
}

/**
 * Picks a shade index per item so that consecutive items of the same kind
 * never share a shade.
 * @param {Array<{ kind: string }>} items  in display order
 * @returns {number[]}
 */
export function assignShades(items) {
  const counters = {}
  let previous = null
  return items.map(item => {
    const kind = kindOf(item.kind)
    let index = counters[kind] || 0
    if (previous && previous.kind === kind && previous.index === index % 3) index++
    counters[kind] = index + 1
    previous = { kind, index: index % 3 }
    return index % 3
  })
}

export const BYTE_CLASSES = ['zero', 'print', 'ctrl', 'ff', 'high']

export const BYTE_CLASS_LABELS = {
  zero: '00',
  print: 'text',
  ctrl: 'control',
  ff: 'FF',
  high: 'other'
}

export function byteClass(v) {
  if (v === 0) return 'zero'
  if (v > 0x20 && v < 0x7f) return 'print'
  if (v < 0x80) return 'ctrl'
  if (v === 0xff) return 'ff'
  return 'high'
}

/**
 * Literal colours for a poster style. `theme` holds colours read from the
 * app's CSS variables (already resolved to #rrggbb); anything missing falls
 * back to the default neon look.
 * @param {'dark'|'print'} style
 * @param {Partial<PosterThemeInput>} [theme]
 * @returns {PosterColors}
 *
 * @typedef {Object} PosterThemeInput
 * @property {string} background
 * @property {string} panel
 * @property {string} text
 * @property {string} muted
 * @property {string} accent
 * @property {string} accent2
 * @property {string} accent3
 * @property {Record<string, string>} bytes   per byte class
 * @property {Record<string, string>} kinds   per field kind
 *
 * @typedef {Object} PosterColors
 * @property {'dark'|'print'} style
 * @property {string} background
 * @property {string} panel
 * @property {string} rule
 * @property {string} text
 * @property {string} muted
 * @property {string} faint
 * @property {string} accent
 * @property {string} accent2
 * @property {string} accent3
 * @property {string} tabText
 * @property {number} fillOpacity
 * @property {number} textFillOpacity
 * @property {Record<string, string>} bytes
 * @property {Record<string, string[]>} shades
 */
export function posterColors(style, theme = {}) {
  theme = theme || {}
  const pick = (value, fallback) => (parseColor(value) ? toHex(parseColor(value)) : fallback)
  const kinds = { ...DEFAULT_KIND_COLORS }
  for (const kind of KINDS) if (theme.kinds && parseColor(theme.kinds[kind])) kinds[kind] = theme.kinds[kind]

  if (style === 'print') {
    const accent = withLightness(pick(theme.accent, '#00ffff'), 0.3, 0.85)
    const accent2 = withLightness(pick(theme.accent2, '#ff36ab'), 0.4, 0.8)
    return {
      style: 'print',
      background: '#ffffff',
      panel: '#f4f5f8',
      rule: '#c9ccd6',
      text: '#16181f',
      muted: '#555b6b',
      faint: '#8a8f9e',
      accent,
      accent2,
      accent3: '#8a6d00',
      tabText: '#ffffff',
      fillOpacity: 0.14,
      textFillOpacity: 0.1,
      bytes: { zero: '#a2a7b5', print: '#16181f', ctrl: '#1f6f8b', ff: '#b5530f', high: '#6b4fa0' },
      shades: kindShades(kinds, 'print')
    }
  }

  const background = pick(theme.background, '#060714')
  const text = pick(theme.text, '#e6e9f2')
  const accent = pick(theme.accent, '#00ffff')
  const bytes = {
    zero: pick(theme.bytes?.zero, '#3d4560'),
    print: pick(theme.bytes?.print, '#f7f71c'),
    ctrl: pick(theme.bytes?.ctrl, '#5fd7ff'),
    ff: pick(theme.bytes?.ff, '#ff8f40'),
    high: pick(theme.bytes?.high, '#c38dff')
  }
  return {
    style: 'dark',
    background,
    panel: pick(theme.panel, mix(accent, background, 0.05)),
    rule: mix(accent, background, 0.28),
    text,
    muted: pick(theme.muted, mix(text, background, 0.65)),
    faint: mix(text, background, 0.4),
    accent,
    accent2: pick(theme.accent2, '#ff36ab'),
    accent3: pick(theme.accent3, '#f7f71c'),
    tabText: background,
    fillOpacity: 0.2,
    textFillOpacity: 0.16,
    bytes,
    shades: kindShades(kinds, 'dark')
  }
}
