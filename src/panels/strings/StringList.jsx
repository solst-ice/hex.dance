/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CLASSES } from './classify.js'
import { UTF16LE } from './scan.js'
import { lowerBound } from './store.js'

export const ROW_HEIGHT = 24
const OVERSCAN = 8

function classNames(mask) {
  return CLASSES.filter(c => mask & c.bit).map(c => c.label)
}

function Row({ store, index, top, active, digits, id, onPick }) {
  const text = store.texts[index]
  const length = store.lengths[index]
  const utf16 = store.encodings[index] === UTF16LE
  const truncated = length > text.length
  const offset = store.offsets[index]
  const tags = classNames(store.classes[index])
  const title = [`0x${offset.toString(16).toUpperCase()}`, utf16 ? 'UTF-16LE' : 'ASCII', `${length.toLocaleString()} characters`, ...tags].join(' · ')
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      className={'strings-row' + (active ? ' is-active' : '')}
      style={{ transform: `translateY(${top}px)` }}
      title={title}
      onClick={() => onPick(index)}
    >
      <span className="strings-offset">{offset.toString(16).toUpperCase().padStart(digits, '0')}</span>
      <span className={'strings-enc' + (utf16 ? ' is-wide' : '')} aria-label={utf16 ? 'UTF-16LE' : 'ASCII'}>
        {utf16 ? 'U' : 'A'}
      </span>
      <span className="strings-text">
        {text}
        {truncated && <span className="strings-more">… +{(length - text.length).toLocaleString()}</span>}
      </span>
    </div>
  )
}

/**
 * Windowed list of strings. `list` holds the store indices to show, or is
 * null to show every string in the store. Only the rows in view are
 * rendered.
 */
function StringList({ store, list, count, version, activeIndex, onPick, onMove, resetKey, label, digits }) {
  const scrollRef = useRef(null)
  const [view, setView] = useState({ top: 0, height: 480 })
  const frame = useRef(0)

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return undefined
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight || 480 })
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => {
      observer?.disconnect()
      cancelAnimationFrame(frame.current)
    }
  }, [])

  // A new filter starts at the top
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

  const indexAt = (position) => (list ? list[position] : position)
  const positionOf = (index) => {
    if (index < 0) return -1
    if (!list) return index < count ? index : -1
    const position = lowerBound(list, index, count)
    return list[position] === index ? position : -1
  }
  const activePosition = positionOf(activeIndex)

  // Keep the active row in view when it moves by keyboard
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
    if (count === 0) return
    const page = Math.max(1, Math.floor(view.height / ROW_HEIGHT) - 1)
    const from = activePosition < 0 ? -1 : activePosition
    const target = {
      ArrowDown: from + 1,
      ArrowUp: from < 0 ? 0 : from - 1,
      PageDown: from + page,
      PageUp: from - page,
      Home: 0,
      End: count - 1
    }[event.key]
    if (target !== undefined) {
      event.preventDefault()
      onMove(indexAt(Math.max(0, Math.min(count - 1, target))))
    } else if ((event.key === 'Enter' || event.key === ' ') && activePosition >= 0) {
      event.preventDefault()
      onPick(activeIndex)
    }
  }

  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(count, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN)
  const rows = Array.from({ length: Math.max(0, last - first) }, (_, k) => {
    const position = first + k
    const index = indexAt(position)
    return (
      <Row
        key={index}
        id={`strings-row-${index}`}
        store={store}
        index={index}
        top={position * ROW_HEIGHT}
        active={index === activeIndex}
        digits={digits}
        onPick={onPick}
      />
    )
  })

  const activeRendered = activePosition >= first && activePosition < last

  return (
    <div
      ref={scrollRef}
      className="strings-list"
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={activeRendered ? `strings-row-${activeIndex}` : undefined}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      data-version={version}
    >
      <div className="strings-spacer" style={{ height: count * ROW_HEIGHT }}>
        {rows}
      </div>
    </div>
  )
}

export default memo(StringList)
