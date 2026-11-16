/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useMemo, useState } from 'react'
import { WorkspaceContext } from './contexts.js'

export default function WorkspaceProvider({ children }) {
  const [activePanelId, setActivePanelId] = useState(null)

  const value = useMemo(() => ({ activePanelId, openPanel: setActivePanelId }), [activePanelId])

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
