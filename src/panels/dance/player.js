// Plays a byte range as unsigned 8-bit PCM through Web Audio. Audio is
// scheduled half a second at a time a little ahead of the clock, so even a
// 100 MB file never needs one big AudioBuffer.

import { CHUNK_SECONDS, chunkLength, createTimeline, toSamples } from './pcm.js'

const LOOKAHEAD_SECONDS = 1.2
const TICK_MS = 150
const START_DELAY = 0.06

export default class BytePlayer {
  /**
   * @param {{ getBytes: () => Uint8Array|null, onEnded?: () => void }} options
   */
  constructor({ getBytes, onEnded }) {
    this.getBytes = getBytes
    this.onEnded = onEnded
    this.ctx = null
    this.sources = new Set()
    this.timeline = createTimeline()
    this.timer = null
    this.next = 0
    this.end = 0
    this.nextWhen = 0
    this.rate = 8000
    this.volume = null
    this.analyser = null
  }

  get state() {
    if (!this.ctx) return 'stopped'
    return this.ctx.state === 'running' ? 'playing' : 'paused'
  }

  /** Must be called from a user gesture the first time, so the browser lets audio start. */
  async start({ start, end, rate, volume }) {
    if (!this.ctx) this.createGraph(volume)
    this.setVolume(volume)
    this.seek(start, end, rate)
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  createGraph(volume) {
    const Context = window.AudioContext || window.webkitAudioContext
    const ctx = new Context({ latencyHint: 'playback' })
    // Bytes are rarely centred on 0x80; the high-pass removes the DC offset
    // so starting and stopping does not thump
    const highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 20
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.6
    const gain = ctx.createGain()
    gain.gain.value = volume
    // Limiter: random bytes are full-scale noise, so cap the loudness
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -18
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.15
    highpass.connect(analyser)
    analyser.connect(gain)
    gain.connect(limiter)
    limiter.connect(ctx.destination)
    this.ctx = ctx
    this.input = highpass
    this.analyser = analyser
    this.gain = gain
  }

  /** Restarts playback at `offset`, for example after a rate change. */
  seek(offset, end, rate) {
    if (!this.ctx) return
    this.stopSources()
    this.timeline.clear()
    this.next = offset
    this.end = end
    this.rate = rate
    this.nextWhen = this.ctx.currentTime + START_DELAY
    this.fill()
    clearInterval(this.timer)
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  fill() {
    const bytes = this.getBytes()
    if (!bytes || !this.ctx) return
    const end = Math.min(this.end, bytes.length)
    const horizon = this.ctx.currentTime + LOOKAHEAD_SECONDS
    const per = chunkLength(this.rate)
    while (this.next < end && this.nextWhen < horizon) {
      const length = Math.min(per, end - this.next)
      const buffer = this.ctx.createBuffer(1, length, this.rate)
      toSamples(bytes, this.next, this.next + length, buffer.getChannelData(0))
      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      source.connect(this.input)
      source.onended = () => {
        source.disconnect()
        this.sources.delete(source)
      }
      source.start(this.nextWhen)
      this.sources.add(source)
      this.timeline.add(this.nextWhen, this.next, length, this.rate)
      this.next += length
      this.nextWhen += length / this.rate
    }
  }

  tick() {
    if (!this.ctx || this.ctx.state !== 'running') return
    this.timeline.prune(this.ctx.currentTime - CHUNK_SECONDS)
    this.fill()
    if (this.next >= this.end && this.ctx.currentTime >= this.timeline.endTime) {
      const onEnded = this.onEnded
      this.stop()
      onEnded?.()
    }
  }

  /** File offset being heard now, or null. */
  position() {
    if (!this.ctx) return null
    const latency = Number.isFinite(this.ctx.outputLatency) ? this.ctx.outputLatency : 0
    return this.timeline.offsetAt(this.ctx.currentTime - latency)
  }

  pause() {
    return this.ctx?.state === 'running' ? this.ctx.suspend() : Promise.resolve()
  }

  resume() {
    return this.ctx && this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve()
  }

  setVolume(volume) {
    if (!this.gain || !Number.isFinite(volume)) return
    this.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02)
  }

  stopSources() {
    for (const source of this.sources) {
      source.onended = null
      try { source.stop() } catch { /* not started yet */ }
      source.disconnect()
    }
    this.sources.clear()
  }

  /** Stops and closes the audio context; the player can be started again. */
  stop() {
    clearInterval(this.timer)
    this.timer = null
    this.stopSources()
    this.timeline.clear()
    const ctx = this.ctx
    this.ctx = null
    this.analyser = null
    this.gain = null
    this.input = null
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
  }
}
