/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo } from 'react'
import { hexOffset } from './format.js'

const pct = (n, total) => `${(n / total) * 100}%`

/**
 * A slim bar over the larger file: darker where more bytes differ. The part
 * only one file has is drawn hatched. Clicking picks the nearest difference.
 */
function DiffMap({ stats, version, activeStart, activeEnd, shiftAt, onPick }) {
  const total = Math.max(stats.sizeA, stats.sizeB)
  if (total === 0) return null
  const { density, bucketSize, common } = stats
  const marks = []
  for (let i = 0; i < density.length; i++) {
    const count = density[i]
    if (!count) continue
    const start = i * bucketSize
    const size = Math.min(bucketSize, total - start)
    const opacity = 0.3 + 0.7 * Math.sqrt(Math.min(1, count / size))
    marks.push(<span key={i} className="compare-map-mark" style={{ left: pct(start, total), width: pct(size, total), opacity }} />)
  }

  const pick = (event) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (!box.width) return
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    onPick(Math.min(total - 1, Math.floor(fraction * total)))
  }

  return (
    <div className="compare-map-wrap" data-version={version}>
      <div
        className="compare-map"
        role="img"
        aria-label="Where the differences are in the file; click to jump to the nearest one"
        title="Click to jump to the nearest difference"
        onClick={pick}
      >
        {marks}
        {common < total && <span className="compare-map-tail" style={{ left: pct(common, total), width: pct(total - common, total) }} />}
        {shiftAt !== null && <span className="compare-map-shift" style={{ left: pct(shiftAt, total) }} />}
        {activeStart >= 0 && (
          <span
            className="compare-map-active"
            style={{ left: pct(activeStart, total), width: `max(2px, ${pct(activeEnd - activeStart, total)})` }}
          />
        )}
      </div>
      <div className="compare-map-scale hd-muted hd-mono" aria-hidden="true">
        <span>{hexOffset(0)}</span>
        <span>{hexOffset(total)}</span>
      </div>
    </div>
  )
}

export default memo(DiffMap)
