// The hex view's cursor and visible range, kept outside React context: they
// change on every arrow key and scroll tick, and only the components that
// subscribe to them should re-render.

/**
 * @typedef {Object} HexViewport
 * @property {number} start         first byte of the top row
 * @property {number} end           one past the last byte shown (at most the file size)
 * @property {number} bytesPerRow
 * @property {number} visibleRows   rows that fit in the view
 */

const sameViewport = (a, b) => a === b || (Boolean(a) && Boolean(b) &&
  a.start === b.start && a.end === b.end && a.bytesPerRow === b.bytesPerRow && a.visibleRows === b.visibleRows)

// Subscribers hear about changes once the hex view has finished its commit
// (a microtask later), so their renders never run inside it but still land
// in the same frame; changes made in the meantime coalesce.
const defaultSchedule = callback => queueMicrotask(callback)

/**
 * @param {{ schedule?: (callback: () => void) => void }} [options]
 *   how notifications are deferred; tests pass `callback => callback()`
 */
export function createHexViewStore({ schedule = defaultSchedule } = {}) {
  /** @type {number|null} */
  let cursor = null
  /** @type {HexViewport|null} */
  let viewport = null
  const cursorListeners = new Set()
  const viewportListeners = new Set()
  let cursorChanged = false
  let viewportChanged = false
  let scheduled = false

  const flush = () => {
    scheduled = false
    const notifyCursor = cursorChanged
    const notifyViewport = viewportChanged
    cursorChanged = false
    viewportChanged = false
    if (notifyCursor) cursorListeners.forEach(listener => listener())
    if (notifyViewport) viewportListeners.forEach(listener => listener())
  }

  const changed = () => {
    if (scheduled) return
    scheduled = true
    schedule(flush)
  }

  /** @returns {number|null} */
  const getCursor = () => cursor

  /** @returns {HexViewport|null} */
  const getViewport = () => viewport

  /** @param {number|null} next */
  const setCursor = (next) => {
    const value = Number.isFinite(next) ? next : null
    if (value === cursor) return
    cursor = value
    cursorChanged = true
    changed()
  }

  /** @param {HexViewport|null} next   the stored object only changes when a field does */
  const setViewport = (next) => {
    const value = next
      ? { start: next.start, end: next.end, bytesPerRow: next.bytesPerRow, visibleRows: next.visibleRows }
      : null
    if (sameViewport(value, viewport)) return
    viewport = value
    viewportChanged = true
    changed()
  }

  /** @param {() => void} listener */
  const subscribeCursor = (listener) => {
    cursorListeners.add(listener)
    return () => cursorListeners.delete(listener)
  }

  /** @param {() => void} listener */
  const subscribeViewport = (listener) => {
    viewportListeners.add(listener)
    return () => viewportListeners.delete(listener)
  }

  return {
    getCursor,
    getViewport,
    subscribeCursor,
    subscribeViewport,
    setCursor,
    setViewport,
    // Stable read-only and write-only halves, handed out by the hooks
    reader: { getCursor, getViewport },
    reporter: { setCursor, setViewport }
  }
}
