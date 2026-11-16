import { createContext } from 'react'

// Split in two so that selection changes, which are frequent, do not
// re-render components that only depend on the file and its analysis.
export const FileContext = createContext(null)
export const SelectionContext = createContext(null)
// Which tab panel is showing, so code outside the tab strip can switch tabs
export const WorkspaceContext = createContext(null)
// The hex view's cursor and visible range: a store whose identity never
// changes, read through useSyncExternalStore (see hexViewStore.js)
export const HexViewContext = createContext(null)
