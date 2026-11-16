import { useEffect } from 'react'
import { prefersReducedMotion } from './useReducedMotion'

const frame = (color, x, y, extra = '') => `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
<rect width="32" height="32" fill="#060714"/>
<text x="${x}" y="${y}" style="font: bold 20px 'Courier New', monospace; fill: ${color};${extra}">0x</text>
</svg>`

const FRAMES = [
  frame('#ff36ab', 6, 21),
  frame('#0ff', 2, 23),
  frame('#ff36ab', 4, 22, ' transform: skewX(10deg);')
].map(svg => `data:image/svg+xml,${encodeURIComponent(svg)}`)

const FRAME_MS = 110
// Seconds between glitches
const MIN_GAP = 25
const MAX_GAP = 60

/**
 * Glitches the tab icon for a moment, rarely, and only while the tab is
 * visible. Does nothing when reduced motion is requested.
 */
function GlitchFavicon() {
  useEffect(() => {
    const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]')
    if (!link) return
    const original = link.getAttribute('href')
    const timers = new Set()
    const later = (fn, ms) => {
      const id = setTimeout(() => {
        timers.delete(id)
        fn()
      }, ms)
      timers.add(id)
    }
    const clearAll = () => {
      timers.forEach(clearTimeout)
      timers.clear()
      link.setAttribute('href', original)
    }

    const schedule = () => {
      later(() => {
        if (document.hidden || prefersReducedMotion()) return schedule()
        FRAMES.forEach((href, index) => later(() => link.setAttribute('href', href), index * FRAME_MS))
        later(() => {
          link.setAttribute('href', original)
          schedule()
        }, FRAMES.length * FRAME_MS)
      }, (MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP)) * 1000)
    }

    const handleVisibility = () => {
      clearAll()
      if (!document.hidden) schedule()
    }

    if (!document.hidden) schedule()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      clearAll()
    }
  }, [])

  return null
}

export default GlitchFavicon
