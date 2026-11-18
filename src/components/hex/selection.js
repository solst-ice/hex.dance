// Selections are { start, end } with `end` exclusive, or null

export function rangeBetween(anchor, cursor) {
  return { start: Math.min(anchor, cursor), end: Math.max(anchor, cursor) + 1 }
}

export function normalizeSelection(selection, size) {
  if (!selection) return null
  const start = Math.max(0, Math.floor(Number(selection.start)))
  const end = Math.min(size, Math.floor(Number(selection.end)))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { start, end }
}

export function sameSelection(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.start === b.start && a.end === b.end
}

// Columns [from, to) of a row that fall inside the selection, or null
export function clipToRow(selection, rowStart, bytesPerRow) {
  if (!selection) return null
  const from = Math.max(selection.start, rowStart) - rowStart
  const to = Math.min(selection.end, rowStart + bytesPerRow) - rowStart
  return to > from ? [from, to] : null
}

// Where an extending movement should anchor when the selection was set from
// outside (or the anchor was lost): the end of the selection away from the cursor
export function anchorFor(selection, cursor, anchor) {
  if (!selection) return anchor ?? cursor
  if (anchor != null && sameSelection(rangeBetween(anchor, cursor), selection)) return anchor
  if (cursor === selection.start) return selection.end - 1
  if (cursor === selection.end - 1) return selection.start
  return selection.start
}

// Cursor movement for the navigation keys; returns the new cursor offset
export function moveCursor(cursor, action, { bytesPerRow, size, pageRows }) {
  if (size <= 0) return 0
  const last = size - 1
  const c = Math.min(Math.max(0, cursor), last)
  const rowStart = c - (c % bytesPerRow)
  const page = Math.max(1, pageRows) * bytesPerRow
  let next
  switch (action) {
    case 'left': next = c - 1; break
    case 'right': next = c + 1; break
    case 'up': next = c - bytesPerRow; break
    case 'down': next = c + bytesPerRow; break
    case 'pageUp': next = c - page; break
    case 'pageDown': next = c + page; break
    case 'rowStart': next = rowStart; break
    case 'rowEnd': next = rowStart + bytesPerRow - 1; break
    case 'fileStart': next = 0; break
    case 'fileEnd': next = last; break
    default: next = c
  }
  if (next < 0) return action === 'up' || action === 'pageUp' ? c % bytesPerRow : 0
  return Math.min(next, last)
}

// What the hex view hands out through onSelectionChange before it comes back
// as the `selection` prop; NOT_HANDED_OUT when the last change came from elsewhere
export const NOT_HANDED_OUT = Symbol('not handed out')

// Where the cursor and anchor go when the `selection` prop changes. A
// selection the hex view made itself comes back as the very object it handed
// out, and changes nothing (null). One set elsewhere (a panel's jumpTo, or
// setSelection) puts the cursor on its first byte with the anchor on its
// last, as if it had been made in the hex view: typing then overwrites from
// the first selected byte, and the arrows and Shift+arrows carry on from
// there. Clearing it from elsewhere leaves the cursor where it is and drops
// the anchor, so the next Shift+arrow starts at the cursor.
export function followSelection(selection, handedOut, { cursor, size }) {
  if (selection === handedOut) return null
  const range = normalizeSelection(selection, size)
  if (!range) return { cursor, anchor: null }
  return { cursor: range.start, anchor: range.end - 1 }
}
