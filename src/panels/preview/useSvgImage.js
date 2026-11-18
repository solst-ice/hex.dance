import { useEffect, useRef, useState } from 'react'
import { decodeSvgText, svgSize } from './svg.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const NOTHING = { image: null, size: null, error: false, version: null }

// Reads the outermost <svg> and gives it the size it would be shown at, in
// pixels, and a viewBox, so every browser can draw it onto a canvas at any
// scale. Parsing with DOMParser runs nothing and loads nothing. Returns null
// when the bytes are not an SVG document a browser could show.
function prepareSvg(bytes) {
  const doc = new DOMParser().parseFromString(decodeSvgText(bytes), 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.namespaceURI !== SVG_NS || root.localName !== 'svg') return null
  if (doc.getElementsByTagNameNS('*', 'parsererror').length) return null
  const size = svgSize({
    width: root.getAttribute('width'),
    height: root.getAttribute('height'),
    viewBox: root.getAttribute('viewBox')
  })
  root.setAttribute('width', String(size.width))
  root.setAttribute('height', String(size.height))
  root.setAttribute('viewBox', size.viewBox)
  return { text: new XMLSerializer().serializeToString(root), size }
}

/**
 * The SVG in `bytes` decoded as an image, ready to draw onto a canvas,
 * rebuilt (debounced) whenever `version` changes. The image is loaded from a
 * blob: address that is revoked the moment it has loaded or failed, so the
 * page never holds an address that would open the SVG as a document.
 *
 * @returns {{ image: HTMLImageElement|null, size: ReturnType<typeof svgSize>|null, error: boolean, version: * }}
 */
export default function useSvgImage(bytes, version, delayMs) {
  const [state, setState] = useState({ ...NOTHING, bytes: null })
  const shown = useRef(null)

  useEffect(() => {
    if (!bytes) return
    let url = null
    let image = null
    const revoke = () => {
      if (url) URL.revokeObjectURL(url)
      url = null
    }
    const settle = (next) => {
      revoke()
      shown.current = bytes
      setState({ ...next, version, bytes })
    }
    const build = () => {
      let prepared = null
      try {
        prepared = prepareSvg(bytes)
      } catch {
        prepared = null
      }
      if (!prepared) return settle({ image: null, size: null, error: true })
      image = new Image()
      image.decoding = 'async'
      image.onload = () => settle({ image, size: prepared.size, error: false })
      image.onerror = () => settle({ image: null, size: null, error: true })
      url = URL.createObjectURL(new Blob([prepared.text], { type: 'image/svg+xml' }))
      image.src = url
    }
    // The first image for these bytes is made at once; edits are debounced
    const timer = setTimeout(build, shown.current === bytes ? delayMs : 0)
    return () => {
      clearTimeout(timer)
      if (image) image.onload = image.onerror = null
      revoke()
    }
  }, [bytes, version, delayMs])

  return state.bytes === bytes && bytes ? state : NOTHING
}
