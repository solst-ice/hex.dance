import { useEffect, useState } from 'react'

function read(element) {
  if (!element) return null
  const top = Number(element.dataset.topRow)
  const perRow = Number(element.dataset.bytesPerRow)
  const rows = Number(element.dataset.visibleRows) || 1
  if (!Number.isFinite(top) || !Number.isFinite(perRow) || perRow <= 0) return null
  return { start: top * perRow, end: (top + rows) * perRow }
}

/**
 * The byte range the hex view currently shows, read from the data
 * attributes on `section.hexview`. Null while there is no hex view.
 */
export function useHexViewport() {
  const [range, setRange] = useState(null)

  useEffect(() => {
    let element = null
    let observer = null
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const next = read(element)
        setRange(previous => (
          previous && next && previous.start === next.start && previous.end === next.end ? previous : next
        ))
      })
    }
    const bind = () => {
      if (element && element.isConnected) return
      observer?.disconnect()
      element = document.querySelector('section.hexview')
      observer = null
      if (element && typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(update)
        observer.observe(element, { attributes: true, attributeFilter: ['data-top-row', 'data-bytes-per-row', 'data-visible-rows'] })
      }
      update()
    }
    bind()
    // The hex view is replaced when another file opens
    const timer = setInterval(bind, 1000)
    return () => {
      clearInterval(timer)
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [])

  return range
}
