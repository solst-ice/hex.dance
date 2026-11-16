/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFile, useHighlightLayer, useSelection } from '../../state/hooks.js'
import { formatCardFor } from '../../education/index.js'
import FieldTree from './FieldTree.jsx'
import FormatCard from './FormatCard.jsx'
import { fieldKind, fieldKindLabel, fieldKindMeaning } from './kinds.js'
import { ancestors, buildTreeIndex, formatLength, formatOffset, locate, tourSteps, visibleRows } from './treeModel.js'
import { useHexCursor } from './useHexView.js'
import './kinds.css'
import './structure.css'

const EMPTY_SET = new Set()

// A stable key per analysis object, so per-file state starts fresh
const analysisKeys = new WeakMap()
let nextKey = 1
function keyOf(analysis) {
  if (!analysisKeys.has(analysis)) analysisKeys.set(analysis, nextKey++)
  return analysisKeys.get(analysis)
}

function FieldDetail({ index, id, tour }) {
  if (id < 0) {
    return (
      <div className="sx-detail sx-detail--idle">
        <p className="hd-muted">Pick a field to see what its bytes mean, or move the cursor in the hex view.</p>
      </div>
    )
  }
  const { field } = index.nodes[id]
  const path = ancestors(index, id).map(parent => index.nodes[parent].field.name)
  const kind = fieldKind(field.kind)
  const description = field.description || fieldKindMeaning(field.kind)
  return (
    <div className="sx-detail" aria-live={tour ? 'polite' : 'off'}>
      {tour && <p className="sx-tour-step">Step {tour.step + 1} of {tour.total}</p>}
      {path.length > 0 && <p className="sx-path hd-muted">{path.join(' › ')}</p>}
      <div className="sx-detail-head">
        <h3 className="sx-detail-name">{field.name}</h3>
        <span className="hd-badge sx-kind-badge" style={{ '--sx-kind': `var(--sx-field-${kind})` }}>
          {field.kind === 'magic' ? 'magic' : fieldKindLabel(field.kind).toLowerCase()}
        </span>
      </div>
      {field.value !== undefined && field.value !== '' && <p className="sx-detail-value hd-mono">{field.value}</p>}
      <p className="sx-detail-range">
        Offset {formatOffset(field.offset)} ({field.offset.toLocaleString('en-US')}), {formatLength(field.length)}
        {field.length > 1 && <span className="hd-muted"> · ends at {formatOffset(field.offset + field.length - 1)}</span>}
      </p>
      {description && <p className="sx-detail-description">{description}</p>}
    </div>
  )
}

function StructureView({ analysis }) {
  const { selection, jumpTo } = useSelection()
  const index = useMemo(() => buildTreeIndex(analysis.fields), [analysis])
  const steps = useMemo(() => tourSteps(index), [index])
  const [expanded, setExpanded] = useState(() => (index.roots.length === 1 ? new Set(index.roots) : EMPTY_SET))
  const [activeId, setActiveId] = useState(-1)
  const [hoverId, setHoverId] = useState(null)
  const [revealToken, setRevealToken] = useState(0)
  const [tourStep, setTourStep] = useState(null)
  const rows = useMemo(() => visibleRows(index, expanded), [index, expanded])
  const nextButtonRef = useRef(null)

  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  const expandTo = useCallback(id => {
    const path = ancestors(index, id)
    setExpanded(previous => {
      if (path.every(parent => previous.has(parent))) return previous
      const next = new Set(previous)
      for (const parent of path) next.add(parent)
      return next
    })
  }, [index])

  const reveal = useCallback(id => {
    if (id < 0) return
    expandTo(id)
    setActiveId(id)
    setRevealToken(token => token + 1)
  }, [expandTo])

  const pick = useCallback((id, options = {}) => {
    const { field } = index.nodes[id]
    setActiveId(id)
    if (options.reveal) setRevealToken(token => token + 1)
    jumpTo(field.offset, field.length)
  }, [index, jumpTo])

  const toggle = useCallback(id => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const hover = useCallback(id => setHoverId(id), [])

  // Selection made elsewhere (hex view, other panels): show the field holding it
  useEffect(() => {
    if (!selection) return
    const current = activeRef.current
    if (current >= 0) {
      const { field } = index.nodes[current]
      if (field.offset === selection.start && field.offset + field.length === selection.end) return
    }
    reveal(locate(index, selection.start, selection.end))
  }, [selection, index, reveal])

  // Cursor moves in the hex view without a selection
  const cursor = useHexCursor()
  const lastCursor = useRef(null)
  useEffect(() => {
    if (cursor === null) return
    const previous = lastCursor.current
    lastCursor.current = cursor
    if (previous === null || previous === cursor || selectionRef.current) return
    reveal(locate(index, cursor, cursor + 1))
  }, [cursor, index, reveal])

  const hoverRanges = useMemo(() => {
    if (hoverId === null || !index.nodes[hoverId]) return null
    const { field } = index.nodes[hoverId]
    return [{ start: field.offset, end: field.offset + field.length, label: field.name, color: 'var(--sx-hover)', id: 'hover' }]
  }, [hoverId, index])
  useHighlightLayer('structure', hoverRanges)

  const goToStep = useCallback(step => {
    const id = steps[step]
    if (id === undefined) return
    setTourStep(step)
    reveal(id)
    const { field } = index.nodes[id]
    jumpTo(field.offset, field.length)
  }, [steps, index, reveal, jumpTo])

  const startTour = () => {
    goToStep(0)
    requestAnimationFrame(() => nextButtonRef.current?.focus())
  }

  const onTourKey = event => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') goToStep(Math.min(steps.length - 1, tourStep + 1))
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') goToStep(Math.max(0, tourStep - 1))
    else if (event.key === 'Escape') setTourStep(null)
    else return
    event.preventDefault()
  }

  const touring = tourStep !== null
  const count = index.nodes.length

  return (
    <>
      <div className="sx-toolbar">
        <span className="hd-muted sx-count">
          {count.toLocaleString('en-US')} {count === 1 ? 'field' : 'fields'}
        </span>
        <div className="hd-row">
          <button type="button" className="hd-button hd-button--small" onClick={() => setExpanded(EMPTY_SET)} disabled={expanded.size === 0}>
            Collapse all
          </button>
          {!touring && (
            <button type="button" className="hd-button hd-button--small hd-button--active sx-tour-start" onClick={startTour} disabled={steps.length === 0}>
              Walk me through this file
            </button>
          )}
        </div>
      </div>

      {touring && (
        <div className="sx-tour" role="group" aria-label="Guided tour" onKeyDown={onTourKey}>
          <button type="button" className="hd-button hd-button--small" onClick={() => goToStep(tourStep - 1)} disabled={tourStep === 0}>
            Previous
          </button>
          <button ref={nextButtonRef} type="button" className="hd-button hd-button--small hd-button--active sx-tour-next" onClick={() => goToStep(tourStep + 1)} disabled={tourStep >= steps.length - 1}>
            Next
          </button>
          <button type="button" className="hd-button hd-button--small" onClick={() => setTourStep(null)}>
            End tour
          </button>
          <span className="hd-muted sx-tour-hint">Arrow keys step, Esc ends</span>
        </div>
      )}

      <FieldDetail index={index} id={activeId} tour={touring ? { step: tourStep, total: steps.length } : null} />

      <FieldTree
        index={index}
        rows={rows}
        expanded={expanded}
        activeId={activeId}
        hoverId={hoverId}
        revealToken={revealToken}
        onPick={pick}
        onToggle={toggle}
        onHover={hover}
        label={`Fields of this ${analysis.formatName}`}
      />
    </>
  )
}

function Structure() {
  const { analysis, status } = useFile()
  const card = useMemo(() => formatCardFor(analysis), [analysis])

  return (
    <section className="hd-panel structure-panel">
      <div className="hd-panel-header">
        <h2 className="hd-panel-title">Structure</h2>
      </div>
      {!analysis && <p className="hd-empty">{status === 'error' ? 'This file could not be analysed.' : 'Analyzing…'}</p>}
      {analysis && <FormatCard key={analysis.formatId} card={card} />}
      {analysis && analysis.fields.length === 0 && (
        <p className="hd-empty sx-empty">
          No fields are mapped for this file. Every byte is still in the hex view; the guide above explains how to read it.
        </p>
      )}
      {analysis && analysis.fields.length > 0 && <StructureView key={keyOf(analysis)} analysis={analysis} />}
    </section>
  )
}

export default Structure
