/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useRef } from 'react'
import useReducedMotion from './useReducedMotion'

const GLYPHS = 'ｦｱｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝabcdefghijklmnopqrstuvwxyz0123456789+=｢｣･ｯｭｬ'.split('')
const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0').toUpperCase())

const FONT_SIZE = 14
const FRAME_MS = 1000 / 30
const TRAIL = 8
// Rows per second
const MIN_SPEED = 4
const MAX_SPEED = 9
const SPAWN_PER_SECOND = 0.35
// Frames of fading after the last drop has left, so trails do not freeze
const FADE_FRAMES = 30

const randomSpeed = () => MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED)

function readColors(element) {
  const style = getComputedStyle(element)
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback
  return {
    rain: read('--rain-color', '#0ff'),
    drag: read('--rain-drag-color', '#ff36ab'),
    background: read('--darker-bg', '#060714')
  }
}

/**
 * Falling-glyph backdrop. Drops only spawn while `active`; once inactive the
 * drops on screen finish falling and the loop stops. The loop also stops
 * while the canvas is off-screen or the tab is hidden, and the canvas is not
 * rendered at all when reduced motion is requested.
 *
 * With `bytes`, each column shows a run of the file's bytes as hex pairs.
 */
function MatrixRain({ active = false, brightness = 0.3, dragging = false, bytes = null }) {
  const reducedMotion = useReducedMotion()
  const canvasRef = useRef(null)
  const settingsRef = useRef({ active, brightness, dragging, bytes })
  const wakeRef = useRef(() => {})

  useEffect(() => {
    settingsRef.current = { active, brightness, dragging, bytes }
    wakeRef.current()
  }, [active, brightness, dragging, bytes])

  useEffect(() => {
    if (reducedMotion) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0
    let height = 0
    let columns = []
    let colors = readColors(canvas)
    let frame = 0
    let lastTime = 0
    let fadeLeft = 0
    let onScreen = true
    let wasHex = false

    const isHex = () => Boolean(settingsRef.current.bytes && settingsRef.current.bytes.length)
    const spacing = () => (isHex() ? FONT_SIZE * 1.9 : FONT_SIZE * 1.2)

    const newDrop = (column) => {
      column.y = -Math.random() * TRAIL
      column.speed = randomSpeed()
      const { bytes: data } = settingsRef.current
      column.offset = data && data.length ? Math.floor(Math.random() * data.length) : 0
    }

    const layout = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      wasHex = isHex()
      const count = Math.max(0, Math.floor(width / spacing()))
      columns = Array.from({ length: count }, () => ({ y: Infinity, speed: 0, offset: 0 }))
    }

    const glyphAt = (column, row) => {
      const { bytes: data } = settingsRef.current
      if (data && data.length) return HEX[data[(column.offset + row) % data.length]]
      return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
    }

    // Draws one frame; returns whether any drop is still falling
    const step = (seconds) => {
      const { active: spawning, brightness: level, dragging: drag } = settingsRef.current
      if (isHex() !== wasHex) layout()

      ctx.globalAlpha = 0.3
      ctx.fillStyle = colors.background
      ctx.fillRect(0, 0, width, height)

      ctx.font = `bold ${FONT_SIZE}px monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = drag ? colors.drag : colors.rain

      const columnWidth = spacing()
      let falling = false
      for (let i = 0; i < columns.length; i++) {
        const column = columns[i]
        if (column.y === Infinity) {
          if (spawning && Math.random() < SPAWN_PER_SECOND * seconds) newDrop(column)
          else continue
        }
        falling = true
        const x = i * columnWidth + columnWidth / 2
        const head = Math.floor(column.y)
        for (let j = 0; j < TRAIL; j++) {
          const row = head - j
          const y = row * FONT_SIZE
          if (y < -FONT_SIZE) break
          if (y > height + FONT_SIZE) continue
          ctx.globalAlpha = Math.min(1, j === 0 ? level * 2 : level * Math.pow(0.72, j))
          ctx.fillText(glyphAt(column, row), x, y)
        }
        column.y += column.speed * seconds
        // The background fill fades the trail once the head has left
        if ((head - 2) * FONT_SIZE > height) {
          if (spawning && Math.random() < 0.7) newDrop(column)
          else column.y = Infinity
        }
      }
      ctx.globalAlpha = 1
      return falling
    }

    const running = () => onScreen && !document.hidden

    const tick = (time) => {
      frame = 0
      if (!running()) return
      if (time - lastTime < FRAME_MS - 1) {
        frame = requestAnimationFrame(tick)
        return
      }
      const seconds = lastTime ? Math.min(0.1, (time - lastTime) / 1000) : FRAME_MS / 1000
      lastTime = time
      const falling = step(seconds)
      if (falling || settingsRef.current.active) {
        fadeLeft = FADE_FRAMES
      } else if (fadeLeft > 0) {
        fadeLeft--
      } else {
        ctx.clearRect(0, 0, width, height)
        lastTime = 0
        return
      }
      frame = requestAnimationFrame(tick)
    }

    const wake = () => {
      if (frame || !running()) return
      const idle = !settingsRef.current.active && fadeLeft === 0 && columns.every(column => column.y === Infinity)
      if (idle) return
      lastTime = 0
      frame = requestAnimationFrame(tick)
    }
    wakeRef.current = () => {
      fadeLeft = FADE_FRAMES
      wake()
    }

    layout()
    const resize = new ResizeObserver(() => {
      layout()
      wake()
    })
    resize.observe(canvas)
    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting
      wake()
    })
    visibility.observe(canvas)
    document.addEventListener('visibilitychange', wake)
    const theme = new MutationObserver(() => { colors = readColors(canvas) })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    wakeRef.current()
    return () => {
      wakeRef.current = () => {}
      cancelAnimationFrame(frame)
      resize.disconnect()
      visibility.disconnect()
      theme.disconnect()
      document.removeEventListener('visibilitychange', wake)
    }
  }, [reducedMotion])

  if (reducedMotion) return null
  return <canvas ref={canvasRef} className="matrix-rain" aria-hidden="true" />
}

export default MatrixRain
