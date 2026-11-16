/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fieldKind, fieldKindLabel } from './kinds.js'
import { formatLength, formatOffset } from './treeModel.js'

export const ROW_HEIGHT = 28
const OVERSCAN = 8

const Row = memo(function Row({ node, top, active, hovered, expanded, rowId, onPick, onToggle, onHover }) {
  const { field, depth, children } = node
  const hasChildren = children.length > 0
  const kind = fieldKind(field.kind)
  return (
    <div
      id={rowId}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={active}
      className={`sx-row${active ? ' is-active' : ''}${hovered ? ' is-hovered' : ''}`}
      style={{ top, '--sx-depth': depth }}
      onClick={() => onPick(node.id)}
      onDoubleClick={() => hasChildren && onToggle(node.id)}
      onMouseEnter={() => onHover(node.id)}
    >
      <span
        className={`sx-caret${hasChildren ? '' : ' is-leaf'}`}
        aria-hidden="true"
        onClick={event => {
          if (!hasChildren) return
          event.stopPropagation()
          onToggle(node.id)
        }}
      >
        {hasChildren ? (expanded ? '▾' : '▸') : ''}
      </span>
      <span className="sx-swatch sx-kind-swatch" style={{ background: `var(--sx-field-${kind})` }} aria-hidden="true" />
      <span className="sx-name">{field.name}</span>
      {field.kind === 'magic' && <span className="hd-badge hd-badge--pink sx-magic">magic</span>}
      <span className="sx-value">{field.value ?? ''}</span>
      <span className="sx-range hd-muted" aria-label={`offset ${formatOffset(field.offset)}, ${formatLength(field.length)}, ${fieldKindLabel(field.kind)}`}>
        {formatOffset(field.offset)}<span className="sx-len"> · {field.length.toLocaleString('en-US')}</span>
      </span>
    </div>
  )
})

/**
 * Windowed tree of fields: only the rows in view (plus a few) are rendered,
 * so tens of thousands of fields stay fast. Keyboard: arrows move, Right and
 * Left open and close, Home and End jump, Enter toggles.
 */
function FieldTree({ index, rows, expanded, activeId, hoverId, revealToken, onPick, onToggle, onHover, label }) {
  const scrollerRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)

  useLayoutEffect(() => {
    const element = scrollerRef.current
    if (!element) return undefined
    const measure = () => setHeight(element.clientHeight || 400)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Scroll the active row into view when asked to (selection from elsewhere, keyboard, tour)
  useLayoutEffect(() => {
    const element = scrollerRef.current
    if (!element || activeId < 0) return
    const position = rows.indexOf(activeId)
    if (position === -1) return
    const top = position * ROW_HEIGHT
    const view = element.clientHeight
    if (top < element.scrollTop) element.scrollTop = Math.max(0, top - ROW_HEIGHT * 2)
    else if (top + ROW_HEIGHT > element.scrollTop + view) element.scrollTop = top - view + ROW_HEIGHT * 3
    setScrollTop(element.scrollTop)
    // Only when a reveal is requested, not on every row change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken])

  // Keep the scroll position valid when rows collapse
  useEffect(() => {
    const element = scrollerRef.current
    if (element && element.scrollTop > rows.length * ROW_HEIGHT) element.scrollTop = 0
  }, [rows])

  const onKeyDown = useCallback(event => {
    if (rows.length === 0) return
    const position = Math.max(0, rows.indexOf(activeId))
    const node = activeId >= 0 ? index.nodes[activeId] : null
    const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1)
    let next = null
    switch (event.key) {
      case 'ArrowDown': next = rows[Math.min(rows.length - 1, activeId < 0 ? 0 : position + 1)]; break
      case 'ArrowUp': next = rows[Math.max(0, position - 1)]; break
      case 'PageDown': next = rows[Math.min(rows.length - 1, position + page)]; break
      case 'PageUp': next = rows[Math.max(0, position - page)]; break
      case 'Home': next = rows[0]; break
      case 'End': next = rows[rows.length - 1]; break
      case 'ArrowRight':
        if (!node) next = rows[0]
        else if (node.children.length && !expanded.has(node.id)) onToggle(node.id)
        else if (node.children.length) next = node.children[0]
        break
      case 'ArrowLeft':
        if (node && node.children.length && expanded.has(node.id)) onToggle(node.id)
        else if (node && node.parent !== -1) next = node.parent
        break
      case 'Enter':
      case ' ':
        if (node && node.children.length) onToggle(node.id)
        else if (node) onPick(node.id)
        break
      default:
        return
    }
    event.preventDefault()
    if (next !== null && next !== undefined) onPick(next, { reveal: true })
  }, [rows, activeId, index, expanded, height, onPick, onToggle])

  const activePosition = activeId >= 0 ? rows.indexOf(activeId) : -1
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
  const rendered = []
  for (let i = first; i < last; i++) {
    const id = rows[i]
    rendered.push(
      <Row
        key={id}
        node={index.nodes[id]}
        top={i * ROW_HEIGHT}
        rowId={`sx-node-${id}`}
        active={id === activeId}
        hovered={id === hoverId}
        expanded={expanded.has(id)}
        onPick={onPick}
        onToggle={onToggle}
        onHover={onHover}
      />
    )
  }

  return (
    <div
      ref={scrollerRef}
      className="sx-tree"
      role="tree"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={activePosition >= first && activePosition < last ? `sx-node-${activeId}` : undefined}
      onKeyDown={onKeyDown}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="sx-tree-inner" style={{ height: rows.length * ROW_HEIGHT }}>
        {rendered}
      </div>
    </div>
  )
}

export default memo(FieldTree)
