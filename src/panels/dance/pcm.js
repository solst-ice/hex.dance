// Bytes as unsigned 8-bit PCM, and the bookkeeping that maps audio time back
// to file offsets. No Web Audio here, so it can be tested in Node.

export const SAMPLE_RATES = [8000, 11025, 22050, 44100]
export const DEFAULT_RATE = 8000
export const DEFAULT_VOLUME = 0.15
// Audio is scheduled in buffers of this length, never the whole file at once
export const CHUNK_SECONDS = 0.5

/** Unsigned 8-bit samples to floats in [-1, 1): 0x80 is silence. */
export function toSamples(bytes, start, end, out = new Float32Array(Math.max(0, end - start))) {
  for (let i = start, j = 0; i < end; i++, j++) out[j] = (bytes[i] - 128) / 128
  return out
}

/**
 * What to play: a selection longer than one byte plays just the selection;
 * otherwise from the cursor (or the selection start) to the end of the file.
 *
 * @returns {{ start: number, end: number, scope: 'selection'|'cursor' } | null}
 */
export function playRange(selection, cursor, size) {
  if (!(size > 0)) return null
  if (selection && selection.end - selection.start > 1) {
    const start = Math.max(0, Math.min(size - 1, selection.start))
    return { start, end: Math.max(start + 1, Math.min(size, selection.end)), scope: 'selection' }
  }
  const from = selection ? selection.start : cursor
  const start = Number.isFinite(from) ? Math.max(0, Math.min(size - 1, Math.floor(from))) : 0
  return { start, end: size, scope: 'cursor' }
}

/** Number of bytes in one scheduled chunk at this rate. */
export function chunkLength(rate) {
  return Math.max(1, Math.round(rate * CHUNK_SECONDS))
}

/**
 * Keeps the list of scheduled chunks and answers "which byte is playing at
 * audio time t". Segments are appended in time order.
 */
export function createTimeline() {
  let segments = []
  return {
    add(when, offset, length, rate) {
      segments.push({ when, offset, length, rate })
    },
    clear() {
      segments = []
    },
    /** Drops segments that finished before `time`, keeping the last one. */
    prune(time) {
      let i = 0
      while (i < segments.length - 1 && segments[i].when + segments[i].length / segments[i].rate < time) i++
      if (i) segments = segments.slice(i)
    },
    /** File offset playing at `time`, or null before the first segment or after the last. */
    offsetAt(time) {
      for (const s of segments) {
        const t = time - s.when
        if (t < 0) return s === segments[0] ? null : s.offset
        const index = Math.floor(t * s.rate)
        if (index < s.length) return s.offset + index
      }
      return null
    },
    /** Audio time at which everything scheduled has played. */
    get endTime() {
      const last = segments[segments.length - 1]
      return last ? last.when + last.length / last.rate : 0
    },
    get size() {
      return segments.length
    }
  }
}

/** Root-mean-square level of a block of samples. */
export function rms(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}

/** Fast attack, slow release, so the dance follows hits but does not flicker. */
export function smoothLevel(previous, target, dt) {
  const tau = target > previous ? 0.03 : 0.25
  const k = 1 - Math.exp(-Math.max(0, dt) / tau)
  return previous + (target - previous) * k
}
