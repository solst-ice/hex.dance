/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useMemo } from 'react'
import { useHexViewport, useHighlightLayer } from '../../state/hooks.js'
import { hasTail, highlightWindow } from './items.js'

const COLOR = 'var(--hd-compare-diff)'

/**
 * Tints the differing ranges in the hex view: all of them when there are few,
 * otherwise the ones nearest the visible rows. Renders nothing; kept apart so
 * scrolling and selection changes re-render only this.
 */
export default function HighlightLayer({ comparison }) {
  // Offset of the hex view's top row
  const offset = useHexViewport()?.start ?? 0
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
