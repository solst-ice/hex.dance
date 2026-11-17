/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useMemo, useRef, useState } from 'react'
import { WorkspaceContext } from './contexts.js'

/**
 * Which section is current, and requests to bring one into view. The
 * sections column (components/SectionStack.jsx) carries the requests out.
 */
export default function WorkspaceProvider({ children }) {
  const [activePanelId, setActivePanelId] = useState(null)
  const [reveal, setReveal] = useState(null)
  const seq = useRef(0)

  const revealPanel = useCallback((id, { focus = false } = {}) => {
    if (!id) return
    setActivePanelId(id)
    setReveal({ id, seq: ++seq.current, focus })
  }, [])

  const openPanel = useCallback((id) => revealPanel(id), [revealPanel])

  const value = useMemo(() => ({
    activePanelId,
    openPanel,
    reveal,
    revealPanel,
    setCurrentPanel: setActivePanelId
  }), [activePanelId, openPanel, reveal, revealPanel])

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
