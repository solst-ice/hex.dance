/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSelection } from '../../state/hooks.js'
import { HEX, formatOffset } from '../../components/hex/bytes.js'
import { detectStride, offsetAt, overviewStrip, paintByteMap, pixelsPerRow } from './bytemap.js'
import { cssColor, fitCanvas, rgbString } from './colors.js'
import useWidth from './useWidth.js'

const STRIDES = [16, 32, 64, 128, 256, 512, 1024]
const FALLBACK_STRIDE = 64
const MAX_STRIDE = 4096
const MAP_HEIGHT = 320
const STRIP_WIDTH = 14

const MODE_LABELS = { class: 'Byte class', grey: 'Greyscale', rgb: 'RGB triples' }

function clampTop(t, stride, size, windowBytes) {
  const align = ((t % stride) + stride) % stride
  const last = Math.max(0, size - windowBytes)
  if (t < 0) return align <= last ? align : 0
  if (t <= last) return t
  return Math.max(0, align + Math.ceil((last - align) / stride) * stride)
}

// Rectangles (in map pixels) covering the bytes [a, b) on the map
function rangeRects(a, b, { top, stride, rows, mode }) {
  const rects = []
  if (b <= a) return rects
  const per = mode === 'rgb' ? 3 : 1
  const first = Math.max(0, Math.floor((a - top) / stride))
  const last = Math.min(rows - 1, Math.floor((b - 1 - top) / stride))
  for (let r = first; r <= last; r++) {
    const rowStart = top + r * stride
    const from = Math.max(a, rowStart) - rowStart
    const to = Math.min(b, rowStart + stride) - rowStart
    if (to <= from) continue
    const x0 = Math.floor(from / per)
    const x1 = Math.max(x0 + 1, Math.ceil(to / per))
    rects.push([x0, r, x1 - x0, 1])
  }
  return rects
}

export default function ByteMap({ bytes, revision, colors, viewport }) {
  const { jumpTo } = useSelection()
  const size = bytes.length
  const boxRef = useRef(null)
  const mapRef = useRef(null)
  const overlayRef = useRef(null)
  const stripRef = useRef(null)
  const width = useWidth(boxRef)

  const [choice, setChoice] = useState('auto')
  const [mode, setMode] = useState('class')
  const [top, setTop] = useState(() => (viewport ? viewport.start : 0))
  const [hover, setHover] = useState(-1)
  const [detection, setDetection] = useState(null)

  // Auto width: detect once where the map is when auto is chosen, and again on request
  const [detectAt, setDetectAt] = useState(top)
  useEffect(() => {
    if (choice !== 'auto') return
    const timer = setTimeout(() => setDetection({ at: detectAt, result: detectStride(bytes, detectAt) }), 60)
    return () => clearTimeout(timer)
  }, [choice, bytes, detectAt])

  const stride = choice === 'auto' ? (detection?.result?.stride || FALLBACK_STRIDE) : choice
  const pxPerRow = pixelsPerRow(stride, mode)
  const mapWidth = Math.max(0, width - STRIP_WIDTH - 8)
  const scale = mapWidth > 0 ? mapWidth / pxPerRow : 1
  const rows = Math.max(1, Math.min(4096, Math.floor(MAP_HEIGHT / scale)))
  const mapHeight = Math.max(1, Math.round(rows * scale))
  const windowBytes = rows * stride
  const shownTop = clampTop(top, stride, size, windowBytes)
  const geometry = useMemo(() => ({ top: shownTop, stride, rows, mode }), [shownTop, stride, rows, mode])

  // Pixels
  useEffect(() => {
    const canvas = mapRef.current
    if (!canvas || !mapWidth) return
    canvas.width = pxPerRow
    canvas.height = rows
    const ctx = canvas.getContext('2d')
    const image = ctx.createImageData(pxPerRow, rows)
    paintByteMap(image.data, bytes, { top: shownTop, stride, mode, width: pxPerRow, rows, classColors: colors })
    ctx.putImageData(image, 0, 0)
  }, [bytes, revision, shownTop, stride, mode, pxPerRow, rows, colors, mapWidth])

  // Marks: the hex view's range and the byte under the pointer
  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || !mapWidth) return
    const dpr = fitCanvas(canvas, mapWidth, mapHeight)
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const k = scale * dpr
    const box = ([x, y, w, h]) => [Math.round(x * k), Math.round(y * k), Math.max(1, Math.round((x + w) * k) - Math.round(x * k)), Math.max(1, Math.round((y + h) * k) - Math.round(y * k))]
    if (viewport) {
      const mark = cssColor('--viz-mark', [255, 54, 171])
      ctx.fillStyle = rgbString(mark, 0.28)
      ctx.strokeStyle = rgbString(mark)
      ctx.lineWidth = Math.max(1, Math.round(dpr))
      for (const rect of rangeRects(viewport.start, viewport.end, geometry)) {
        const [x, y, w, h] = box(rect)
        ctx.fillRect(x, y, w, h)
      }
      const rects = rangeRects(viewport.start, viewport.end, geometry)
      if (rects.length) {
        const [fx, fy] = box(rects[0])
        const [, ly, , lh] = box(rects[rects.length - 1])
        ctx.strokeRect(0.5 * ctx.lineWidth, fy + 0.5 * ctx.lineWidth, canvas.width - ctx.lineWidth, ly + lh - fy - ctx.lineWidth)
        ctx.fillRect(fx, fy, ctx.lineWidth * 2, Math.max(ctx.lineWidth * 2, k))
      }
    }
    if (hover >= 0) {
      const per = mode === 'rgb' ? 3 : 1
      const rect = rangeRects(hover, hover + per, geometry)[0]
      if (rect) {
        const [x, y, w, h] = box(rect)
        const lw = Math.max(1, Math.round(dpr))
        ctx.lineWidth = lw
        ctx.strokeStyle = rgbString(cssColor('--viz-hover', [255, 255, 255]))
        ctx.strokeRect(x - lw / 2, y - lw / 2, Math.max(w, lw * 3) + lw, Math.max(h, lw * 3) + lw)
      }
    }
  }, [viewport, hover, geometry, scale, mapWidth, mapHeight, mode, revision])

  // Whole-file strip beside the map
  const [stripRevision, setStripRevision] = useState(revision)
  useEffect(() => {
    if (stripRevision === revision) return
    const timer = setTimeout(() => setStripRevision(revision), 500)
    return () => clearTimeout(timer)
  }, [revision, stripRevision])
  useEffect(() => {
    const canvas = stripRef.current
    if (!canvas || !mapHeight) return
    const dpr = fitCanvas(canvas, STRIP_WIDTH, mapHeight)
    const ctx = canvas.getContext('2d')
    const lines = canvas.height
    const line = overviewStrip(bytes, lines, colors)
    const image = ctx.createImageData(canvas.width, lines)
    for (let y = 0; y < lines; y++) {
      for (let x = 0; x < canvas.width; x++) image.data.set(line.subarray(y * 4, y * 4 + 4), (y * canvas.width + x) * 4)
    }
    ctx.putImageData(image, 0, 0)
    if (!size) return
    const yOf = offset => Math.round(offset / size * lines)
    const lw = Math.max(1, Math.round(dpr))
    ctx.strokeStyle = rgbString(cssColor('--viz-hover', [255, 255, 255]))
    ctx.lineWidth = lw
    const y0 = yOf(shownTop)
    const y1 = Math.max(y0 + 2 * lw, yOf(Math.min(size, shownTop + windowBytes)))
    ctx.strokeRect(lw / 2, y0 + lw / 2, canvas.width - lw, Math.min(lines, y1) - y0 - lw)
    if (viewport) {
      ctx.fillStyle = rgbString(cssColor('--viz-mark', [255, 54, 171]))
      const v0 = yOf(viewport.start)
      ctx.fillRect(0, Math.min(lines - 2 * lw, v0), canvas.width, Math.max(2 * lw, yOf(viewport.end) - v0))
    }
  }, [bytes, stripRevision, colors, mapHeight, shownTop, windowBytes, viewport, size])

  // Wheel scrolls the map by the distance moved, not by a fixed step
  const live = useRef(null)
  live.current = { shownTop, stride, scale, size, windowBytes }
  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas) return
    const onWheel = (event) => {
      event.preventDefault()
      const L = live.current
      const px = event.deltaMode === 1 ? event.deltaY * 20 : event.deltaMode === 2 ? event.deltaY * MAP_HEIGHT : event.deltaY
      const rowsDelta = Math.sign(px) * Math.max(1, Math.round(Math.abs(px) / L.scale))
      setTop(clampTop(L.shownTop + rowsDelta * L.stride, L.stride, L.size, L.windowBytes))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  const pointerOffset = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const col = Math.floor((event.clientX - rect.left) / scale)
    const row = Math.floor((event.clientY - rect.top) / scale)
    if (col < 0 || col >= pxPerRow || row < 0 || row >= rows) return -1
    return offsetAt(shownTop, stride, mode, col, row, size)
  }

  const onKeyDown = (event) => {
    const page = Math.max(1, rows - 1) * stride
    const moves = {
      ArrowUp: -stride, ArrowDown: stride, ArrowLeft: -1, ArrowRight: 1, PageUp: -page, PageDown: page
    }
    if (event.key in moves) {
      event.preventDefault()
      setTop(clampTop(shownTop + moves[event.key], stride, size, windowBytes))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setTop(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setTop(clampTop(size, stride, size, windowBytes))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      jumpTo(shownTop, mode === 'rgb' ? 3 : 1)
    }
  }

  const stripSeek = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    const target = Math.floor(t * size) - Math.floor(windowBytes / 2)
    setTop(clampTop(Math.floor(Math.max(0, target) / stride) * stride, stride, size, windowBytes))
  }

  const showHexPosition = () => {
    if (!viewport) return
    setTop(clampTop(viewport.start - Math.floor(rows / 3) * stride, stride, size, windowBytes))
  }

  const end = Math.min(size, shownTop + windowBytes)
  const hexAbove = viewport && viewport.end <= shownTop
  const hexBelow = viewport && viewport.start >= end
  const zoomedOut = scale < 1 / (window.devicePixelRatio || 1)

  let hoverText = 'Point at the map to read a byte; click to jump there in the hex view.'
  if (hover >= 0) {
    hoverText = mode === 'rgb'
      ? `0x${formatOffset(hover)}  RGB ${HEX[bytes[hover]]} ${hover + 1 < size ? HEX[bytes[hover + 1]] : '--'} ${hover + 2 < size ? HEX[bytes[hover + 2]] : '--'}`
      : `0x${formatOffset(hover)}  = 0x${HEX[bytes[hover]]} (${bytes[hover]})`
  }

  let autoNote = null
  if (choice === 'auto') {
    autoNote = detection?.result
      ? `Auto: rows of ${detection.result.stride} bytes, where the data repeats best.`
      : detection ? `Auto: no repeating row length found here, so rows of ${FALLBACK_STRIDE} bytes.` : 'Auto: measuring…'
  }

  return (
    <div className="viz-bytemap hd-stack">
      <div className="viz-controls">
        <label className="viz-field">
          <span>Row width</span>
          <select className="hd-input" value={choice} onChange={e => setChoice(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}>
            <option value="auto">Auto</option>
            {STRIDES.includes(choice) || choice === 'auto' ? null : <option value={choice}>{choice}</option>}
            {STRIDES.map(n => <option key={n} value={n}>{n} bytes</option>)}
          </select>
        </label>
        <label className="viz-field">
          <span>Custom</span>
          <input
            className="hd-input viz-number"
            type="number"
            min="1"
            max={MAX_STRIDE}
            value={stride}
            onChange={e => {
              const n = Math.floor(Number(e.target.value))
              if (n >= 1 && n <= MAX_STRIDE) setChoice(n)
            }}
            aria-label="Row width in bytes"
          />
        </label>
        <label className="viz-field">
          <span>Colour</span>
          <select className="hd-input" value={mode} onChange={e => setMode(e.target.value)}>
            {Object.entries(MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      {autoNote && (
        <p className="viz-note hd-muted">
          {autoNote}{' '}
          <button type="button" className="hd-button hd-button--small" onClick={() => setDetectAt(shownTop)}>Detect here</button>
        </p>
      )}
      <div className="viz-bytemap-box" ref={boxRef}>
        <div className="viz-canvas-wrap" style={{ width: mapWidth, height: mapHeight }}>
          <canvas ref={mapRef} className={`viz-pixels ${zoomedOut ? 'is-reduced' : ''}`} style={{ width: mapWidth, height: mapHeight }} aria-hidden="true" />
          <canvas
            ref={overlayRef}
            className="viz-overlay"
            style={{ width: mapWidth, height: mapHeight }}
            tabIndex={0}
            role="img"
            aria-label={`Byte map from offset 0x${formatOffset(shownTop)}, ${stride} bytes per row. Arrow keys scroll, Enter jumps to the first byte shown.`}
            data-top={shownTop}
            data-stride={stride}
            onKeyDown={onKeyDown}
            onPointerMove={e => setHover(pointerOffset(e))}
            onPointerLeave={() => setHover(-1)}
            onClick={e => {
              const offset = pointerOffset(e)
              if (offset >= 0) jumpTo(offset, mode === 'rgb' ? Math.min(3, size - offset) : 1)
            }}
          />
        </div>
        <canvas
          ref={stripRef}
          className="viz-strip"
          style={{ width: STRIP_WIDTH, height: mapHeight }}
          aria-hidden="true"
          title="Whole file; click to move the map there"
          onPointerDown={e => {
            e.currentTarget.setPointerCapture?.(e.pointerId)
            stripSeek(e)
          }}
          onPointerMove={e => { if (e.buttons & 1) stripSeek(e) }}
        />
      </div>
      <p className="viz-readout" aria-live="polite">{hoverText}</p>
      <div className="viz-note hd-row">
        <span className="hd-muted">
          0x{formatOffset(shownTop)}–0x{formatOffset(Math.max(shownTop, end - 1))} ({(end - shownTop).toLocaleString()} bytes)
          {zoomedOut ? '; zoomed out, so some bytes share a screen pixel' : ''}
          {hexAbove ? '. The hex view is above this window.' : hexBelow ? '. The hex view is below this window.' : ''}
        </span>
        {viewport && (
          <button type="button" className="hd-button hd-button--small" onClick={showHexPosition}>Show hex view position</button>
        )}
      </div>
      <p className="viz-note hd-muted">
        {mode === 'rgb'
          ? 'Every 3 bytes make one pixel. Raw bitmaps snap into a picture when the row width matches the image\'s row length; some formats store rows bottom-up or as BGR, so the picture may be flipped or tinted. Left and right arrow keys shift the map by one byte.'
          : mode === 'grey'
            ? 'Each byte is one pixel, from black (0x00) to white (0xFF).'
            : 'Each byte is one pixel in the hex view\'s colours: zero, printable text, control, 0xFF and high bytes.'}
        {' '}The pink box is what the hex view shows; the strip on the right is the whole file.
      </p>
    </div>
  )
}
