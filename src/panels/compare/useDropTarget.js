import { useCallback, useRef, useState } from 'react'

const carriesFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files')

/**
 * Makes an element accept a dropped file without the window treating the
 * drop as "open this file": the window's handler (useWindowFileDrop) leaves
 * a drop alone once it has been handled here (preventDefault), and still
 * ends its own drag.
 * @param {(file: File) => void} onFile
 * @returns {{ dragging: boolean, rect: DOMRect|null, handlers: Object, ref: import('react').RefObject<HTMLElement> }}
 */
export function useDropTarget(onFile) {
  const ref = useRef(null)
  const depth = useRef(0)
  const [rect, setRect] = useState(null)

  const measure = useCallback(() => {
    const element = ref.current
    if (!element) return
    const next = element.getBoundingClientRect()
    setRect(previous => (previous && previous.top === next.top && previous.left === next.left &&
      previous.width === next.width && previous.height === next.height ? previous : next))
  }, [])

  const handlers = {
    onDragEnter(event) {
      if (!carriesFiles(event)) return
      event.preventDefault()
      depth.current++
      measure()
    },
    onDragOver(event) {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      measure()
    },
    onDragLeave(event) {
      if (!carriesFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setRect(null)
    },
    onDrop(event) {
      if (!carriesFiles(event)) return
      event.preventDefault()
      depth.current = 0
      setRect(null)
      const file = event.dataTransfer.files[0]
      if (file) onFile(file)
    }
  }

  return { ref, dragging: rect !== null, rect, handlers }
}
