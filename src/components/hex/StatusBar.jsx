/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useSyncExternalStore } from 'react'
import { describeByte, formatOffset } from './bytes'
import { highlightAt } from './highlights'

const hex = n => '0x' + formatOffset(n)

// Shows the hovered byte, or the cursor byte when nothing is hovered. It
// subscribes to the hover store itself so pointer movement renders only this.
function StatusBar({ id, hover, bytes, size, cursor, selection, highlightIndex, modifiedCount, notice }) {
  const hovered = useSyncExternalStore(hover.subscribe, hover.get)
  const offset = hovered != null && hovered < size ? hovered : cursor
  const hasByte = size > 0 && offset < size
  const info = hasByte ? describeByte(bytes[offset]) : null
  const label = hasByte ? highlightAt(highlightIndex, offset)?.label : null

  return (
    <div className="hx-status" id={id}>
      <span className="hx-status-byte" data-status="byte" data-offset={hasByte ? offset : undefined}>
        {hasByte ? (
          <>
            <span className="hx-k">{hovered != null ? 'at' : 'cursor'}</span>
            <span className="hx-v">{hex(offset)}</span>
            <span className="hx-d">{offset}</span>
            <span className="hx-sep">│</span>
            <span className="hx-v">{info.hex}</span>
            <span className="hx-d">{info.dec}</span>
            <span className="hx-d">{info.bin}</span>
            <span className="hx-v">{info.char}</span>
            {label && <span className="hx-label" data-status="label">{label}</span>}
          </>
        ) : (
          <span className="hx-k">{size} bytes</span>
        )}
      </span>
      {selection && (
        <span className="hx-status-sel" data-status="selection"
          data-start={selection.start} data-end={selection.end}>
          <span className="hx-k">sel</span>
          <span className="hx-v">{hex(selection.start)}–{hex(selection.end - 1)}</span>
          <span className="hx-d">{selection.end - selection.start} {selection.end - selection.start === 1 ? 'byte' : 'bytes'}</span>
        </span>
      )}
      {notice && <span className="hx-notice" data-status="notice" role="status">{notice}</span>}
      {modifiedCount > 0 && (
        <span className="hx-status-mod" data-status="modified" data-count={modifiedCount}>
          {modifiedCount} modified
        </span>
      )}
    </div>
  )
}

export default StatusBar
