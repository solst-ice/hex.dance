import { useMemo } from 'react'
import HexDump from './HexDump'
import PanelBoundary from './PanelBoundary'
import PanelTabs from './PanelTabs'
import { availablePanels } from '../panels/index.js'
import { useFile, useSelection } from '../state/hooks.js'

// The only part of the layout that follows the selection, so selecting bytes
// does not re-render the panels
function HexArea() {
  const { file, buffer, status, notifyEdit } = useFile()
  const { selection, setSelection, highlights, hexApiRef } = useSelection()

  if (!buffer) {
    return (
      <div className="hd-panel workspace-placeholder">
        {status === 'error' ? <p className="hd-warning">Could not read this file.</p> : <p className="hd-empty">Reading file…</p>}
      </div>
    )
  }
  return (
    <HexDump
      buffer={buffer}
      fileName={file.name}
      selection={selection}
      onSelectionChange={setSelection}
      highlights={highlights}
      onEdit={notifyEdit}
      apiRef={hexApiRef}
    />
  )
}

/**
 * Layout once a file is open: hex view with the dock panels under it, and
 * the tab panels beside it on wide screens or below it on narrow ones.
 */
function Workspace() {
  const { file, analysis, status } = useFile()

  const context = useMemo(() => ({ file, analysis, status }), [file, analysis, status])
  const tabPanels = useMemo(() => availablePanels('tab', context), [context])
  const dockPanels = useMemo(() => availablePanels('dock', context), [context])

  return (
    <div className="workspace">
      <div className="workspace-main">
        <HexArea />
        {dockPanels.length > 0 && (
          <div className="workspace-dock">
            {dockPanels.map(({ id, title, Component }) => (
              <PanelBoundary key={id} title={title} resetKey={file}>
                <Component />
              </PanelBoundary>
            ))}
          </div>
        )}
      </div>
      <div className="workspace-side">
        <PanelTabs panels={tabPanels} analysis={analysis} resetKey={file} />
      </div>
    </div>
  )
}

export default Workspace
