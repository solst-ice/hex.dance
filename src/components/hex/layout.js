// Row geometry. Everything here is O(1) in the file size: rows have a fixed
// height and a fixed number of bytes, so offset <-> row is a division.

export const BYTES_PER_ROW_CHOICES = [32, 24, 16, 8]
export const DEFAULT_BYTES_PER_ROW = 16

// Widths in character cells; hex.css lays the row out with the same numbers
export const OFFSET_CH = 8
export const OFFSET_GAP_CH = 1
export const HEX_CELL_CH = 3
export const GROUP_GAP_CH = 1
export const GROUP_SIZE = 8
export const TEXT_GAP_CH = 2
// Scrollbar, the gap before it, the text column's border and a little slack
export const FIXED_PX = 24

export function rowChars(bytesPerRow) {
  return OFFSET_CH + OFFSET_GAP_CH +
    HEX_CELL_CH * bytesPerRow + GROUP_GAP_CH * (bytesPerRow / GROUP_SIZE - 1) +
    TEXT_GAP_CH + bytesPerRow
}

export function chooseBytesPerRow(widthPx, charPx) {
  if (!(widthPx > 0) || !(charPx > 0)) return DEFAULT_BYTES_PER_ROW
  for (const n of BYTES_PER_ROW_CHOICES) {
    if (rowChars(n) * charPx + FIXED_PX <= widthPx) return n
  }
  return BYTES_PER_ROW_CHOICES[BYTES_PER_ROW_CHOICES.length - 1]
}

export function rowCount(size, bytesPerRow) {
  return size > 0 ? Math.ceil(size / bytesPerRow) : 0
}

export function maxTopRow(totalRows, visibleRows) {
  return Math.max(0, totalRows - Math.max(1, visibleRows))
}

export function clampRow(row, maxTop) {
  if (!Number.isFinite(row)) return 0
  return Math.min(Math.max(0, Math.floor(row)), maxTop)
}

export function rowOf(offset, bytesPerRow) {
  return Math.floor(offset / bytesPerRow)
}

// Smallest scroll that brings `row` into the window
export function ensureVisible(row, top, visibleRows) {
  if (row < top) return row
  if (row >= top + visibleRows) return row - visibleRows + 1
  return top
}

// Keep the view if the row is already well inside it, otherwise put the row
// a third of the way down
export function comfortableTop(row, top, visibleRows) {
  const margin = Math.min(2, Math.floor((visibleRows - 1) / 2))
  if (row >= top + margin && row <= top + visibleRows - 1 - margin) return top
  return row - Math.floor(visibleRows / 3)
}

// Wheel delta in pixels, whatever unit the browser reported
export function wheelPixels(delta, deltaMode, rowPx, pageRows) {
  if (deltaMode === 1) return delta * rowPx
  if (deltaMode === 2) return delta * Math.max(1, pageRows) * rowPx
  return delta
}

export const MIN_THUMB_PX = 28

export function thumbMetrics(trackPx, visibleRows, totalRows, top, maxTop) {
  if (!(trackPx > 0)) return { size: 0, pos: 0 }
  const size = totalRows <= visibleRows
    ? trackPx
    : Math.min(trackPx, Math.max(MIN_THUMB_PX, Math.round(trackPx * visibleRows / totalRows)))
  const travel = trackPx - size
  const pos = maxTop > 0 ? travel * Math.min(1, top / maxTop) : 0
  return { size, pos }
}

export function rowAtThumbPos(pos, trackPx, thumbPx, maxTop) {
  const travel = trackPx - thumbPx
  if (!(travel > 0) || maxTop <= 0) return 0
  const t = Math.min(1, Math.max(0, pos / travel))
  return Math.round(t * maxTop)
}
