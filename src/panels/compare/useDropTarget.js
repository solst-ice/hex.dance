import { useCallback, useRef, useState } from 'react'

const carriesFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files')

// The window-level drop handler opens a dropped file as the main file and
// shows its overlay while a file is dragged. A drop handled here must not
// reach it, but stopping the drop also stops it from clearing its dragging
// state, so it is handed a drop that carries no file.
function releaseWindowDrag() {
  const event = new Event('drop')
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [], dropEffect: 'none' } })
  window.dispatchEvent(event)
}

/**
 * Makes an element accept a dropped file without the window treating the
 * drop as "open this file".
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
      event.stopPropagation()
      depth.current = 0
      setRect(null)
      const file = event.dataTransfer.files[0]
      releaseWindowDrag()
      if (file) onFile(file)
    }
  }

  return { ref, dragging: rect !== null, rect, handlers }
}
