/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useLayoutEffect, useRef, useState } from 'react'
import { thumbMetrics, rowAtThumbPos } from './layout'

// A scrollbar driven by row numbers rather than pixels, so it can address
// every row of a file far taller than a browser lets an element be.
function Scrollbar({ controls, top, maxTop, visibleRows, totalRows, onScroll, onJumpStart, onJumpEnd }) {
  const trackRef = useRef(null)
  const dragRef = useRef(null)
  const [trackPx, setTrackPx] = useState(0)

  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const measure = () => setTrackPx(track.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(track)
    return () => observer.disconnect()
  }, [])

  const { size, pos } = thumbMetrics(trackPx, visibleRows, totalRows, top, maxTop)
  const disabled = maxTop <= 0

  const onPointerDown = e => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    const track = trackRef.current
    const rect = track.getBoundingClientRect()
    const onThumb = e.target.classList.contains('hx-thumb')
    let grabAt = e.clientY - rect.top - pos
    if (!onThumb) {
      // Clicking the track moves the thumb under the pointer, then drags from there
      grabAt = size / 2
      onScroll(rowAtThumbPos(e.clientY - rect.top - grabAt, trackPx, size, maxTop))
    }
    dragRef.current = { id: e.pointerId, grabAt, rectTop: rect.top }
    track.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = e => {
    const drag = dragRef.current
    if (!drag || drag.id !== e.pointerId) return
    onScroll(rowAtThumbPos(e.clientY - drag.rectTop - drag.grabAt, trackPx, size, maxTop))
  }

  const endDrag = e => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null
  }

  return (
    <div className="hx-scrollbar">
      <button type="button" className="hx-jump hx-jump-start" onClick={onJumpStart}
        aria-label="Jump to start" title="Jump to start" disabled={disabled}>▲</button>
      <div
        ref={trackRef}
        className={'hx-track' + (disabled ? ' is-disabled' : '')}
        role="scrollbar"
        aria-controls={controls}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={maxTop}
        aria-valuenow={top}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div className="hx-thumb" style={{ height: size, transform: `translateY(${pos}px)` }} />
      </div>
      <button type="button" className="hx-jump hx-jump-end" onClick={onJumpEnd}
        aria-label="Jump to end" title="Jump to end" disabled={disabled}>▼</button>
    </div>
  )
}

export default Scrollbar
