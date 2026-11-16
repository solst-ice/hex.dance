/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useMemo, useRef, useState } from 'react'
import { SelectionContext } from './contexts.js'
import { useFile } from './hooks.js'

const NO_HIGHLIGHTS = []

export default function SelectionProvider({ children }) {
  const { file } = useFile()
  const [state, setState] = useState({ file, selection: null, highlights: NO_HIGHLIGHTS })
  const hexApiRef = useRef(null)

  // A new file starts with nothing selected or highlighted
  if (state.file !== file) setState({ file, selection: null, highlights: NO_HIGHLIGHTS })
  const current = state.file === file ? state : { selection: null, highlights: NO_HIGHLIGHTS }

  const setSelection = useCallback((next) => {
    setState(previous => {
      const selection = typeof next === 'function' ? next(previous.selection) : next
      return selection === previous.selection ? previous : { ...previous, selection: selection || null }
    })
  }, [])

  const setHighlights = useCallback((next) => {
    setState(previous => {
      const highlights = typeof next === 'function' ? next(previous.highlights) : next
      return highlights === previous.highlights ? previous : { ...previous, highlights: highlights || NO_HIGHLIGHTS }
    })
  }, [])

  const jumpTo = useCallback((offset, length = 1) => {
    if (!Number.isFinite(offset) || offset < 0) return
    setSelection({ start: offset, end: offset + Math.max(1, length) })
    hexApiRef.current?.scrollToOffset?.(offset)
  }, [setSelection])

  const value = useMemo(() => ({
    selection: current.selection,
    setSelection,
    highlights: current.highlights,
    setHighlights,
    jumpTo,
    hexApiRef
  }), [current.selection, current.highlights, setSelection, setHighlights, jumpTo])

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}
