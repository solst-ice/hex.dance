// The parts of showing an SVG that need no browser: reading its text, working
// out the size it asks for, and the canvas size to draw it at. The SVG is
// never given to the browser as an address of its own (see passive.js); it is
// decoded as an image and drawn onto a canvas (see useSvgImage.js).

// CSS pixels per unit, as the browser resolves them on the outermost <svg>
const UNITS = { '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8 }
const LENGTH = /^\+?(\d*\.?\d+(?:e[+-]?\d+)?)(px|pt|pc|mm|cm|in|em|ex)?$/i

// The size a browser gives an image that does not say how big it is
const DEFAULT_WIDTH = 300
const DEFAULT_HEIGHT = 150

// Plenty for a sharp picture on any screen, and far inside what browsers allow a canvas
export const MAX_PIXELS = 16 * 1024 * 1024
export const MAX_SIDE = 8192
// A drawing taller than this is shown smaller rather than as a strip too long to
// scroll through, which also keeps it sharp inside the pixel limits
export const MAX_CSS_HEIGHT = 4096

/** A length on the outermost <svg> in CSS pixels, or null (missing, a percentage, auto, zero). */
export function parseLength(value) {
  if (typeof value !== 'string') return null
  const match = LENGTH.exec(value.trim())
  if (!match) return null
  const px = Number(match[1]) * UNITS[(match[2] || '').toLowerCase()]
  return Number.isFinite(px) && px > 0 ? px : null
}

/** `viewBox` as { x, y, width, height }, or null when it is missing or unusable. */
export function parseViewBox(value) {
  if (typeof value !== 'string') return null
  const parts = value.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null
  const [x, y, width, height] = parts
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/**
 * The size an SVG is shown at, from the `width`, `height` and `viewBox`
 * attributes of its outermost element, as an <img> would size it.
 * `intrinsic` is false when the size comes only from the viewBox or the
 * browser's default. `fill` is true when only the viewBox is known: an <img>
 * then fills the width it is given, at the viewBox's aspect ratio.
 * `viewBox` is the one to draw with: the SVG's own, or one that keeps its
 * user units when it has none.
 *
 * @returns {{ width: number, height: number, intrinsic: boolean, fill: boolean, viewBox: string }}
 */
export function svgSize({ width, height, viewBox }) {
  const w = parseLength(width)
  const h = parseLength(height)
  const box = parseViewBox(viewBox)
  const ratio = box ? box.width / box.height : null
  let size
  if (w && h) size = { width: w, height: h, intrinsic: true }
  else if (w && ratio) size = { width: w, height: w / ratio, intrinsic: true }
  else if (h && ratio) size = { width: h * ratio, height: h, intrinsic: true }
  else if (box) size = { width: box.width, height: box.height, intrinsic: false }
  else size = { width: w || DEFAULT_WIDTH, height: h || DEFAULT_HEIGHT, intrinsic: Boolean(w || h) }
  return {
    ...size,
    fill: !size.intrinsic && Boolean(box),
    viewBox: box ? `${box.x} ${box.y} ${box.width} ${box.height}` : `0 0 ${size.width} ${size.height}`
  }
}

/**
 * Canvas size for an image of `size` shown no wider than `maxWidth` CSS
 * pixels (never enlarged, like an <img> with max-width: 100%, unless
 * `size.fill` asks for the whole width) and no taller
 * than MAX_CSS_HEIGHT, keeping its aspect ratio, drawn at the
 * screen's pixel density so it stays sharp, with at most MAX_PIXELS pixels
 * and MAX_SIDE on a side.
 *
 * @returns {{ cssWidth: number, cssHeight: number, pixelWidth: number, pixelHeight: number }}
 */
export function fitCanvas(size, maxWidth, dpr = 1) {
  const ratio = size.height / size.width
  const wanted = size.fill && maxWidth > 0 ? maxWidth : size.width
  const widest = Math.min(maxWidth > 0 ? Math.min(wanted, maxWidth) : wanted, MAX_CSS_HEIGHT / ratio)
  const cssWidth = Math.max(1, widest)
  const cssHeight = Math.max(1, cssWidth * ratio)
  const density = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  let pixelWidth = cssWidth * density
  let pixelHeight = cssHeight * density
  const shrink = Math.min(1, Math.sqrt(MAX_PIXELS / (pixelWidth * pixelHeight)), MAX_SIDE / pixelWidth, MAX_SIDE / pixelHeight)
  pixelWidth = Math.max(1, Math.round(pixelWidth * shrink))
  pixelHeight = Math.max(1, Math.round(pixelHeight * shrink))
  return { cssWidth, cssHeight, pixelWidth, pixelHeight }
}

const ascii = (bytes, length) => String.fromCharCode(...bytes.subarray(0, Math.min(length, bytes.length)))

/** The SVG's text: by its byte order mark, else the encoding its XML declaration names, else UTF-8. */
export function decodeSvgText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  const declared = /^(?:\xEF\xBB\xBF)?<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(ascii(bytes, 200))
  if (declared) {
    try {
      return new TextDecoder(declared[1]).decode(bytes)
    } catch {
      // Not a label the browser knows: read it as UTF-8 like everything else
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}

export function describeSvgSize(size) {
  const round = n => Math.round(n * 100) / 100
  return size.intrinsic
    ? `${round(size.width)} × ${round(size.height)} px`
    : size.fill
      ? `no intrinsic size, viewBox ${round(size.width)} × ${round(size.height)}`
      : `no intrinsic size, drawn at ${round(size.width)} × ${round(size.height)}`
}
