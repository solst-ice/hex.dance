// A view of the hex-view store that can be paused. While paused it keeps
// reporting the cursor and viewport it had when it was paused and tells its
// subscribers nothing; when it is resumed, subscribers hear about whatever
// changed in the meantime. Sections that are off screen read the hex view
// through one of these, so scrolling or moving the cursor does not
// re-render them.

/**
 * @param {ReturnType<typeof import('./hexViewStore.js').createHexViewStore>} source
 * @param {boolean} [live]   whether it starts passing changes through
 */
export function createGatedHexViewStore(source, live = true) {
  let isLive = live
  let heldCursor = source.getCursor()
  let heldViewport = source.getViewport()
  const cursorListeners = new Set()
  const viewportListeners = new Set()
  let stopCursor = null
  let stopViewport = null

  const onCursor = () => { if (isLive) cursorListeners.forEach(listener => listener()) }
  const onViewport = () => { if (isLive) viewportListeners.forEach(listener => listener()) }

  const getCursor = () => (isLive ? source.getCursor() : heldCursor)
  const getViewport = () => (isLive ? source.getViewport() : heldViewport)

  /** @param {() => void} listener */
  const subscribeCursor = (listener) => {
    cursorListeners.add(listener)
    if (!stopCursor) stopCursor = source.subscribeCursor(onCursor)
    return () => {
      cursorListeners.delete(listener)
      if (cursorListeners.size === 0 && stopCursor) {
        stopCursor()
        stopCursor = null
      }
    }
  }

  /** @param {() => void} listener */
  const subscribeViewport = (listener) => {
    viewportListeners.add(listener)
    if (!stopViewport) stopViewport = source.subscribeViewport(onViewport)
    return () => {
      viewportListeners.delete(listener)
      if (viewportListeners.size === 0 && stopViewport) {
        stopViewport()
        stopViewport = null
      }
    }
  }

  /** @param {boolean} next */
  const setLive = (next) => {
    if (Boolean(next) === isLive) return
    if (!next) {
      heldCursor = source.getCursor()
      heldViewport = source.getViewport()
      isLive = false
      return
    }
    isLive = true
    if (source.getCursor() !== heldCursor) cursorListeners.forEach(listener => listener())
    if (source.getViewport() !== heldViewport) viewportListeners.forEach(listener => listener())
  }

  return {
    getCursor,
    getViewport,
    subscribeCursor,
    subscribeViewport,
    setLive,
    isLive: () => isLive,
    // Event handlers read the live values; the host's reporter is unchanged
    reader: source.reader,
    reporter: source.reporter,
    setCursor: source.setCursor,
    setViewport: source.setViewport
  }
}
