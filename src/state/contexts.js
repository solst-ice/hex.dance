import { createContext } from 'react'

// Split in two so that selection changes, which are frequent, do not
// re-render components that only depend on the file and its analysis.
export const FileContext = createContext(null)
export const SelectionContext = createContext(null)
