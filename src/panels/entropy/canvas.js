import { useLayoutEffect, useState } from 'react'

/**
 * CSS size and device pixel ratio of an element, kept up to date on
 * resizes and on zoom or moving to a screen with another pixel density.
 * @param {{ current: HTMLElement | null }} ref
 */
export function useBox(ref) {
  const [box, setBox] = useState({ width: 0, height: 0, dpr: 1 })

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    let media = null
    const measure = () => {
      const rect = element.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      setBox(previous => (
        previous.width === rect.width && previous.height === rect.height && previous.dpr === dpr
          ? previous
          : { width: rect.width, height: rect.height, dpr }
      ))
    }
    const watchDpr = () => {
      media?.removeEventListener('change', onDpr)
      media = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) || null
      media?.addEventListener('change', onDpr)
    }
    function onDpr() {
      measure()
      watchDpr()
    }
    measure()
    watchDpr()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => {
      observer?.disconnect()
      media?.removeEventListener('change', onDpr)
    }
  }, [ref])

  return box
}

/** Sizes the canvas backing store for the box and returns a context in CSS pixels. */
export function prepareCanvas(canvas, box) {
  const width = Math.max(1, Math.round(box.width * box.dpr))
  const height = Math.max(1, Math.round(box.height * box.dpr))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(box.dpr, 0, 0, box.dpr, 0, 0)
  ctx.clearRect(0, 0, box.width, box.height)
  return ctx
}

export const hexOffset = (n) => '0x' + Math.max(0, Math.floor(n)).toString(16).toUpperCase()
