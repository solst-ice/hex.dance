/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo } from 'react'
import { HEX, CHAR, CLASS_NAME, formatOffset } from './bytes'
import { GROUP_SIZE } from './layout'

// One row of the dump. Rows are memoised and keyed by row index, so scrolling
// only renders rows that come into view, and an edit only re-renders its row
// (`rev` changes). Hover is applied to the DOM directly and never renders here.
function HexRow({ row, bytesPerRow, bytes, size, log, selFrom, selTo, cursorCol, column, nibble, segments, flash }) {
  const start = row * bytesPerRow
  const count = Math.min(bytesPerRow, size - start)
  const hexCells = new Array(count)
  const textCells = new Array(count)
  const checkModified = log.modifiedCount > 0
  let seg = 0

  for (let i = 0; i < count; i++) {
    const offset = start + i
    const v = bytes[offset]
    let cls = CLASS_NAME[v]
    if (i >= selFrom && i < selTo) cls += ' is-sel'
    if (checkModified && log.isModified(offset)) cls += ' is-mod'
    let style
    while (seg < segments.length && segments[seg].end <= offset) seg++
    if (seg < segments.length && segments[seg].start <= offset) {
      cls += ' is-hl'
      const color = segments[seg].highlight.color
      if (color) style = { '--hx-hl': color }
    }
    if (i > 0 && i % GROUP_SIZE === 0) cls += ' g'
    let hexCls = 'hx-cell ' + cls
    let textCls = 'hx-cell ' + cls
    if (i === cursorCol) {
      hexCls += column === 'hex' ? ' is-cur is-active' + (nibble ? ' is-nib' : '') : ' is-cur'
      textCls += column === 'text' ? ' is-cur is-active' : ' is-cur'
    }
    hexCells[i] = <span key={i} className={hexCls} style={style} data-offset={offset}>{HEX[v]}</span>
    textCells[i] = <span key={i} className={textCls} style={style} data-offset={offset}>{CHAR[v]}</span>
  }

  let cls = 'hx-row'
  if (flash) cls += flash % 2 ? ' is-flash-a' : ' is-flash-b'
  return (
    <div className={cls} data-offset={start}>
      <span className="hx-off">{formatOffset(start)}</span>
      <span className="hx-hex">{hexCells}</span>
      <span className="hx-text">{textCells}</span>
    </div>
  )
}

function sameSegments(a, b) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function equal(prev, next) {
  for (const key in next) {
    if (key === 'segments') {
      if (!sameSegments(prev.segments, next.segments)) return false
    } else if (prev[key] !== next[key]) {
      return false
    }
  }
  return true
}

export default memo(HexRow, equal)
