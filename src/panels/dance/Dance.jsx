import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFile, useHexViewReader, useHighlightLayer, useSelection } from '../../state/hooks.js'
import { formatOffset } from '../../components/hex/bytes.js'
import { cssColor, fitCanvas, onThemeChange, rgbString } from '../../lib/canvasColors.js'
import BytePlayer from './player.js'
import { DEFAULT_RATE, DEFAULT_VOLUME, SAMPLE_RATES, playRange, rms, smoothLevel } from './pcm.js'
import './dance.css'

// How often the playhead highlight and the hex view scroll follow the audio
const UPDATE_MS = 33
const ROOT_CLASS = 'hd-dancing'
const ROOT_PROPERTIES = ['--dance-level', '--dance-phase']
const METER_HEIGHT = 64

function seconds(n) {
  if (!Number.isFinite(n)) return '0.0 s'
  if (n < 60) return `${n.toFixed(1)} s`
  const m = Math.floor(n / 60)
  return `${m}:${String(Math.floor(n % 60)).padStart(2, '0')}`
}

function drawMeter(canvas, samples, level, colors) {
  if (!canvas) return
  const cssWidth = canvas.clientWidth
  if (!cssWidth) return
  const dpr = fitCanvas(canvas, cssWidth, METER_HEIGHT)
  const ctx = canvas.getContext('2d')
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  const barH = Math.round(6 * dpr)
  const waveH = h - barH - Math.round(4 * dpr)
  ctx.strokeStyle = colors.guide
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, Math.round(waveH / 2) + 0.5)
  ctx.lineTo(w, Math.round(waveH / 2) + 0.5)
  ctx.stroke()
  if (samples) {
    ctx.strokeStyle = colors.wave
    ctx.lineWidth = Math.max(1, dpr * 1.25)
    ctx.beginPath()
    const n = samples.length
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1) * w
      const y = (0.5 - samples[i] * 0.48) * waveH
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    }
    ctx.stroke()
  }
  ctx.fillStyle = colors.track
  ctx.fillRect(0, h - barH, w, barH)
  ctx.fillStyle = colors.level
  ctx.fillRect(0, h - barH, Math.round(w * Math.min(1, level)), barH)
}

function meterColors() {
  const wave = cssColor('--dance-wave', [0, 255, 255])
  return {
    wave: rgbString(wave),
    level: rgbString(cssColor('--dance-glow', [255, 54, 171])),
    track: rgbString(wave, 0.12),
    guide: rgbString(wave, 0.2)
  }
}

function clearRoot() {
  const root = document.documentElement
  root.classList.remove(ROOT_CLASS)
  for (const name of ROOT_PROPERTIES) root.style.removeProperty(name)
}

function Dance() {
  const { bytes } = useFile()
  const { selection, hexApiRef } = useSelection()
  const hexView = useHexViewReader()
  const [status, setStatus] = useState('stopped')
  const [rate, setRate] = useState(DEFAULT_RATE)
  const [volume, setVolume] = useState(DEFAULT_VOLUME)
  const [follow, setFollow] = useState(true)
  const [range, setRange] = useState(null)
  const [playhead, setPlayhead] = useState(null)
  const [message, setMessage] = useState(null)
  const playerRef = useRef(null)
  const meterRef = useRef(null)
  const meterIdleRef = useRef(false)
  const live = useRef(null)
  live.current = { follow, range, bytes }

  const stop = useCallback((note = null) => {
    playerRef.current?.stop()
    setStatus('stopped')
    setPlayhead(null)
    setMessage(note)
    clearRoot()
  }, [])

  // Stop on unmount (tab switch), on a new file, and when the page is hidden
  useEffect(() => () => stop(), [bytes, stop])
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && playerRef.current?.state !== 'stopped') stop('Stopped because the page was hidden.')
    }
    const onPageHide = () => stop()
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [stop])

  const getPlayer = () => {
    if (!playerRef.current) {
      playerRef.current = new BytePlayer({
        getBytes: () => live.current.bytes,
        onEnded: () => {
          setStatus('stopped')
          setPlayhead(null)
          setMessage('Reached the end.')
          clearRoot()
        }
      })
    }
    return playerRef.current
  }

  const play = () => {
    if (!bytes || !bytes.length) return
    const player = getPlayer()
    if (status === 'paused') {
      player.resume().then(() => setStatus('playing'), err => setMessage(`Could not resume audio: ${err.message || err}`))
      return
    }
    const next = playRange(selection, hexView.getCursor() ?? 0, bytes.length)
    if (!next) return
    setRange(next)
    setMessage(null)
    setStatus('playing')
    player.start({ ...next, rate, volume }).catch(err => {
      stop(`This browser could not start audio: ${err.message || err}`)
    })
  }

  const pause = () => {
    playerRef.current?.pause()
    setStatus('paused')
  }

  const changeRate = (value) => {
    setRate(value)
    const player = playerRef.current
    if (player && player.state !== 'stopped' && range) {
      const position = player.position() ?? range.start
      player.seek(position, range.end, value)
    }
  }

  const changeVolume = (value) => {
    setVolume(value)
    playerRef.current?.setVolume(value)
  }

  // Animation loop: level, sway phase and meter every frame; playhead and
  // follow-scrolling a little less often
  useEffect(() => {
    if (status === 'stopped') return
    const root = document.documentElement
    root.classList.add(ROOT_CLASS)
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let colors = meterColors()
    const stopThemeWatch = onThemeChange(() => { colors = meterColors() })
    let samples = null
    let raf = 0
    let last = performance.now()
    let lastUpdate = 0
    let lastPosition = null
    let level = 0
    let phase = 0

    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const player = playerRef.current
      const playing = player?.state === 'playing'
      let target = 0
      if (playing && player.analyser) {
        if (!samples || samples.length !== player.analyser.fftSize) samples = new Float32Array(player.analyser.fftSize)
        player.analyser.getFloatTimeDomainData(samples)
        target = Math.min(1, rms(samples) * 1.5)
      }
      level = smoothLevel(level, target, dt)
      if (!reduceMotion?.matches) phase = (phase + dt * (2.2 + 7 * level)) % (Math.PI * 2000)
      root.style.setProperty('--dance-level', level.toFixed(3))
      root.style.setProperty('--dance-phase', `${phase.toFixed(3)}rad`)
      drawMeter(meterRef.current, playing ? samples : null, level, colors)

      if (playing && now - lastUpdate >= UPDATE_MS) {
        lastUpdate = now
        const position = player.position()
        if (position !== null) {
          const { range: current, follow: following } = live.current
          const from = lastPosition !== null && lastPosition <= position ? lastPosition : position
          setPlayhead({ from: Math.max(current?.start ?? 0, from), position })
          if (following) {
            const view = hexView.getViewport()
            if (view) {
              const top = view.start / view.bytesPerRow
              const row = Math.floor(position / view.bytesPerRow)
              if (row < top || row > top + view.visibleRows - 3) hexApiRef.current?.scrollToOffset?.(position)
            }
          }
        }
        lastPosition = position
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    const meter = meterRef.current
    return () => {
      cancelAnimationFrame(raf)
      stopThemeWatch()
      drawMeter(meter, null, 0, colors)
      meterIdleRef.current = true
    }
  }, [status, hexApiRef, hexView])

  useEffect(() => {
    if (status === 'stopped') clearRoot()
  }, [status])

  // The resting meter left after playback follows the theme too
  useEffect(() => onThemeChange(() => {
    if (meterIdleRef.current && status === 'stopped') drawMeter(meterRef.current, null, 0, meterColors())
  }), [status])

  const highlights = useMemo(() => {
    if (!playhead || status === 'stopped') return null
    const layers = [{ id: 'head', start: playhead.position, end: playhead.position + 1, label: 'Playing', color: 'var(--dance-playhead)' }]
    if (playhead.from < playhead.position) {
      layers.push({ id: 'trail', start: playhead.from, end: playhead.position, label: 'Just played', color: 'var(--dance-trail)' })
    }
    return layers
  }, [playhead, status])
  useHighlightLayer('dance', highlights)

  if (!bytes) return <section className="hd-panel"><p className="hd-empty">Reading file…</p></section>

  const preview = playRange(selection, null, bytes.length)
  const active = status !== 'stopped' && range
  const shown = active ? range : preview
  const elapsed = active && playhead ? (playhead.position - range.start) / rate : 0
  const total = shown ? (shown.end - shown.start) / rate : 0

  return (
    <section className="hd-panel dance-panel" data-status={status}>
      <p className="dance-intro">
        Every byte becomes one sample of sound: its value sets where the speaker cone sits.
        Text stays in a narrow band of values, so it buzzes; compressed or encrypted data uses every value evenly, so it hisses like static;
        executables have tables and padding that repeat at a fixed spacing, which you hear as rhythm or a steady tone.
      </p>

      <div className="dance-transport hd-row" role="group" aria-label="Playback">
        {status === 'playing'
          ? <button type="button" className="hd-button hd-button--active dance-pause" onClick={pause}>Pause</button>
          : <button type="button" className="hd-button dance-play" onClick={play}>{status === 'paused' ? 'Resume' : 'Play'}</button>}
        <button type="button" className="hd-button dance-stop" onClick={() => stop()} disabled={status === 'stopped'}>Stop</button>
        <label className="dance-check">
          <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />
          Follow in hex view
        </label>
      </div>

      <div className="dance-controls">
        <label className="dance-field">
          <span>Sample rate</span>
          <select className="hd-input dance-rate" value={rate} onChange={e => changeRate(Number(e.target.value))}>
            {SAMPLE_RATES.map(r => <option key={r} value={r}>{r.toLocaleString()} Hz</option>)}
          </select>
        </label>
        <label className="dance-field dance-volume">
          <span>Volume {Math.round(volume * 100)}%</span>
          <input type="range" min="0" max="1" step="0.01" value={volume} onChange={e => changeVolume(Number(e.target.value))} />
        </label>
      </div>

      <canvas ref={meterRef} className="dance-meter" style={{ height: METER_HEIGHT }} aria-hidden="true" />

      <p className="dance-position" aria-live="off" data-position={active && playhead ? playhead.position : undefined}>
        {active && playhead
          ? `0x${formatOffset(playhead.position)}  ${seconds(elapsed)} / ${seconds(total)}`
          : shown && shown.scope === 'selection'
            ? `Plays the selection: ${(shown.end - shown.start).toLocaleString()} bytes, ${seconds(total)} at ${rate.toLocaleString()} Hz`
            : `Plays from the cursor to the end; the whole file lasts ${seconds(bytes.length / rate)} at ${rate.toLocaleString()} Hz`}
      </p>
      {message && <p className="hd-muted dance-message" role="status">{message}</p>}
      <p className="dance-note hd-muted">
        Starts at the cursor, or plays just the selection. Volume starts low and a limiter caps the loudness.
        The tinted bytes in the hex view are the ones you just heard.
      </p>
    </section>
  )
}

export default Dance
