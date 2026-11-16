import { useSyncExternalStore } from 'react'

const ATTRIBUTES = ['data-top-row', 'data-visible-rows', 'data-bytes-per-row', 'data-size']

/** Byte range the hex view currently shows, read from its data attributes. */
export function readHexViewport() {
  const el = typeof document !== 'undefined' ? document.querySelector('section.hexview') : null
  if (!el) return null
  const bytesPerRow = Number(el.dataset.bytesPerRow)
  const top = Number(el.dataset.topRow)
  const rows = Number(el.dataset.visibleRows)
  const size = Number(el.dataset.size)
  if (![bytesPerRow, top, rows, size].every(Number.isFinite) || bytesPerRow <= 0) return null
  const start = Math.min(size, top * bytesPerRow)
  return { start, end: Math.min(size, start + rows * bytesPerRow), bytesPerRow, top, rows }
}

function subscribe(onChange) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ATTRIBUTES })
  return () => observer.disconnect()
}

function snapshot() {
  const viewport = readHexViewport()
  return viewport ? `${viewport.start}:${viewport.end}` : ''
}

/** Follows the hex view's visible range; returns { start, end } or null. */
export default function useHexViewport() {
  const key = useSyncExternalStore(subscribe, snapshot, () => '')
  if (!key) return null
  const [start, end] = key.split(':').map(Number)
  return { start, end }
}
