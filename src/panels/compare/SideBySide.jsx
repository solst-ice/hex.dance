/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useEffect, useRef, useState } from 'react'

const CONTEXT_ROWS = 2
const MAX_RANGE_ROWS = 4

const toHex = (value) => value.toString(16).padStart(2, '0')
const toChar = (value) => (value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : '.')

// Bytes per row that fit the box: 16 when there is room, else 8
function useBytesPerRow(ref, digits) {
  const [perRow, setPerRow] = useState(16)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const probe = element.querySelector('.compare-sbs-probe')
    const update = () => {
      const charWidth = probe ? probe.getBoundingClientRect().width / 10 : 8
      const chars = (n) => 2 + digits + 2 + n * 3 + 1 + n
      setPerRow(element.clientWidth >= chars(16) * charWidth ? 16 : 8)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, digits])
  return perRow
}

function Line({ label, offset, values, others, focus, digits }) {
  const hex = []
  const text = []
  values.forEach((value, i) => {
    const missing = value === null
    const differs = missing || others[i] === null || value !== others[i]
    const className = `${differs ? 'is-diff' : ''}${focus[i] ? ' is-focus' : ''}${missing ? ' is-missing' : ''}`.trim() || undefined
    hex.push(<span key={i} className={className}>{missing ? '  ' : toHex(value)}</span>)
    hex.push(i < values.length - 1 ? ' ' : '')
    text.push(<span key={i} className={className}>{missing ? ' ' : toChar(value)}</span>)
  })
  return (
    <div className={`compare-sbs-line compare-sbs-${label.toLowerCase()}`}>
      <span className="compare-sbs-label">{label}</span>
      <span className="compare-sbs-offset">{offset === null ? ' '.repeat(digits) : offset.toString(16).toUpperCase().padStart(digits, '0')}</span>
      <span className="compare-sbs-hex">{hex}</span>
      <span className="compare-sbs-text">{text}</span>
    </div>
  )
}

function buildRows({ a, b, perRow, firstRow, lastRow, start, end, mapB, digits }) {
  const rows = []
  for (let row = firstRow; row <= lastRow; row++) {
    const rowStart = row * perRow
    const aValues = []
    const bValues = []
    const focus = []
    let bOffset = null
    for (let i = 0; i < perRow; i++) {
      const offset = rowStart + i
      const inB = mapB(offset)
      if (bOffset === null && inB !== null && inB >= 0) bOffset = inB - i
      aValues.push(offset < a.length ? a[offset] : null)
      bValues.push(inB !== null && inB >= 0 && inB < b.length ? b[inB] : null)
      focus.push(offset >= start && offset < end)
    }
    rows.push(
      <div key={row} className="compare-sbs-row">
        <Line label="A" offset={rowStart} values={aValues} others={bValues} focus={focus} digits={digits} />
        <Line label="B" offset={bOffset} values={bValues} others={aValues} focus={focus} digits={digits} />
      </div>
    )
  }
  return rows
}

/**
 * The rows of A and B around one difference, B's bytes under A's, with the
 * differing bytes marked. `mapB` gives the offset in B shown under an offset
 * in A (equal offsets unless the view is aligned after a shift).
 */
function SideBySide({ a, b, revision, start, end, mapB, digits }) {
  const ref = useRef(null)
  const perRow = useBytesPerRow(ref, digits)
  const size = Math.max(a.length, b.length)
  const firstRangeRow = Math.floor(start / perRow)
  const lastRangeRow = Math.min(Math.floor(Math.max(start, end - 1) / perRow), firstRangeRow + MAX_RANGE_ROWS - 1)
  const firstRow = Math.max(0, firstRangeRow - CONTEXT_ROWS)
  const lastRow = Math.min(Math.max(0, Math.ceil(size / perRow) - 1), lastRangeRow + CONTEXT_ROWS)

  const rows = buildRows({ a, b, perRow, firstRow, lastRow, start, end, mapB, digits })

  return (
    <div ref={ref} className="compare-sbs hd-mono" data-revision={revision} aria-label="Bytes of A and B around the selected difference">
      <span className="compare-sbs-probe" aria-hidden="true">0000000000</span>
      {rows}
    </div>
  )
}

export default memo(SideBySide)
