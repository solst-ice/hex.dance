/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useRef, useState } from 'react'
import { HEX } from '../../components/hex/bytes.js'
import { digraphMax } from './stats.js'
import { cssColor, fitCanvas, rampTable, rgbString, useThemeVersion } from '../../lib/canvasColors.js'
import useWidth from './useWidth.js'

const MAX_SIZE = 480

function charOf(v) {
  return v > 0x20 && v < 0x7f ? ` '${String.fromCharCode(v)}'` : ''
}

export default function Digraph({ pass }) {
  const boxRef = useRef(null)
  const pixelsRef = useRef(null)
  const overlayRef = useRef(null)
  const width = useWidth(boxRef)
  const side = Math.max(0, Math.min(MAX_SIZE, width))
  const [hover, setHover] = useState(null)
  const themeVersion = useThemeVersion()
  const { digraph } = pass

  useEffect(() => {
    const canvas = pixelsRef.current
    if (!canvas || !digraph) return
    const ramp = rampTable([
      cssColor('--viz-ramp-0', [6, 7, 20]),
      cssColor('--viz-ramp-1', [40, 30, 120]),
      cssColor('--viz-ramp-2', [0, 255, 255]),
      cssColor('--viz-ramp-3', [247, 247, 28])
    ])
    const max = digraphMax(digraph)
    const scale = max > 0 ? 1 / Math.log1p(max) : 0
    canvas.width = 256
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    const image = ctx.createImageData(256, 256)
    const data = image.data
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const count = digraph[(x << 8) | y]
        const o = (y * 256 + x) * 4
        // Any pair seen at least once is visibly above the background
        const level = count ? 24 + Math.round(231 * Math.log1p(count) * scale) : 0
        data[o] = ramp[level * 3]
        data[o + 1] = ramp[level * 3 + 1]
        data[o + 2] = ramp[level * 3 + 2]
        data[o + 3] = 255
      }
    }
    ctx.putImageData(image, 0, 0)
  }, [digraph, themeVersion])

  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || !side) return
    const dpr = fitCanvas(canvas, side, side)
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const k = canvas.width / 256
    // Printable ASCII box
    ctx.setLineDash([4 * dpr, 3 * dpr])
    ctx.lineWidth = Math.max(1, Math.round(dpr))
    ctx.strokeStyle = rgbString(cssColor('--viz-guide', [255, 255, 255]), 0.45)
    ctx.strokeRect(Math.round(0x20 * k), Math.round(0x20 * k), Math.round(0x5f * k), Math.round(0x5f * k))
    ctx.setLineDash([])
    if (hover) {
      ctx.strokeStyle = rgbString(cssColor('--viz-hover', [255, 255, 255]))
      ctx.strokeRect(Math.floor(hover.x * k) - 1, Math.floor(hover.y * k) - 1, Math.ceil(k) + 2, Math.ceil(k) + 2)
    }
  }, [side, hover, themeVersion])

  const onPointerMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.floor((event.clientX - rect.left) / rect.width * 256)
    const y = Math.floor((event.clientY - rect.top) / rect.height * 256)
    setHover(x >= 0 && x < 256 && y >= 0 && y < 256 ? { x, y } : null)
  }

  const count = hover && digraph ? digraph[(hover.x << 8) | hover.y] : 0
  return (
    <div className="viz-digraph hd-stack">
      <div className="viz-square-box" ref={boxRef}>
        <div className="viz-canvas-wrap" style={{ width: side, height: side }}>
          <canvas ref={pixelsRef} className="viz-pixels" style={{ width: side, height: side }} aria-hidden="true" />
          <canvas
            ref={overlayRef}
            className="viz-overlay"
            style={{ width: side, height: side }}
            role="img"
            aria-label="Digraph: how often each byte is followed by each other byte"
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
          />
        </div>
      </div>
      <p className="viz-readout" aria-live="polite">
        {hover
          ? `0x${HEX[hover.x]}${charOf(hover.x)} then 0x${HEX[hover.y]}${charOf(hover.y)}: ${count.toLocaleString()} ${count === 1 ? 'time' : 'times'}`
          : 'Across: a byte (00 left to FF right). Down: the byte after it. Brighter means more often (log scale).'}
      </p>
      <ul className="viz-key">
        <li><strong>Text</strong> fills the dashed box (printable ASCII), brightest on letters and spaces.</li>
        <li><strong>Machine code</strong> looks like a sparse grid: bright lines on 0x00, 0xFF and a few common opcode and prefix bytes.</li>
        <li><strong>Compressed or encrypted data</strong> is an even haze over the whole square: every pair is about as likely as any other.</li>
      </ul>
    </div>
  )
}
