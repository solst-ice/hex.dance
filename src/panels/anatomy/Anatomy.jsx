/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFile, useHexViewport, useHighlightLayer, useSelection } from '../../state/hooks.js'
import { FIELD_KIND_ORDER, fieldKind, fieldKindColor, fieldKindLabel, regionKind, regionKindLabel } from '../structure/kinds.js'
import { buildTreeIndex, collectLeaves, formatLength, formatOffset, leavesIn } from '../structure/treeModel.js'
import { buildSegments, layoutSegments, offsetToX, regionsOf } from './layout.js'
import '../structure/kinds.css'
import './anatomy.css'

const MIN_SEGMENT_PX = 10
const MAX_COLOURED = 3000
// Fields are coloured around the visible rows, in blocks, so scrolling a
// little does not rebuild the highlight layer
const BLOCK = 16 * 1024
const STORAGE_KEY = 'hexdance.anatomy.colourFields'

function readSetting() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeSetting(on) {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    // Storage can be unavailable; the toggle still works for this page
  }
}

function describe(segment) {
  const range = `${formatOffset(segment.start)}–${formatOffset(segment.end - 1)}, ${formatLength(segment.end - segment.start)}`
  if (segment.count) return `${segment.name} (${segment.members.join(', ')}${segment.count > segment.members.length ? ', …' : ''}): ${range}`
  return `${segment.name}: ${range}`
}

// Marks where the selection starts; re-renders on selection changes only
function SelectionMarker({ laid }) {
  const { selection } = useSelection()
  if (!selection) return null
  const x = offsetToX(laid, selection.start)
  if (x === null) return null
  return <span className="ax-marker" style={{ left: x }} aria-hidden="true" />
}

// Tints leaf fields near the visible rows of the hex view, by kind
function FieldColours({ fields }) {
  const leaves = useMemo(() => collectLeaves(buildTreeIndex(fields)), [fields])
  const view = useHexViewport()
  const from = view ? Math.max(0, Math.floor(view.start / BLOCK) * BLOCK - 2 * BLOCK) : 0
  const to = view ? Math.ceil((view.start + view.visibleRows * view.bytesPerRow) / BLOCK) * BLOCK + 2 * BLOCK : 4 * BLOCK
  const ranges = useMemo(() => leavesIn(leaves, from, to, MAX_COLOURED).map((leaf, i) => ({
    start: leaf.start,
    end: leaf.end,
    label: leaf.name,
    color: fieldKindColor(leaf.kind),
    id: i
  })), [leaves, from, to])
  useHighlightLayer('anatomy', ranges)
  return null
}

const Segments = memo(function Segments({ laid, jumpTo, onFocus }) {
  return laid.map((item, i) => (
    <button
      key={`${item.start}-${item.end}`}
      type="button"
      className={`ax-seg ax-kind-${item.kind === 'gap' || item.kind === 'mixed' ? item.kind : regionKind(item.kind)}`}
      style={{ left: item.left, width: item.width }}
      aria-label={describe(item)}
      onMouseEnter={() => onFocus(i)}
      onFocus={() => onFocus(i)}
      onBlur={() => onFocus(null)}
      onClick={() => jumpTo(item.start, item.end - item.start)}
    />
  ))
})

function Legend({ kinds, fieldKinds }) {
  return (
    <div className="ax-legend" aria-label="Legend">
      {kinds.map(kind => (
        <span key={`r-${kind}`} className="ax-legend-item">
          <span className={`sx-kind-swatch ax-swatch ax-kind-${kind}`} aria-hidden="true" />
          {regionKindLabel(kind)}
        </span>
      ))}
      {fieldKinds.length > 0 && <span className="ax-legend-sep hd-muted">Fields in hex view:</span>}
      {fieldKinds.map(kind => (
        <span key={`f-${kind}`} className="ax-legend-item">
          <span className="sx-kind-swatch" style={{ background: fieldKindColor(kind) }} aria-hidden="true" />
          {fieldKindLabel(kind)}
        </span>
      ))}
    </div>
  )
}

function Anatomy() {
  const { analysis, bytes } = useFile()
  const { jumpTo } = useSelection()
  const barRef = useRef(null)
  const [width, setWidth] = useState(0)
  const [focus, setFocus] = useState(null)
  const [colour, setColour] = useState(readSetting)
  const [legendOpen, setLegendOpen] = useState(false)

  useLayoutEffect(() => {
    const element = barRef.current
    if (!element) return undefined
    const measure = () => setWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [analysis])

  const size = bytes ? bytes.length : 0
  const segments = useMemo(() => buildSegments(regionsOf(analysis), size), [analysis, size])
  const laid = useMemo(() => layoutSegments(segments, width, MIN_SEGMENT_PX), [segments, width])
  const regionKinds = useMemo(() => [...new Set(laid.map(item => (item.kind === 'gap' || item.kind === 'mixed' ? item.kind : regionKind(item.kind))))], [laid])
  const fieldKinds = useMemo(() => {
    if (!colour || !analysis) return []
    const present = new Set()
    const stack = [...analysis.fields]
    let seen = 0
    while (stack.length && seen++ < 20000) {
      const field = stack.pop()
      if (field.children && field.children.length) stack.push(...field.children)
      else present.add(fieldKind(field.kind))
    }
    return [...FIELD_KIND_ORDER, 'other'].filter(kind => present.has(kind))
  }, [analysis, colour])

  if (!analysis) return null
  const hasFields = analysis.fields.length > 0
  const shown = focus !== null && laid[focus] ? laid[focus] : null

  const toggleColour = () => {
    writeSetting(!colour)
    setColour(!colour)
  }

  return (
    <section className="hd-panel anatomy-panel" aria-label="File anatomy">
      <div
        ref={barRef}
        className="ax-bar"
        role="group"
        aria-label={`Map of ${laid.length} parts of the file`}
        onMouseLeave={() => setFocus(null)}
      >
        <Segments laid={laid} jumpTo={jumpTo} onFocus={setFocus} />
        <SelectionMarker laid={laid} />
      </div>
      <div className="ax-info">
        <span className="ax-title">Anatomy</span>
        <span className="ax-caption" aria-live="polite">
          {shown ? describe(shown) : `${segments.filter(s => s.kind !== 'gap').length} regions · point to see, click to jump`}
        </span>
        {hasFields && (
          <label className="ax-toggle">
            <input type="checkbox" checked={colour} onChange={toggleColour} />
            Colour fields in the hex view
          </label>
        )}
        <button
          type="button"
          className="hd-button hd-button--small ax-legend-button"
          aria-expanded={legendOpen}
          onClick={() => setLegendOpen(!legendOpen)}
        >
          Legend
        </button>
      </div>
      {legendOpen && <Legend kinds={regionKinds} fieldKinds={fieldKinds} />}
      {colour && hasFields && <FieldColours fields={analysis.fields} />}
    </section>
  )
}

export default Anatomy
