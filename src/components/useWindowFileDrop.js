import { useEffect, useRef, useState } from 'react'

const carriesFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files')

/**
 * Accepts a file dropped anywhere on the window. A drop that a target on the
 * page already handled (it called preventDefault) is left to that target,
 * though the drag still ends here. Returns whether a file is currently being
 * dragged over the window.
 * @param {(file: File) => void} onFile
 */
export default function useWindowFileDrop(onFile) {
  const [isDragging, setIsDragging] = useState(false)
  const onFileRef = useRef(onFile)

  useEffect(() => {
    onFileRef.current = onFile
  }, [onFile])

  useEffect(() => {
    // dragenter/dragleave fire for every element crossed, so count them
    let depth = 0

    const handleEnter = (event) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      depth++
      setIsDragging(true)
    }
    const handleOver = (event) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const handleLeave = (event) => {
      if (!carriesFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setIsDragging(false)
    }
    const handleDrop = (event) => {
      if (!carriesFiles(event)) return
      depth = 0
      setIsDragging(false)
      if (event.defaultPrevented) return
      event.preventDefault()
      const file = event.dataTransfer.files[0]
      if (file) onFileRef.current(file)
    }

    window.addEventListener('dragenter', handleEnter)
    window.addEventListener('dragover', handleOver)
    window.addEventListener('dragleave', handleLeave)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragenter', handleEnter)
      window.removeEventListener('dragover', handleOver)
      window.removeEventListener('dragleave', handleLeave)
      window.removeEventListener('drop', handleDrop)
    }
  }, [])

  return isDragging
}
