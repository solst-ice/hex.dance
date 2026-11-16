/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export const ROW_HEIGHT = 28
const OVERSCAN = 8
// Browsers cap element heights (around 16-33 million px); beyond this the
// scrollbar maps proportionally onto the rows instead of one pixel per pixel.
const MAX_SCROLL_HEIGHT = 8000000

const SORT_COLUMNS = [
  ['name', 'Name', 'symbols-col-name'],
  ['type', 'Type', 'symbols-col-type'],
  ['address', 'Address / library', 'symbols-col-addr']
]

function SortHeader({ sortKey, descending, onSort }) {
  return (
    <div className="symbols-head" role="row">
      {SORT_COLUMNS.map(([key, label, className]) => {
        const active = sortKey === key
        return (
          <div key={key} role="columnheader" className={className} aria-sort={active ? (descending ? 'descending' : 'ascending') : 'none'}>
            <button type="button" className="symbols-sort" onClick={() => onSort(key)}>
              {label}
              <span aria-hidden="true" className="symbols-sort-mark">{active ? (descending ? ' ▼' : ' ▲') : ''}</span>
            </button>
          </div>
        )
      })}
      <div role="columnheader" className="symbols-col-tag">Uses</div>
    </div>
  )
}

function locationText(symbol) {
  if (symbol.address) return symbol.address
  if (symbol.library) return symbol.library.replace(/^.*\//, '')
  return symbol.note || ''
}

const Row = memo(function Row({ symbol, index, top, selected, name, tag, onPick }) {
  return (
    <div
      id={`symbol-row-${index}`}
      role="option"
      aria-selected={selected}
      className={`symbols-row${selected ? ' is-selected' : ''}`}
      style={{ transform: `translateY(${top}px)` }}
      onClick={() => onPick(index)}
    >
      <span className="symbols-col-name" title={name}>{name}</span>
      <span className="symbols-col-type" title={symbol.type}>{symbol.type}</span>
      <span className="symbols-col-addr" title={symbol.note || symbol.library || ''}>{locationText(symbol)}</span>
      <span className="symbols-col-tag">{tag ? <span className="symbols-tag">{tag}</span> : null}</span>
    </div>
  )
})

/**
 * Windowed list of symbols. Only the rows in view (plus a few) are in the
 * DOM, so 100,000+ rows scroll as smoothly as ten.
 * @param {{ rows: Uint32Array, symbols: import('../../analysis/types.js').SymbolEntry[], selected: number|null,
 *   onSelect: (index: number) => void, onActivate: (index: number) => void, onCopy: (index: number) => void,
 *   nameOf: (index: number) => string, tagOf: (index: number) => string|null,
 *   sortKey: string, descending: boolean, onSort: (key: string) => void, label: string }} props
 */
function SymbolTable({ rows, symbols, selected, onSelect, onActivate, onCopy, nameOf, tagOf, sortKey, descending, onSort, label }) {
  const viewportRef = useRef(null)
  const [viewport, setViewport] = useState({ top: 0, height: 400 })
  const frame = useRef(0)

  const count = rows.length
  const fullHeight = count * ROW_HEIGHT
  const scrollHeight = Math.min(fullHeight, MAX_SCROLL_HEIGHT)
  // With a scaled scrollbar, scrollTop maps onto the full height proportionally
  const scale = scrollHeight > viewport.height && fullHeight > scrollHeight
    ? (fullHeight - viewport.height) / (scrollHeight - viewport.height)
    : 1
  const virtualTop = viewport.top * scale
  const first = Math.max(0, Math.floor(virtualTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(count, Math.ceil((virtualTop + viewport.height) / ROW_HEIGHT) + OVERSCAN)
  const offset = viewport.top - virtualTop // shifts rows into the visible part of the scaled spacer

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return undefined
    const measure = () => setViewport(v => (v.height === element.clientHeight && v.top === element.scrollTop ? v : { top: element.scrollTop, height: element.clientHeight }))
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // A new filter or sort starts at the top
  useLayoutEffect(() => {
    const element = viewportRef.current
    if (element) element.scrollTop = 0
    setViewport(v => ({ ...v, top: 0 }))
  }, [rows])

  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const element = viewportRef.current
      if (element) setViewport(v => (v.top === element.scrollTop ? v : { ...v, top: element.scrollTop }))
    })
  }, [])

  const position = selected === null ? -1 : rows.indexOf(selected)

  const scrollIntoView = (rowPosition) => {
    const element = viewportRef.current
    if (!element) return
    const rowTop = rowPosition * ROW_HEIGHT / scale
    if (rowTop < element.scrollTop) element.scrollTop = rowTop
    else if (rowTop + ROW_HEIGHT / scale > element.scrollTop + element.clientHeight - ROW_HEIGHT) {
      element.scrollTop = rowTop - element.clientHeight + ROW_HEIGHT * 2
    }
  }

  const onKeyDown = (event) => {
    if (!count) return
    const page = Math.max(1, Math.floor(viewport.height / ROW_HEIGHT) - 1)
    let next = null
    switch (event.key) {
      case 'ArrowDown': next = position < 0 ? 0 : Math.min(count - 1, position + 1); break
      case 'ArrowUp': next = position < 0 ? 0 : Math.max(0, position - 1); break
      case 'PageDown': next = Math.min(count - 1, Math.max(0, position) + page); break
      case 'PageUp': next = Math.max(0, position - page); break
      case 'Home': next = 0; break
      case 'End': next = count - 1; break
      case 'Enter':
      case ' ':
        if (position >= 0) {
          event.preventDefault()
          onActivate(rows[position])
        }
        return
      case 'c':
        if ((event.ctrlKey || event.metaKey) && position >= 0 && !window.getSelection()?.toString()) {
          event.preventDefault()
          onCopy(rows[position])
        }
        return
      default:
        return
    }
    event.preventDefault()
    onSelect(rows[next])
    scrollIntoView(next)
  }

  const items = []
  for (let p = first; p < last; p++) {
    const index = rows[p]
    items.push(
      <Row
        key={index}
        index={index}
        symbol={symbols[index]}
        name={nameOf(index)}
        tag={tagOf(index)}
        top={p * ROW_HEIGHT + offset}
        selected={index === selected}
        onPick={onActivate}
      />
    )
  }

  return (
    <div className="symbols-table">
      <SortHeader sortKey={sortKey} descending={descending} onSort={onSort} />
      <div
        ref={viewportRef}
        className="symbols-viewport"
        role="listbox"
        tabIndex={0}
        aria-label={label}
        aria-activedescendant={position >= 0 ? `symbol-row-${selected}` : undefined}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div className="symbols-spacer" style={{ height: scrollHeight }}>
          {items}
        </div>
        {count === 0 && <p className="hd-empty symbols-none">No symbols match.</p>}
      </div>
    </div>
  )
}

export default memo(SymbolTable)
