import { useContext, useEffect } from 'react'
import { FileContext, SelectionContext, WorkspaceContext } from './contexts.js'

/**
 * @typedef {'idle' | 'reading' | 'analyzing' | 'ready' | 'error'} FileStatus
 *
 * @typedef {Object} FileState
 * @property {File|null} file
 * @property {ArrayBuffer|null} buffer        the file's bytes, read on the main thread
 * @property {Uint8Array|null} bytes          view over `buffer`
 * @property {FileStatus} status
 * @property {import('../analysis/types.js').Analysis|null} analysis
 * @property {Error|null} error
 * @property {(file: File) => void} openFile
 * @property {() => void} closeFile
 * @property {number} revision                bumps when bytes are edited in place
 * @property {() => void} notifyEdit
 */

/**
 * @typedef {{ start: number, end: number }} ByteRange   `end` is exclusive
 * @typedef {{ id: string, start: number, end: number, label?: string, color?: string }} Highlight
 *
 * @typedef {Object} SelectionState
 * @property {ByteRange|null} selection
 * @property {(selection: ByteRange|null | ((previous: ByteRange|null) => ByteRange|null)) => void} setSelection
 * @property {Highlight[]} highlights
 * @property {(highlights: Highlight[] | ((previous: Highlight[]) => Highlight[])) => void} setHighlights
 * @property {(offset: number, length?: number) => void} jumpTo   select the range and scroll the hex view to it
 * @property {{ current: { scrollToOffset?: (offset: number) => void } | null }} hexApiRef   passed to the hex view as `apiRef`
 */

/** @returns {FileState} */
export function useFile() {
  const value = useContext(FileContext)
  if (!value) throw new Error('useFile must be used inside <FileProvider>')
  return value
}

/** @returns {SelectionState} */
export function useSelection() {
  const value = useContext(SelectionContext)
  if (!value) throw new Error('useSelection must be used inside <SelectionProvider>')
  return value
}

/**
 * @typedef {Object} WorkspaceState
 * @property {string|null} activePanelId   id of the tab panel last chosen by the user or by `openPanel`;
 *   null, or an id that is not available for the current file, shows the first tab
 * @property {(id: string) => void} openPanel   switch the tab strip to a panel
 */

/** @returns {WorkspaceState} */
export function useWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspace must be used inside <WorkspaceProvider>')
  return value
}

/**
 * Owns one named layer of hex-view highlights. Each caller manages only its
 * own layer, so several panels can tint the hex view without overwriting one
 * another. The layer is removed when the caller unmounts.
 *
 * @param {string} layer   unique name, normally the panel id
 * @param {Array<{ start: number, end: number, id?: string|number, label?: string, color?: string }>|null} ranges
 *   memoise this array: a new identity replaces the layer
 */
export function useHighlightLayer(layer, ranges) {
  const { setHighlights } = useSelection()

  useEffect(() => {
    const prefix = `${layer}:`
    const isOther = (highlight) => !String(highlight.id).startsWith(prefix)
    const mine = (ranges || []).map((range, index) => ({ ...range, id: `${prefix}${range.id ?? index}` }))

    setHighlights(previous => {
      const others = previous.filter(isOther)
      return mine.length === 0 && others.length === previous.length ? previous : [...others, ...mine]
    })
    return () => setHighlights(previous => {
      const others = previous.filter(isOther)
      return others.length === previous.length ? previous : others
    })
  }, [layer, ranges, setHighlights])
}
