import { useContext, useEffect, useSyncExternalStore } from 'react'
import {
  FileContext, HexViewContext, SectionContext, SelectionActionsContext, SelectionContext, UnsavedEditsContext,
  WorkspaceContext
} from './contexts.js'

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
 * @property {(file: File, options?: { onOpen?: () => void }) => void} openFile   open another file; with
 *   unsaved edits it first asks the reader (see UnsavedEdits.jsx), and a later call replaces a waiting one.
 *   `onOpen` runs just before the file is actually opened, and never if the reader keeps editing.
 * @property {() => void} closeFile           does not ask about unsaved edits; nothing calls it today
 * @property {number} revision                bumps when bytes are edited in place
 * @property {(edit?: { modifiedCount?: number }) => void} notifyEdit   for the hex view's `onEdit`:
 *   the bytes changed; `modifiedCount` is how many now differ from the file as opened
 * @property {() => void} notifySaved         for the hex view's `onDownload`: the current bytes were downloaded
 */

/**
 * @typedef {Object} UnsavedEdits
 * @property {string|null} fileName           name of the open file
 * @property {import('./unsavedEdits.js').OpenRequest|null} pending   the request to open a file
 *   that waits for an answer
 * @property {(answer: 'keep' | 'discard' | 'download') => void} answerOpen   answer it: keep editing,
 *   open it and lose the edits, or download the edited bytes and then open it
 * @property {() => boolean} isUnsaved        whether the bytes hold edits that were not downloaded
 * @property {() => number} getModifiedCount  bytes that differ from the file as opened
 * @property {(listener: () => void) => () => void} subscribe   hears when `isUnsaved()` flips
 */

/**
 * @typedef {{ start: number, end: number }} ByteRange   `end` is exclusive
 * @typedef {{ id: string, start: number, end: number, label?: string, color?: string, section?: string|null }} Highlight
 *   `section`: the section that set it (see useHighlightLayer); null or absent for the hex view and docks
 *
 * @typedef {Object} SelectionState
 * @property {ByteRange|null} selection
 * @property {(selection: ByteRange|null | ((previous: ByteRange|null) => ByteRange|null)) => void} setSelection
 * @property {Highlight[]} highlights
 * @property {(highlights: Highlight[] | ((previous: Highlight[]) => Highlight[])) => void} setHighlights
 * @property {(offset: number, length?: number, options?: ScrollOptions) => void} jumpTo   select the range and
 *   scroll the hex view to it
 * @property {{ current: HexViewApi | null }} hexApiRef   passed to the hex view as `apiRef`
 *
 * @typedef {{ flash?: boolean }} ScrollOptions   `flash` (default true) briefly lights up the row
 *   scrolled to. Pass false where the reader steps through offsets one after another (arrow keys
 *   through a list, following a playhead), so the view follows without flickering.
 * @typedef {{ scrollToOffset: (offset: number, options?: ScrollOptions) => void }} HexViewApi
 *   what the hex view puts in `apiRef`: scroll so the offset is comfortably in view
 *
 * @typedef {Pick<SelectionState, 'setSelection' | 'setHighlights' | 'jumpTo' | 'hexApiRef'> & {
 *   subscribeJumps: (listener: (offset: number) => void) => () => void
 * }} SelectionActions   never change identity
 */

/** @returns {FileState} */
export function useFile() {
  const value = useContext(FileContext)
  if (!value) throw new Error('useFile must be used inside <FileProvider>')
  return value
}

/**
 * The request to open a file that waits for an answer, and the means to ask
 * whether there are unsaved edits. Re-renders only when a request starts or
 * ends; use `useHasUnsavedEdits` to follow the edits themselves.
 * @returns {UnsavedEdits}
 */
export function useUnsavedEdits() {
  const value = useContext(UnsavedEditsContext)
  if (!value) throw new Error('useUnsavedEdits must be used inside <FileProvider>')
  return value
}

/**
 * Whether the open file has edits that were not downloaded. Re-renders the
 * caller only when that answer changes, not on every edit.
 * @returns {boolean}
 */
export function useHasUnsavedEdits() {
  const { subscribe, isUnsaved } = useUnsavedEdits()
  return useSyncExternalStore(subscribe, isUnsaved)
}

/** @returns {SelectionState} */
export function useSelection() {
  const value = useContext(SelectionContext)
  if (!value) throw new Error('useSelection must be used inside <SelectionProvider>')
  return value
}

/**
 * The selection's setters, `jumpTo` and `hexApiRef`, without the selection
 * itself: the object never changes, so callers that only act on the
 * selection do not re-render when it changes.
 * @returns {SelectionActions}
 */
export function useSelectionActions() {
  const value = useContext(SelectionActionsContext)
  if (!value) throw new Error('useSelectionActions must be used inside <SelectionProvider>')
  return value
}

/**
 * @typedef {Object} WorkspaceState
 * @property {string|null} activePanelId   id of the current section: the one last clicked, focused,
 *   chosen in the section index or opened with `openPanel`, or else the first one substantially on
 *   screen. Only the current section's hex-view highlights are shown.
 * @property {(id: string) => void} openPanel   expand a section, make it current and scroll it into view
 * @property {{ id: string, seq: number, focus: boolean } | null} reveal   latest request to bring a
 *   section into view, for the sections column
 * @property {(id: string, options?: { focus?: boolean }) => void} revealPanel   like `openPanel`;
 *   `focus` also moves keyboard focus to the section's header
 * @property {(id: string|null) => void} setCurrentPanel   make a section current without scrolling
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
 * Inside a section, the layer is tagged with the section's id and the hex
 * view only shows it while that section is current.
 *
 * @param {string} layer   unique name, normally the panel id
 * @param {Array<{ start: number, end: number, id?: string|number, label?: string, color?: string }>|null} ranges
 *   memoise this array: a new identity replaces the layer
 */
export function useHighlightLayer(layer, ranges) {
  const { setHighlights } = useSelectionActions()
  // Layers set from inside a section are only shown while it is current
  const section = useContext(SectionContext)
  const sectionId = section ? section.id : null

  useEffect(() => {
    const prefix = `${layer}:`
    const isOther = (highlight) => !String(highlight.id).startsWith(prefix)
    const mine = (ranges || []).map((range, index) => ({ ...range, id: `${prefix}${range.id ?? index}`, section: sectionId }))

    setHighlights(previous => {
      const others = previous.filter(isOther)
      return mine.length === 0 && others.length === previous.length ? previous : [...others, ...mine]
    })
    return () => setHighlights(previous => {
      const others = previous.filter(isOther)
      return others.length === previous.length ? previous : others
    })
  }, [layer, ranges, setHighlights, sectionId])
}

function useHexViewStore() {
  const store = useContext(HexViewContext)
  if (!store) throw new Error('The hex view hooks must be used inside <SelectionProvider>')
  return store
}

/**
 * Byte offset of the hex view's cursor (the byte a plain click or the arrow
 * keys moved to; the selection is null after a plain click). Null while no
 * hex view is shown, 0 for an empty file. Re-renders the caller on every
 * cursor move, in a task after the hex view has updated, so keep the caller
 * small; event handlers that only need the value when they run should use
 * `useHexViewReader` instead.
 * @returns {number|null}
 */
export function useHexCursor() {
  const store = useHexViewStore()
  return useSyncExternalStore(store.subscribeCursor, store.getCursor)
}

/**
 * The bytes the hex view currently shows: `{ start, end, bytesPerRow, visibleRows }`
 * with `start` = first row × bytesPerRow and `end` exclusive, at most the
 * file size. Null while no hex view is shown. The object keeps its identity
 * until one of its fields changes. Re-renders the caller on every scroll
 * step and layout change, so keep the caller small.
 * @returns {import('./hexViewStore.js').HexViewport|null}
 */
export function useHexViewport() {
  const store = useHexViewStore()
  return useSyncExternalStore(store.subscribeViewport, store.getViewport)
}

/**
 * Reads the hex view's cursor and viewport without subscribing to them, for
 * event handlers and animation frames that need the value at the moment
 * they run. The returned object never changes.
 * @returns {{ getCursor: () => number|null, getViewport: () => import('./hexViewStore.js').HexViewport|null }}
 */
export function useHexViewReader() {
  const store = useHexViewStore()
  return store.reader
}

/**
 * For the component that hosts the hex view: callbacks that report its
 * cursor and viewport into shared state. Stable across renders.
 * @returns {{ setCursor: (offset: number|null) => void, setViewport: (viewport: import('./hexViewStore.js').HexViewport|null) => void }}
 */
export function useHexViewReporter() {
  const store = useHexViewStore()
  return store.reporter
}
