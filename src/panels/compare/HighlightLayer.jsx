/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useMemo, useState } from 'react'
import { useHighlightLayer } from '../../state/hooks.js'
import { hasTail, highlightWindow } from './items.js'

const COLOR = 'var(--hd-compare-diff)'

// Offset of the hex view's top row, read from its DOM attributes
function useHexTopOffset() {
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    let element = null
    let observer = null
    const read = () => {
      const top = Number(element.getAttribute('data-top-row')) || 0
      const perRow = Number(element.getAttribute('data-bytes-per-row')) || 16
      setOffset(top * perRow)
    }
    const bind = () => {
      const next = document.querySelector('section.hexview')
      if (next === element) return
      observer?.disconnect()
      observer = null
      element = next
      if (!element) return
      observer = new MutationObserver(read)
      observer.observe(element, { attributes: true, attributeFilter: ['data-top-row', 'data-bytes-per-row'] })
      read()
    }
    bind()
    const timer = setInterval(bind, 1000)
    return () => {
      clearInterval(timer)
      observer?.disconnect()
    }
  }, [])
  return offset
}

/**
 * Tints the differing ranges in the hex view: all of them when there are few,
 * otherwise the ones nearest the visible rows. Renders nothing; kept apart so
 * scrolling and selection changes re-render only this.
 */
export default function HighlightLayer({ comparison }) {
  const offset = useHexTopOffset()
  const { stats, ranges, version } = comparison
  const span = highlightWindow(ranges, offset)

  const highlights = useMemo(() => {
    const list = []
    for (let i = span.from; i < span.to; i++) {
      list.push({ id: i, start: ranges.starts[i], end: ranges.ends[i], label: 'Differs from B', color: COLOR })
    }
    if (hasTail(stats)) {
      const only = stats.sizeA > stats.sizeB ? 'A' : 'B'
      if (only === 'A') list.push({ id: 'tail', start: stats.common, end: stats.sizeA, label: 'Only in A', color: COLOR })
    }
    return list
    // version covers changes to the mutable ranges
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranges, stats, version, span.key])

  useHighlightLayer('compare', highlights)
  return null
}
