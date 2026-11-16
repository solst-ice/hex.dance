/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useEffect, useRef, useState } from 'react'
import { hexOffset, hexPreview, plural } from './format.js'
import { itemAt, itemCount } from './items.js'

const ROW = 28
const MAX_HEIGHT = ROW * 9
const OVERSCAN = 6
const PAGE = 8

function Row({ item, index, top, selected, a, b, digits, onActivate }) {
  const length = item.end - item.start
  return (
    <div
      id={`compare-item-${index}`}
      role="option"
      aria-selected={selected}
      className={`compare-item${selected ? ' is-selected' : ''}${item.kind === 'tail' ? ' is-tail' : ''}`}
      style={{ top }}
      onClick={() => onActivate(index)}
    >
      <span className="compare-item-offset hd-mono">{hexOffset(item.start, digits)}</span>
      <span className="compare-item-length hd-mono">{length.toLocaleString('en-US')}</span>
      {item.kind === 'tail' ? (
        <span className="compare-item-preview hd-muted">only in {item.only}</span>
      ) : (
        <span className="compare-item-preview hd-mono">
          <span className="compare-a">{hexPreview(a, item.start, item.end, 4)}</span>
          <span className="compare-arrow" aria-label="becomes"> → </span>
          <span className="compare-b">{hexPreview(b, item.start, item.end, 4)}</span>
        </span>
      )}
    </div>
  )
}

/**
 * Windowed list of differing ranges. Arrow keys, Page Up/Down and Home/End
 * move the selection while the list has focus.
 */
function RangeList({ stats, ranges, version, revision, activeIndex, a, b, digits, onActivate }) {
  const count = itemCount(stats, ranges)
  const scrollRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const height = Math.min(MAX_HEIGHT, count * ROW)

  useEffect(() => {
    const element = scrollRef.current
    if (!element || activeIndex < 0) return
    const top = activeIndex * ROW
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW - element.clientHeight
  }, [activeIndex])

  if (count === 0) return null

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN)
  const last = Math.min(count, Math.ceil((scrollTop + height) / ROW) + OVERSCAN)
  const rows = []
  for (let index = first; index < last; index++) {
    const item = itemAt(stats, ranges, index)
    if (!item) continue
    rows.push(
      <Row
        key={index}
        item={item}
        index={index}
        top={index * ROW}
        selected={index === activeIndex}
        a={a}
        b={b}
        digits={digits}
        onActivate={onActivate}
      />
    )
  }

  const onKeyDown = (event) => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: PAGE, PageUp: -PAGE }[event.key]
    let next = null
    if (step) next = Math.min(count - 1, Math.max(0, (activeIndex < 0 ? -1 : activeIndex) + step))
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    if (next === null) return
    event.preventDefault()
    onActivate(next)
  }

  return (
    <div
      ref={scrollRef}
      className="compare-list"
      role="listbox"
      tabIndex={0}
      aria-label={`Differences, ${plural(count, 'item')}`}
      aria-activedescendant={activeIndex >= 0 && activeIndex >= first && activeIndex < last ? `compare-item-${activeIndex}` : undefined}
      style={{ height }}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      data-version={version}
      data-revision={revision}
    >
      <div className="compare-list-inner" style={{ height: count * ROW }}>{rows}</div>
    </div>
  )
}

export default memo(RangeList)
