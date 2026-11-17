/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useMemo, useRef, useState } from 'react'
import { HexViewContext, SelectionActionsContext, SelectionContext } from './contexts.js'
import { createHexViewStore } from './hexViewStore.js'
import { useFile } from './hooks.js'

const NO_HIGHLIGHTS = []

export default function SelectionProvider({ children }) {
  const { file } = useFile()
  const [state, setState] = useState({ file, selection: null, highlights: NO_HIGHLIGHTS })
  const hexApiRef = useRef(null)
  const [hexView] = useState(createHexViewStore)
  const [jumpListeners] = useState(() => new Set())

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
    jumpListeners.forEach(listener => listener(offset))
  }, [setSelection, jumpListeners])

  // Lets the layout notice a jump, e.g. to offer a way to the hex view
  const subscribeJumps = useCallback((listener) => {
    jumpListeners.add(listener)
    return () => jumpListeners.delete(listener)
  }, [jumpListeners])

  const actions = useMemo(
    () => ({ setSelection, setHighlights, jumpTo, hexApiRef, subscribeJumps }),
    [setSelection, setHighlights, jumpTo, subscribeJumps]
  )

  const value = useMemo(() => ({
    selection: current.selection,
    setSelection,
    highlights: current.highlights,
    setHighlights,
    jumpTo,
    hexApiRef
  }), [current.selection, current.highlights, setSelection, setHighlights, jumpTo])

  return (
    <SelectionActionsContext.Provider value={actions}>
      <SelectionContext.Provider value={value}>
        <HexViewContext.Provider value={hexView}>{children}</HexViewContext.Provider>
      </SelectionContext.Provider>
    </SelectionActionsContext.Provider>
  )
}
