/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSelectionActions } from '../../state/hooks.js'
import { formatOffset } from '../../components/hex/bytes.js'
import { cellColors, hilbertLayout, hilbertPixels } from './stats.js'
import { cssColor, fitCanvas, rgbString, useThemeVersion } from '../../lib/canvasColors.js'
import useWidth from './useWidth.js'

const MAX_SIZE = 480
const MAX_MARKED_CELLS = 4096

const CLASS_LEGEND = [
  ['zero', '0x00'],
  ['print', 'printable text'],
  ['ctrl', 'control and whitespace'],
  ['ff', '0xFF'],
  ['high', '0x80–0xFE']
]

export default function Hilbert({ size, pass, colors, viewport }) {
  const { jumpTo } = useSelectionActions()
  const boxRef = useRef(null)
  const pixelsRef = useRef(null)
  const overlayRef = useRef(null)
  const width = useWidth(boxRef)
  const view = Math.max(0, Math.min(MAX_SIZE, width))
  const [hover, setHover] = useState(-1)
  const themeVersion = useThemeVersion()

  const layout = useMemo(() => hilbertLayout(size), [size])
  const { side, cellBytes } = layout
  const pixelOf = useMemo(() => hilbertPixels(side), [side])
  const cellAt = useMemo(() => {
    const inverse = new Uint32Array(pixelOf.length)
    for (let d = 0; d < pixelOf.length; d++) inverse[pixelOf[d]] = d
    return inverse
  }, [pixelOf])

  const cells = useMemo(() => (pass.classCounts ? cellColors(pass.classCounts, colors) : null), [pass.classCounts, colors])

  useEffect(() => {
    const canvas = pixelsRef.current
    if (!canvas || !cells || cells.length !== side * side * 4) return
    canvas.width = side
    canvas.height = side
    const ctx = canvas.getContext('2d')
    const image = ctx.createImageData(side, side)
    const data = image.data
    for (let d = 0; d < pixelOf.length; d++) {
      const p = pixelOf[d] * 4
      const c = d * 4
      data[p] = cells[c]
      data[p + 1] = cells[c + 1]
      data[p + 2] = cells[c + 2]
      data[p + 3] = cells[c + 3]
    }
    ctx.putImageData(image, 0, 0)
  }, [cells, side, pixelOf])

  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || !view) return
    const dpr = fitCanvas(canvas, view, view)
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const k = canvas.width / side
    const lw = Math.max(1, Math.round(dpr))
    const outline = (d, color) => {
      const p = pixelOf[d]
      const x = p % side
      const y = Math.floor(p / side)
      ctx.strokeStyle = color
      ctx.lineWidth = lw
      const pad = k < 4 * dpr ? 2 * lw : 0
      ctx.strokeRect(Math.round(x * k) - pad + lw / 2, Math.round(y * k) - pad + lw / 2, Math.max(lw, Math.round(k)) + 2 * pad - lw, Math.max(lw, Math.round(k)) + 2 * pad - lw)
    }
    if (viewport && viewport.end > viewport.start) {
      const first = Math.floor(viewport.start / cellBytes)
      const last = Math.min(pixelOf.length - 1, Math.floor((viewport.end - 1) / cellBytes), first + MAX_MARKED_CELLS)
      const mark = cssColor('--viz-mark', [255, 54, 171])
      if (last - first < 16) {
        for (let d = first; d <= last; d++) outline(d, rgbString(mark))
      } else {
        ctx.fillStyle = rgbString(mark, 0.6)
        for (let d = first; d <= last; d++) {
          const p = pixelOf[d]
          ctx.fillRect(Math.floor((p % side) * k), Math.floor(Math.floor(p / side) * k), Math.ceil(k), Math.ceil(k))
        }
      }
    }
    if (hover >= 0) outline(hover, rgbString(cssColor('--viz-hover', [255, 255, 255])))
  }, [view, side, pixelOf, cellBytes, viewport, hover, themeVersion])

  const cellFromEvent = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.floor((event.clientX - rect.left) / rect.width * side)
    const y = Math.floor((event.clientY - rect.top) / rect.height * side)
    if (x < 0 || y < 0 || x >= side || y >= side) return -1
    const d = cellAt[y * side + x]
    return d * cellBytes < size ? d : -1
  }

  const hoverStart = hover * cellBytes
  const hoverEnd = Math.min(size, hoverStart + cellBytes)
  return (
    <div className="viz-hilbert hd-stack">
      <div className="viz-square-box" ref={boxRef}>
        <div className="viz-canvas-wrap viz-checker" style={{ width: view, height: view }}>
          <canvas ref={pixelsRef} className="viz-pixels" style={{ width: view, height: view }} aria-hidden="true" />
          <canvas
            ref={overlayRef}
            className="viz-overlay"
            style={{ width: view, height: view }}
            role="img"
            aria-label="Hilbert curve map of the whole file, coloured by byte class"
            onPointerMove={e => setHover(cellFromEvent(e))}
            onPointerLeave={() => setHover(-1)}
            onClick={e => {
              const d = cellFromEvent(e)
              if (d >= 0) jumpTo(d * cellBytes, Math.min(cellBytes, size - d * cellBytes))
            }}
          />
        </div>
      </div>
      <p className="viz-readout" aria-live="polite">
        {hover >= 0
          ? `0x${formatOffset(hoverStart)}–0x${formatOffset(hoverEnd - 1)} (${(hoverEnd - hoverStart).toLocaleString()} bytes)`
          : `${side}×${side} cells of ${cellBytes.toLocaleString()} ${cellBytes === 1 ? 'byte' : 'bytes'}. Click a cell to select it in the hex view.`}
      </p>
      <p className="viz-note hd-muted">
        The curve folds the file into a square so that bytes close together in the file stay close together on screen:
        it starts at the top left and ends at the top right. Each cell mixes the colours of its bytes.
      </p>
      <ul className="viz-legend" aria-label="Colours">
        {CLASS_LEGEND.map(([name, label]) => (
          <li key={name}><span className={`viz-swatch viz-swatch-${name}`} aria-hidden="true" />{label}</li>
        ))}
      </ul>
    </div>
  )
}
