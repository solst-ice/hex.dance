/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useLayoutEffect, useRef, useState } from 'react'

const ROW_PX = 24
const VISIBLE_ROWS = 10
const OVERSCAN = 4
// Element heights beyond a few million pixels misbehave in some browsers,
// so very long lists scroll through a scaled-down spacer
const MAX_SCROLL_PX = 3000000

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

function hexPreview(bytes, start, length) {
  const n = Math.min(length, 8, bytes.length - start)
  let text = ''
  for (let i = 0; i < n; i++) text += (i ? ' ' : '') + HEX[bytes[start + i]]
  return length > n ? `${text} …` : text
}

function textPreview(bytes, start) {
  let text = ''
  const end = Math.min(bytes.length, start + 16)
  for (let i = start; i < end; i++) {
    const b = bytes[i]
    text += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·'
  }
  return text
}

function renderRows({ bytes, offsets, kinds, patterns, current, onPick, first, last, shift }) {
  const showLabel = patterns.length > 1
  const rows = []
  for (let i = first; i < last; i++) {
    const offset = offsets[i]
    const pattern = patterns[kinds[i]]
    rows.push(
      <button
        key={i}
        type="button"
        className={`search-row${i === current ? ' is-current' : ''}`}
        style={{ top: i * ROW_PX + shift }}
        onClick={() => onPick(i)}
        aria-current={i === current ? 'true' : undefined}
      >
        <span className="search-row-offset">{`0x${offset.toString(16).padStart(8, '0')}`}</span>
        {showLabel && <span className="search-row-kind">{pattern.label}</span>}
        <span className="search-row-hex">{hexPreview(bytes, offset, pattern.values.length)}</span>
        <span className="search-row-text">{textPreview(bytes, offset)}</span>
      </button>
    )
  }
  return rows
}

/**
 * Windowed list of matches.
 * @param {{ bytes: Uint8Array, offsets: Float64Array, kinds: Uint8Array, count: number,
 *   patterns: import('./pattern.js').Pattern[], current: number, scrollKey: number,
 *   onPick: (index: number) => void, revision: number }} props
 */
function ResultList({ bytes, offsets, kinds, count, patterns, current, scrollKey, onPick }) {
  const scrollRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)

  const viewHeight = Math.min(count, VISIBLE_ROWS) * ROW_PX
  const fullHeight = count * ROW_PX
  const spacerHeight = Math.min(fullHeight, MAX_SCROLL_PX)
  const scale = spacerHeight > viewHeight ? (fullHeight - viewHeight) / (spacerHeight - viewHeight) : 1
  const virtualTop = scrollTop * scale

  // Bring the current match into view when stepping with Next / Previous
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || current < 0) return
    const rowTop = current * ROW_PX
    if (rowTop >= virtualTop && rowTop + ROW_PX <= virtualTop + viewHeight) return
    const target = Math.max(0, rowTop - viewHeight / 2 + ROW_PX / 2) / scale
    element.scrollTop = target
    setScrollTop(element.scrollTop)
    // Only when the caller asks (scrollKey), not on every scroll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey])

  const first = Math.max(0, Math.floor(virtualTop / ROW_PX) - OVERSCAN)
  const last = Math.min(count, Math.ceil((virtualTop + viewHeight) / ROW_PX) + OVERSCAN)
  const rows = renderRows({ bytes, offsets, kinds, patterns, current, onPick, first, last, shift: scrollTop - virtualTop })

  return (
    <div
      ref={scrollRef}
      className="search-list"
      style={{ height: viewHeight }}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      role="group"
      aria-label={`${count.toLocaleString()} matches`}
    >
      <div className="search-list-spacer" style={{ height: spacerHeight }}>
        {rows}
      </div>
    </div>
  )
}

export default memo(ResultList)
