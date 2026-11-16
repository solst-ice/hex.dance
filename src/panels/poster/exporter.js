// Saving a poster: SVG as is, PNG by drawing the SVG onto a canvas at 2x.
// Everything stays in the page (blob: and data: URLs only).

export const PNG_SCALE = 2
// Canvas size limits vary by browser; stay well inside them
const MAX_PIXELS = 60_000_000
const MAX_SIDE = 16000

export function svgBlob(svg) {
  return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** The pixel size a PNG export will have. */
export function pngSize(width, height) {
  let scale = PNG_SCALE
  while (scale > 0.25 && (width * scale * height * scale > MAX_PIXELS || Math.max(width, height) * scale > MAX_SIDE)) scale /= 1.25
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The poster image could not be decoded'))
    image.src = src
  })
}

/**
 * @param {string} svg
 * @param {number} width   SVG width in user units
 * @param {number} height
 * @param {string} background   painted first, so the PNG is never transparent
 * @returns {Promise<Blob>}
 */
export async function svgToPng(svg, width, height, background) {
  const size = pngSize(width, height)
  // A data: URL keeps the canvas untainted in every engine that allows it
  const image = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg))
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, size.width, size.height)
  ctx.drawImage(image, 0, 0, size.width, size.height)
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png')
  })
}

export function canCopyImage() {
  return typeof window !== 'undefined' && typeof window.ClipboardItem === 'function' && Boolean(navigator.clipboard?.write) && window.isSecureContext
}

/** Copies a PNG; takes a promise so Safari keeps the user gesture while it renders. */
export async function copyPng(pngPromise) {
  await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': pngPromise })])
}
