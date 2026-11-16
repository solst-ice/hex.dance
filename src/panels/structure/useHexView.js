import { useEffect, useState } from 'react'
import { useFile } from '../../state/hooks.js'

// The hex view publishes its cursor and scroll position as data attributes on
// its root element; shared state only carries the selection. These hooks
// watch those attributes so panels can follow the cursor and the visible rows.

const ATTRIBUTES = ['data-cursor', 'data-top-row', 'data-bytes-per-row', 'data-visible-rows']
const RETRY_MS = 150
const MAX_RETRIES = 40

function readState(element) {
  const number = name => {
    const value = Number(element.getAttribute(name))
    return Number.isFinite(value) ? value : 0
  }
  return {
    cursor: number('data-cursor'),
    topRow: number('data-top-row'),
    bytesPerRow: Math.max(1, number('data-bytes-per-row')),
    visibleRows: Math.max(1, number('data-visible-rows'))
  }
}

const sameKeys = (keys, a, b) => Boolean(a && b) && keys.every(key => a[key] === b[key])

/**
 * Watches some of the hex view's attributes; re-renders only when one of
 * `keys` changes. Null while the hex view is not on the page or `enabled` is false.
 */
function useHexViewState(keys, enabled) {
  const { buffer } = useFile()
  const [state, setState] = useState(null)

  useEffect(() => {
    if (!enabled) return undefined
    let observer = null
    let timer = null
    let tries = 0
    const attach = () => {
      const element = document.querySelector('section.hexview')
      if (!element) {
        if (tries++ < MAX_RETRIES) timer = setTimeout(attach, RETRY_MS)
        return
      }
      const update = () => {
        if (!element.isConnected) {
          observer.disconnect()
          tries = 0
          attach()
          return
        }
        const next = readState(element)
        setState(previous => (sameKeys(keys, previous, next) ? previous : next))
      }
      observer = new MutationObserver(update)
      observer.observe(element, { attributes: true, attributeFilter: ATTRIBUTES })
      update()
    }
    attach()
    return () => {
      clearTimeout(timer)
      if (observer) observer.disconnect()
    }
  }, [buffer, enabled, keys])

  return enabled ? state : null
}

const CURSOR_KEYS = ['cursor']
const WINDOW_KEYS = ['topRow', 'bytesPerRow', 'visibleRows']

/** Offset of the hex view's cursor, or null. */
export function useHexCursor(enabled = true) {
  const state = useHexViewState(CURSOR_KEYS, enabled)
  return state ? state.cursor : null
}

/** First and last byte visible in the hex view, or null. */
export function useHexWindow(enabled = true) {
  const state = useHexViewState(WINDOW_KEYS, enabled)
  if (!state) return null
  const start = state.topRow * state.bytesPerRow
  return { start, end: start + state.visibleRows * state.bytesPerRow }
}
