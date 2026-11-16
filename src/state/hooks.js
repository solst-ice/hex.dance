import { useContext } from 'react'
import { FileContext, SelectionContext } from './contexts.js'

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
