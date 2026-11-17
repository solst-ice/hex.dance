/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PanelBoundary from './PanelBoundary'
import { FileContext, HexViewContext, SectionContext, SelectionContext } from '../state/contexts.js'
import { createGatedHexViewStore } from '../state/gatedHexViewStore.js'

/**
 * Passes the file, the selection and the hex view's cursor and viewport
 * through to a section's panel while the section is on screen, and holds
 * their last values while it is off screen, so changes made meanwhile do not
 * re-render the panel. It catches up when the section comes back.
 * `children` must keep its identity across this component's renders.
 */
function LiveGate({ live, children }) {
  const file = useContext(FileContext)
  const selection = useContext(SelectionContext)
  const hexView = useContext(HexViewContext)
  const held = useRef(null)
  if (live || !held.current) held.current = { file, selection }
  const [gated] = useState(() => createGatedHexViewStore(hexView, live))

  useLayoutEffect(() => {
    gated.setLive(live)
  }, [gated, live])

  return (
    <FileContext.Provider value={held.current.file}>
      <SelectionContext.Provider value={held.current.selection}>
        <HexViewContext.Provider value={gated}>{children}</HexViewContext.Provider>
      </SelectionContext.Provider>
    </FileContext.Provider>
  )
}

/**
 * One panel as a collapsible section: a header button with the title, badge
 * and a one-line description, then the panel. The panel is only mounted
 * once the section is expanded and near the screen (`mounted`); until then
 * a fixed-height placeholder stands in.
 */
function PanelSection({
  panel, badge, file, expanded, mounted, live, current, onToggle, onActivate, register, registerToggle
}) {
  const { id, title, description } = panel
  const titleId = `section-${id}-title`
  const badgeId = `section-${id}-badge`
  const descriptionId = `section-${id}-description`
  const bodyId = `section-${id}-body`

  const info = useMemo(() => ({ id, title }), [id, title])
  // Created once per file, so the gate's own re-renders stop here
  const element = useMemo(() => {
    const { Component } = panel
    return (
      <PanelBoundary title={panel.title} resetKey={file}>
        <Component />
      </PanelBoundary>
    )
  }, [panel, file])

  const sectionRef = useCallback(node => register(id, node), [register, id])
  const toggleRef = useCallback(node => registerToggle(id, node), [registerToggle, id])
  const activate = useCallback(() => onActivate(id), [onActivate, id])

  const labelledBy = badge !== null ? `${titleId} ${badgeId}` : titleId
  return (
    <section
      ref={sectionRef}
      className={`panel-section${current ? ' is-current' : ''}`}
      data-section={id}
      data-state={expanded ? 'open' : 'collapsed'}
      data-mounted={expanded && mounted ? 'true' : 'false'}
      data-live={expanded && mounted && live ? 'true' : 'false'}
      aria-labelledby={titleId}
      onFocusCapture={activate}
      onPointerDownCapture={activate}
    >
      <h2 className="panel-section-heading">
        <button
          ref={toggleRef}
          type="button"
          className="panel-section-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-labelledby={labelledBy}
          aria-describedby={description ? descriptionId : undefined}
          onClick={() => onToggle(id)}
          title={expanded ? `Collapse ${title}` : `Expand ${title}`}
        >
          <span className="panel-section-chevron" aria-hidden="true" />
          <span className="panel-section-name">
            <span className="panel-section-title" id={titleId}>{title}</span>
            {badge !== null && <span className="hd-tab-badge panel-section-badge" id={badgeId}>{badge}</span>}
          </span>
          {description && <span className="panel-section-description" id={descriptionId}>{description}</span>}
        </button>
      </h2>
      <div className="panel-section-body" id={bodyId} hidden={!expanded}>
        {expanded && (mounted
          ? (
            <SectionContext.Provider value={info}>
              <LiveGate live={live}>{element}</LiveGate>
            </SectionContext.Provider>
          )
          : <div className="panel-section-placeholder">Opens when scrolled into view</div>)}
      </div>
    </section>
  )
}

export default memo(PanelSection)
