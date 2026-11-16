/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useRef, useState } from 'react'
import PanelBoundary from './PanelBoundary'
import { panelBadge } from '../panels/index.js'

/**
 * Tab strip for the 'tab' panels. The chosen tab is remembered across files
 * and falls back to the first tab while it is not available.
 */
function PanelTabs({ panels, analysis, resetKey }) {
  const [chosenId, setChosenId] = useState(null)
  const tabRefs = useRef({})
  if (panels.length === 0) return null

  const active = panels.find(panel => panel.id === chosenId) || panels[0]
  const { Component } = active

  const handleKeyDown = (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const index = panels.indexOf(active)
    const next = panels[(index + step + panels.length) % panels.length]
    setChosenId(next.id)
    tabRefs.current[next.id]?.focus()
  }

  return (
    <div className="panel-tabs">
      <div className="hd-tabs" role="tablist" aria-label="Analysis panels" onKeyDown={handleKeyDown}>
        {panels.map(panel => {
          const badge = panelBadge(panel, analysis)
          const selected = panel === active
          return (
            <button
              key={panel.id}
              ref={element => { tabRefs.current[panel.id] = element }}
              type="button"
              role="tab"
              id={`tab-${panel.id}`}
              className="hd-tab"
              aria-selected={selected}
              aria-controls={`tabpanel-${panel.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setChosenId(panel.id)}
            >
              {panel.title}
              {badge !== null && <span className="hd-tab-badge">{badge}</span>}
            </button>
          )
        })}
      </div>
      <div className="panel-tabs-body" role="tabpanel" id={`tabpanel-${active.id}`} aria-labelledby={`tab-${active.id}`}>
        <PanelBoundary key={active.id} title={active.title} resetKey={resetKey}>
          <Component />
        </PanelBoundary>
      </div>
    </div>
  )
}

export default PanelTabs
