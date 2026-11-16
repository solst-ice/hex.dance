/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useMemo, useRef, useState } from 'react'
import { themeColors, useThemeVersion } from '../../lib/canvasColors.js'
import { hexOffset, prepareCanvas, useBox } from './canvas.js'

const PAD_LEFT = 30
const PAD_RIGHT = 8
const PAD_TOP = 8
const PLOT_HEIGHT = 150
const STRIP_GAP = 4
const STRIP_HEIGHT = 10
const AXIS_HEIGHT = 18
const MAX_REGIONS = 4000

const COLORS = {
  line: '--entropy-line',
  fill: '--entropy-fill',
  grid: '--entropy-grid',
  text: '--entropy-text',
  view: '--entropy-view',
  viewEdge: '--entropy-view-edge',
  selection: '--entropy-selection',
  cursor: '--entropy-cursor',
  pending: '--entropy-pending',
  regionA: '--entropy-region-a',
  regionB: '--entropy-region-b',
  boundary: '--entropy-boundary'
}

function layoutFor(width, hasRegions) {
  const plot = { x: PAD_LEFT, y: PAD_TOP, w: Math.max(1, width - PAD_LEFT - PAD_RIGHT), h: PLOT_HEIGHT }
  const strip = hasRegions ? { x: plot.x, y: plot.y + plot.h + STRIP_GAP, w: plot.w, h: STRIP_HEIGHT } : null
  const axisY = (strip ? strip.y + strip.h : plot.y + plot.h) + 4
  return { plot, strip, axisY, height: axisY + AXIS_HEIGHT }
}

/** Innermost region containing `offset`. */
function regionAt(regions, offset) {
  let best = null
  for (const region of regions) {
    if (offset >= region.offset && offset < region.offset + region.length && (!best || region.length < best.length)) best = region
  }
  return best
}

function draw(canvas, box, layout, colors, { data, regions, viewport, selection, cursor }) {
  const ctx = prepareCanvas(canvas, box)
  if (!ctx) return
  const { plot, strip, axisY } = layout
  const { size, entropy, filled, points } = data
  const xOf = (offset) => plot.x + (size ? (offset / size) * plot.w : 0)
  const yOf = (bits) => plot.y + plot.h - (bits / 8) * plot.h

  ctx.font = '11px Unifont, monospace'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 1

  // Grid and y labels
  ctx.fillStyle = colors.text
  ctx.textAlign = 'right'
  for (const bits of [0, 2, 4, 6, 8]) {
    const y = Math.round(yOf(bits)) + 0.5
    ctx.strokeStyle = colors.grid
    ctx.beginPath()
    ctx.moveTo(plot.x, y)
    ctx.lineTo(plot.x + plot.w, y)
    ctx.stroke()
    if (bits % 4 === 0) ctx.fillText(String(bits), plot.x - 6, y)
  }

  // Hex view's visible range and the selection, under the data
  if (viewport && size) {
    const x0 = xOf(Math.min(size, viewport.start))
    const x1 = xOf(Math.min(size, viewport.end))
    ctx.fillStyle = colors.view
    ctx.fillRect(x0, plot.y, Math.max(2, x1 - x0), plot.h)
    // A tab above the plot keeps a narrow range easy to spot
    ctx.fillStyle = colors.viewEdge
    ctx.fillRect(Math.min(x0, plot.x + plot.w - 3), plot.y - PAD_TOP + 2, Math.max(3, x1 - x0), PAD_TOP - 3)
  }

  // Entropy: one column per pixel
  const columns = Math.max(1, Math.floor(plot.w))
  const done = Math.min(filled, points)
  if (points > 0) {
    ctx.fillStyle = colors.fill
    ctx.strokeStyle = colors.line
    ctx.beginPath()
    let started = false
    for (let c = 0; c < columns; c++) {
      const b0 = Math.floor((c / columns) * points)
      const b1 = Math.max(b0 + 1, Math.floor(((c + 1) / columns) * points))
      if (b0 >= done) break
      // The highest block in the column, so short spikes stay visible
      let hi = 0
      for (let b = b0; b < Math.min(b1, done); b++) if (entropy[b] > hi) hi = entropy[b]
      const x = plot.x + c
      const y = yOf(hi)
      ctx.fillRect(x, y, 1, plot.y + plot.h - y)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else {
        ctx.lineTo(x + 0.5, y)
      }
    }
    ctx.stroke()
    if (done < points) {
      const x = plot.x + (done / points) * plot.w
      ctx.fillStyle = colors.pending
      ctx.fillRect(x, plot.y, plot.x + plot.w - x, plot.h)
    }
  }

  if (selection && size) {
    const x0 = xOf(Math.min(size, selection.start))
    const x1 = xOf(Math.min(size, selection.end))
    ctx.fillStyle = colors.selection
    ctx.fillRect(x0, plot.y, Math.max(1, x1 - x0), plot.h)
  }

  // Region bands and boundary ticks
  if (strip && size) {
    regions.forEach((region, i) => {
      const x0 = xOf(region.offset)
      const x1 = xOf(region.offset + region.length)
      ctx.fillStyle = i % 2 ? colors.regionB : colors.regionA
      ctx.fillRect(x0, strip.y, Math.max(1, x1 - x0), strip.h)
    })
    ctx.strokeStyle = colors.boundary
    ctx.beginPath()
    let lastX = -2
    for (const region of regions) {
      const x = Math.round(xOf(region.offset)) + 0.5
      if (x - lastX < 2) continue
      lastX = x
      ctx.moveTo(x, plot.y + plot.h - 4)
      ctx.lineTo(x, strip.y + strip.h)
    }
    ctx.stroke()
  }

  // Plot frame
  ctx.strokeStyle = colors.grid
  ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1)

  // X axis: start and end offsets
  ctx.fillStyle = colors.text
  ctx.textAlign = 'left'
  ctx.fillText('0', plot.x, axisY + AXIS_HEIGHT / 2)
  ctx.textAlign = 'right'
  ctx.fillText(hexOffset(size), plot.x + plot.w, axisY + AXIS_HEIGHT / 2)

  if (cursor && size) {
    const x = Math.round(xOf(cursor.offset)) + 0.5
    ctx.strokeStyle = colors.cursor
    ctx.beginPath()
    ctx.moveTo(x, plot.y)
    ctx.lineTo(x, (strip ? strip.y + strip.h : plot.y + plot.h))
    ctx.stroke()
  }
}

/**
 * Entropy per block across the file. Hover or arrow keys inspect a block,
 * a click or Enter selects it in the hex view; a click on the region strip
 * selects the region.
 */
function EntropyGraph({ data, regions: allRegions, viewport, selection, onJump, version }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const box = useBox(wrapRef)
  const scheme = useThemeVersion()
  const [cursorBlock, setCursorBlock] = useState(-1)
  const { size, blockSize, points, entropy, filled } = data

  const regions = useMemo(() => {
    const list = (allRegions || []).filter(r => r.length > 0 && r.offset < size)
    list.sort((a, b) => a.offset - b.offset || b.length - a.length)
    return list.slice(0, MAX_REGIONS)
  }, [allRegions, size])

  const layout = layoutFor(box.width, regions.length > 0)
  const block = cursorBlock >= 0 && cursorBlock < points ? cursorBlock : -1
  const cursor = block >= 0 ? { offset: block * blockSize + Math.min(blockSize, size - block * blockSize) / 2 } : null

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || box.width === 0) return
    const colors = themeColors(canvas, COLORS)
    draw(canvas, { ...box, height: layout.height }, layout, colors, { data, regions, viewport, selection, cursor })
  })

  const blockAt = (x) => {
    if (!points) return -1
    const fraction = (x - layout.plot.x) / layout.plot.w
    return Math.max(0, Math.min(points - 1, Math.floor(fraction * (size / blockSize))))
  }

  const locate = (event) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const onPointerMove = (event) => {
    const { x } = locate(event)
    setCursorBlock(blockAt(x))
  }

  const jumpToBlock = (b) => {
    if (b < 0) return
    const start = b * blockSize
    onJump(start, Math.max(1, Math.min(blockSize, size - start)))
  }

  const onClick = (event) => {
    const { x, y } = locate(event)
    const b = blockAt(x)
    if (b < 0) return
    if (layout.strip && y >= layout.strip.y - 2) {
      const region = regionAt(regions, Math.min(size - 1, Math.floor(((x - layout.plot.x) / layout.plot.w) * size)))
      if (region) {
        onJump(region.offset, Math.max(1, Math.min(region.length, size - region.offset)))
        return
      }
    }
    jumpToBlock(b)
  }

  const onKeyDown = (event) => {
    if (!points) return
    const big = Math.max(1, Math.round(points / 20))
    const from = block < 0 ? 0 : block
    const next = {
      ArrowRight: from + (event.shiftKey ? big : 1),
      ArrowUp: from + (event.shiftKey ? big : 1),
      ArrowLeft: from - (event.shiftKey ? big : 1),
      ArrowDown: from - (event.shiftKey ? big : 1),
      PageUp: from + big,
      PageDown: from - big,
      Home: 0,
      End: points - 1
    }[event.key]
    if (next !== undefined) {
      event.preventDefault()
      setCursorBlock(Math.max(0, Math.min(points - 1, next)))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      jumpToBlock(from)
    }
  }

  const onFocus = () => {
    if (block >= 0 || !points) return
    const start = viewport ? Math.min(size - 1, viewport.start) : 0
    setCursorBlock(Math.max(0, Math.floor(start / blockSize)))
  }

  let readout = 'Hover or use the arrow keys to inspect a block; click or press Enter to select it.'
  if (block >= 0) {
    const start = block * blockSize
    const end = Math.min(size, start + blockSize)
    const value = block < filled ? `${entropy[block].toFixed(2)} bits per byte` : 'not computed yet'
    const region = regionAt(regions, start)
    readout = `${hexOffset(start)}–${hexOffset(end - 1)}: ${value}${region ? ` · ${region.name}` : ''}`
  }

  return (
    <div className="entropy-graph">
      <div
        ref={wrapRef}
        className="entropy-canvas-wrap"
        style={{ height: layout.height }}
        tabIndex={0}
        role="slider"
        aria-label="Entropy across the file"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, points - 1)}
        aria-valuenow={Math.max(0, block)}
        aria-valuetext={readout}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setCursorBlock(-1)}
        onClick={onClick}
        data-scheme={scheme}
        data-version={version}
      >
        <canvas ref={canvasRef} className="entropy-canvas" style={{ width: '100%', height: layout.height }} />
      </div>
      <p className="entropy-readout hd-mono">{readout}</p>
    </div>
  )
}

export default EntropyGraph
