/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CONFIDENCE, hitSize } from './labels.js'

export const ROW_HEIGHT = 46
const OVERSCAN = 6

const Row = memo(function Row({ hit, top, active, digits, onPick }) {
  const confidence = CONFIDENCE[hit.confidence]
  const badge = hit.role === 'main'
    ? <span className="hd-badge carve-badge-main">This file</span>
    : hit.role === 'internal'
      ? <span className="hd-badge carve-badge-part">Part of {hit.parentType}</span>
      : <span className={`hd-badge carve-conf carve-conf--${hit.confidence}`}>{confidence.label}</span>
  return (
    <div
      id={`carve-row-${hit.id}`}
      role="option"
      aria-selected={active}
      className={'carve-row' + (active ? ' is-active' : '') + (hit.role !== 'embedded' ? ' is-quiet' : '')}
      style={{ transform: `translateY(${top}px)` }}
      onClick={() => onPick(hit.id)}
    >
      <div className="carve-row-line">
        <span className="carve-offset">{hit.start.toString(16).toUpperCase().padStart(digits, '0')}</span>
        <span className="carve-name">{hit.name}</span>
        <span className="carve-size">{hitSize(hit)}</span>
        {badge}
      </div>
      <div className="carve-row-note">{hit.parentLabel && hit.role !== 'main' ? `In ${hit.parentLabel}. ` : ''}{hit.note}</div>
    </div>
  )
})

/** Windowed list of hits; only the rows in view are rendered. */
function HitList({ hits, activeId, onPick, digits, resetKey }) {
  const scrollRef = useRef(null)
  const [view, setView] = useState({ top: 0, height: 360 })
  const frame = useRef(0)

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return undefined
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight || 360 })
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => {
      observer?.disconnect()
      cancelAnimationFrame(frame.current)
    }
  }, [])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = 0
    setView(previous => ({ ...previous, top: 0 }))
  }, [resetKey])

  const onScroll = () => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const element = scrollRef.current
      if (element) setView(previous => (previous.top === element.scrollTop ? previous : { ...previous, top: element.scrollTop }))
    })
  }

  const activePosition = hits.findIndex(h => h.id === activeId)

  const lastActive = useRef(-1)
  useEffect(() => {
    const element = scrollRef.current
    if (!element || activePosition < 0 || activePosition === lastActive.current) return
    lastActive.current = activePosition
    const rowTop = activePosition * ROW_HEIGHT
    if (rowTop < element.scrollTop) element.scrollTop = rowTop
    else if (rowTop + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = rowTop + ROW_HEIGHT - element.clientHeight
  }, [activePosition])

  const onKeyDown = (event) => {
    if (!hits.length) return
    const page = Math.max(1, Math.floor(view.height / ROW_HEIGHT) - 1)
    const from = activePosition
    const target = {
      ArrowDown: from + 1,
      ArrowUp: from < 0 ? 0 : from - 1,
      PageDown: from + page,
      PageUp: from - page,
      Home: 0,
      End: hits.length - 1
    }[event.key]
    if (target !== undefined) {
      event.preventDefault()
      onPick(hits[Math.max(0, Math.min(hits.length - 1, target))].id, { keyboard: true })
    } else if (event.key === 'Enter' && activePosition >= 0) {
      event.preventDefault()
      onPick(activeId)
    }
  }

  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(hits.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN)
  const rows = hits.slice(first, Math.max(first, last)).map((hit, k) => (
    <Row key={hit.id} hit={hit} top={(first + k) * ROW_HEIGHT} active={hit.id === activeId} digits={digits} onPick={onPick} />
  ))
  const activeRendered = activePosition >= first && activePosition < last

  return (
    <div
      ref={scrollRef}
      className="carve-list"
      role="listbox"
      tabIndex={0}
      aria-label="Signatures found, by offset"
      aria-activedescendant={activeRendered ? `carve-row-${activeId}` : undefined}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      style={{ height: Math.min(Math.max(hits.length, 1), 9) * ROW_HEIGHT + 2 }}
    >
      <div className="carve-spacer" style={{ height: hits.length * ROW_HEIGHT }}>
        {rows}
      </div>
    </div>
  )
}

export default memo(HitList)
