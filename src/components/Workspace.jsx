/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useMemo } from 'react'
import HexDump from './HexDump'
import HexReturn from './HexReturn'
import PanelBoundary from './PanelBoundary'
import SectionStack from './SectionStack'
import { availablePanels } from '../panels/index.js'
import { useFile, useHexViewReporter, useSelection, useWorkspace } from '../state/hooks.js'

// The only part of the layout that follows the selection, so selecting bytes
// does not re-render the panels
function HexArea() {
  const { file, buffer, status, notifyEdit } = useFile()
  const { selection, setSelection, highlights, hexApiRef } = useSelection()
  const { activePanelId } = useWorkspace()
  const { setCursor, setViewport } = useHexViewReporter()

  // Of the sections' layers, only the current section's are shown
  const shown = useMemo(() => {
    const kept = highlights.filter(highlight => !highlight.section || highlight.section === activePanelId)
    return kept.length === highlights.length ? highlights : kept
  }, [highlights, activePanelId])

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
      highlights={shown}
      onEdit={notifyEdit}
      apiRef={hexApiRef}
      onCursorChange={setCursor}
      onViewportChange={setViewport}
    />
  )
}

/**
 * Layout once a file is open: the hex view with the dock panels under it,
 * and every 'tab' panel stacked as a collapsible section beside it on wide
 * screens or below it on narrow ones. On wide screens the hex column stays
 * in place while the page (or, with several columns of sections, each
 * column) scrolls the sections. `footer` ends the last column of sections,
 * so the hex column can stay pinned to the very bottom of the page.
 */
function Workspace({ footer = null }) {
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
        <SectionStack panels={tabPanels} analysis={analysis} file={file} status={status} footer={footer} />
      </div>
      <HexReturn panels={tabPanels} />
    </div>
  )
}

export default Workspace
