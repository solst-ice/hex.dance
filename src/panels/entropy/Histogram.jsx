/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useRef, useState } from 'react'
import { byteClass, describeByte } from '../../components/hex/bytes.js'
import { themeColors, useThemeVersion } from '../../lib/canvasColors.js'
import { prepareCanvas, useBox } from './canvas.js'

const HEIGHT = 140
const PAD_TOP = 6
const PAD_BOTTOM = 16

// Bars use the hex view's byte-class colours, so both views read the same
const COLORS = {
  zero: '--hx-byte-zero',
  print: '--hx-byte-print',
  ctrl: '--hx-byte-ctrl',
  ff: '--hx-byte-ff',
  high: '--hx-byte-high',
  grid: '--entropy-grid',
  text: '--entropy-text',
  cursor: '--entropy-cursor'
}

function draw(canvas, box, colors, histogram, log, cursor) {
  const ctx = prepareCanvas(canvas, box)
  if (!ctx) return
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM
  const width = box.width
  const scale = (c) => (log ? Math.log2(1 + c) : c)
  let max = 0
  for (let b = 0; b < 256; b++) max = Math.max(max, scale(histogram[b]))
  const barW = width / 256
  for (let b = 0; b < 256; b++) {
    const c = histogram[b]
    if (!c || !max) continue
    const h = Math.max(1, (scale(c) / max) * plotH)
    ctx.fillStyle = colors[byteClass(b)]
    ctx.fillRect(b * barW, PAD_TOP + plotH - h, Math.max(1, barW - (barW > 3 ? 0.5 : 0)), h)
  }
  ctx.strokeStyle = colors.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, PAD_TOP + plotH + 0.5)
  ctx.lineTo(width, PAD_TOP + plotH + 0.5)
  ctx.stroke()
  ctx.font = '11px Unifont, monospace'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = colors.text
  for (const b of [0x00, 0x40, 0x80, 0xc0, 0xff]) {
    ctx.textAlign = b === 0 ? 'left' : b === 0xff ? 'right' : 'center'
    ctx.fillText(b.toString(16).toUpperCase().padStart(2, '0'), b === 0xff ? width : b * barW, HEIGHT - PAD_BOTTOM / 2)
  }
  if (cursor >= 0) {
    ctx.strokeStyle = colors.cursor
    ctx.strokeRect(cursor * barW + 0.5, PAD_TOP + 0.5, Math.max(1, barW - 1), plotH - 1)
  }
}

/** 256-bin byte histogram; hover or arrow keys show a value's count. */
function Histogram({ histogram, total }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const box = useBox(wrapRef)
  const scheme = useThemeVersion()
  const [log, setLog] = useState(false)
  const [cursor, setCursor] = useState(-1)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || box.width === 0) return
    draw(canvas, { ...box, height: HEIGHT }, themeColors(canvas, COLORS), histogram, log, cursor)
  }, [box, histogram, log, cursor, scheme])

  const byteAt = (event) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(255, Math.floor(((event.clientX - rect.left) / rect.width) * 256)))
  }

  const onKeyDown = (event) => {
    const from = cursor < 0 ? 0 : cursor
    const next = { ArrowRight: from + 1, ArrowUp: from + 1, ArrowLeft: from - 1, ArrowDown: from - 1, PageUp: from + 16, PageDown: from - 16, Home: 0, End: 255 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    setCursor(Math.max(0, Math.min(255, next)))
  }

  let readout = 'Hover or use the arrow keys to see how often a byte value occurs.'
  if (cursor >= 0) {
    const { hex, char } = describeByte(cursor)
    const count = histogram[cursor]
    readout = `${hex} ${char}: ${count.toLocaleString()} (${total ? ((count / total) * 100).toFixed(count && count / total < 0.001 ? 4 : 2) : 0}%)`
  }

  return (
    <div className="entropy-histogram">
      <div className="hd-row entropy-histogram-head">
        <h3 className="hd-section-title">Byte histogram</h3>
        <button
          type="button"
          className={'hd-button hd-button--small' + (log ? ' hd-button--active' : '')}
          aria-pressed={log}
          onClick={() => setLog(!log)}
        >
          Log scale
        </button>
      </div>
      <div
        ref={wrapRef}
        className="entropy-canvas-wrap"
        style={{ height: HEIGHT }}
        tabIndex={0}
        role="slider"
        aria-label="Byte value histogram"
        aria-valuemin={0}
        aria-valuemax={255}
        aria-valuenow={Math.max(0, cursor)}
        aria-valuetext={readout}
        onKeyDown={onKeyDown}
        onFocus={() => cursor < 0 && setCursor(0)}
        onPointerMove={(event) => setCursor(byteAt(event))}
        onPointerLeave={() => setCursor(-1)}
      >
        <canvas ref={canvasRef} className="entropy-canvas" style={{ width: '100%', height: HEIGHT }} />
      </div>
      <p className="entropy-readout hd-mono">{readout}</p>
    </div>
  )
}

export default Histogram
