import { createContext } from 'react'

// Split in two so that selection changes, which are frequent, do not
// re-render components that only depend on the file and its analysis.
export const FileContext = createContext(null)
// Whether the open file has edits that would be lost, and the request to
// open another file that waits for an answer. Its value changes only when a
// request starts or ends, never on an edit.
export const UnsavedEditsContext = createContext(null)
export const SelectionContext = createContext(null)
// The selection's setters and jumpTo, which never change: components that
// only act on the selection read these and do not re-render when it changes
export const SelectionActionsContext = createContext(null)
// Which section is current, so code outside the sections can open one
export const WorkspaceContext = createContext(null)
// The hex view's cursor and visible range: a store whose identity never
// changes, read through useSyncExternalStore (see hexViewStore.js). Inside a
// section it is that section's pausable view of it (gatedHexViewStore.js).
// Provided by SelectionProvider.
export const HexViewContext = createContext(null)
// The section a component renders in: `{ id, title }`, or null outside the
// sections (the hex view and the docks). Never changes for a given section.
export const SectionContext = createContext(null)
