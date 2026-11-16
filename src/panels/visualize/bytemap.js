// Pixels for the byte map, drawn straight from the file's bytes. Only the
// window on screen is ever touched, so this is cheap at any file size.

import { CLASS_INDEX } from './stats.js'

export const MODES = ['class', 'grey', 'rgb']

/** Pixels per row for a row stride in bytes: one per byte, or one per RGB triple. */
export function pixelsPerRow(stride, mode) {
  return mode === 'rgb' ? Math.max(1, Math.floor(stride / 3)) : stride
}

/** File offset shown at a pixel, or -1 past the end of the file. */
export function offsetAt(top, stride, mode, col, row, size) {
  const offset = top + row * stride + (mode === 'rgb' ? col * 3 : col)
  return offset >= 0 && offset < size ? offset : -1
}

/**
 * Fills `data` (RGBA, `width` x `rows`) with the bytes from `top`, each row
 * starting `stride` bytes after the previous one. Pixels past the end of the
 * file are transparent.
 *
 * @param {Array<[number, number, number]>} classColors   one RGB triple per byte class
 */
export function paintByteMap(data, bytes, { top, stride, mode, width, rows, classColors }) {
  const size = bytes.length
  data.fill(0)
  for (let r = 0; r < rows; r++) {
    const rowStart = top + r * stride
    if (rowStart >= size) break
    let o = r * width * 4
    if (mode === 'rgb') {
      for (let c = 0; c < width; c++, o += 4) {
        const at = rowStart + c * 3
        if (at >= size) break
        data[o] = bytes[at]
        data[o + 1] = at + 1 < size ? bytes[at + 1] : 0
        data[o + 2] = at + 2 < size ? bytes[at + 2] : 0
        data[o + 3] = 255
      }
    } else if (mode === 'grey') {
      for (let c = 0; c < width; c++, o += 4) {
        const at = rowStart + c
        if (at >= size) break
        const v = bytes[at]
        data[o] = data[o + 1] = data[o + 2] = v
        data[o + 3] = 255
      }
    } else {
      for (let c = 0; c < width; c++, o += 4) {
        const at = rowStart + c
        if (at >= size) break
        const rgb = classColors[CLASS_INDEX[bytes[at]]]
        data[o] = rgb[0]
        data[o + 1] = rgb[1]
        data[o + 2] = rgb[2]
        data[o + 3] = 255
      }
    }
  }
  return data
}

/**
 * Guesses the row stride of a raw bitmap or table: the lag at which bytes
 * repeat best. Looks at up to `sample` bytes from `start` and returns null
 * when no lag stands out from the rest.
 *
 * @returns {{ stride: number, score: number } | null}
 */
export function detectStride(bytes, start, { minLag = 16, maxLag = 2048, sample = 16384 } = {}) {
  const from = Math.max(0, Math.min(start, bytes.length))
  const n = Math.min(sample, bytes.length - from)
  if (n < minLag * 4) return null
  const top = Math.min(maxLag, Math.floor(n / 2))
  const scores = new Float64Array(top + 1)
  let best = -1
  for (let lag = minLag; lag <= top; lag++) {
    let sum = 0
    let count = 0
    for (let i = from; i + lag < from + n; i += 2) {
      sum += Math.abs(bytes[i] - bytes[i + lag])
      count++
    }
    scores[lag] = count ? sum / count : 255
    if (best < 0 || scores[lag] < scores[best]) best = lag
  }
  if (best < 0) return null
  const sorted = Array.from(scores.subarray(minLag, top + 1)).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (!(median > 0) || scores[best] > median * 0.6) return null
  const close = lag => scores[lag] <= scores[best] * 1.1 + 0.5
  // Multiples of the true stride score almost as well; prefer the smallest
  for (let lag = minLag; lag < best; lag++) {
    if (close(lag) && best % lag === 0) return { stride: lag, score: scores[lag] }
  }
  // Smooth gradients match a pixel or two off the row length just as well;
  // among near neighbours prefer the roundest number, as row lengths usually are
  let pick = best
  const twos = n => (n & -n)
  for (let lag = Math.max(minLag, best - 8); lag <= Math.min(top, best + 8); lag++) {
    if (close(lag) && twos(lag) > twos(pick)) pick = lag
  }
  return { stride: pick, score: scores[pick] }
}

/**
 * Colours for a whole-file overview strip of `lines` lines. Each line samples
 * up to `perLine` evenly spaced bytes of its share of the file and mixes the
 * class colours.
 *
 * @returns {Uint8ClampedArray} RGBA per line
 */
export function overviewStrip(bytes, lines, classColors, perLine = 512) {
  const out = new Uint8ClampedArray(lines * 4)
  const size = bytes.length
  if (!size) return out
  for (let l = 0; l < lines; l++) {
    const from = Math.floor(l * size / lines)
    const to = Math.max(from + 1, Math.floor((l + 1) * size / lines))
    if (from >= size) break
    const step = Math.max(1, Math.floor((to - from) / perLine))
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let i = from; i < to && i < size; i += step) {
      const rgb = classColors[CLASS_INDEX[bytes[i]]]
      r += rgb[0]
      g += rgb[1]
      b += rgb[2]
      n++
    }
    out[l * 4] = r / n
    out[l * 4 + 1] = g / n
    out[l * 4 + 2] = b / n
    out[l * 4 + 3] = 255
  }
  return out
}
