// Whole-file statistics for the Visualize panel: the digraph (counts of
// consecutive byte pairs), a Hilbert-curve map of byte classes and the
// hexspeak scanner. Everything here works on chunks so a file can be streamed
// through a worker without the worker ever holding all of it.

import { BYTE_CLASSES, byteClass } from '../../components/hex/bytes.js'

export const CLASS_COUNT = BYTE_CLASSES.length
// Byte value -> index into BYTE_CLASSES
export const CLASS_INDEX = Uint8Array.from({ length: 256 }, (_, v) => BYTE_CLASSES.indexOf(byteClass(v)))

export const MB = 1024 * 1024
// Files up to this size are read in full; larger ones are sampled
export const EXACT_LIMIT = 256 * MB
export const CHUNK_BYTES = MB
export const SAMPLE_BLOCKS = 1024
export const SAMPLE_BLOCK_BYTES = 64 * 1024

export const HILBERT_MAX_SIDE = 256

/**
 * Which parts of the file to read. Small files are read in contiguous 1 MB
 * chunks; above `exactLimit`, `blocks` evenly spaced blocks are read instead.
 *
 * @returns {{ sampled: boolean, covered: number, chunks: Array<{ offset: number, length: number, contiguous: boolean }> }}
 */
export function chunkPlan(size, {
  exactLimit = EXACT_LIMIT, chunkBytes = CHUNK_BYTES, blocks = SAMPLE_BLOCKS, blockBytes = SAMPLE_BLOCK_BYTES
} = {}) {
  const chunks = []
  if (!(size > 0)) return { sampled: false, covered: 0, chunks }
  if (size <= exactLimit || blocks * blockBytes >= size) {
    for (let offset = 0; offset < size; offset += chunkBytes) {
      chunks.push({ offset, length: Math.min(chunkBytes, size - offset), contiguous: offset > 0 })
    }
    return { sampled: false, covered: size, chunks }
  }
  const span = size - blockBytes
  let covered = 0
  for (let i = 0; i < blocks; i++) {
    const offset = Math.floor(i * span / (blocks - 1))
    chunks.push({ offset, length: blockBytes, contiguous: false })
    covered += blockBytes
  }
  return { sampled: true, covered, chunks }
}

/** Side of the Hilbert map: the smallest power of two whose square holds the file, at most HILBERT_MAX_SIDE. */
export function hilbertLayout(size) {
  let side = 1
  while (side < HILBERT_MAX_SIDE && side * side < size) side *= 2
  const cells = side * side
  const cellBytes = Math.max(1, Math.ceil(size / cells))
  return { side, cells, cellBytes }
}

/** Distance along a Hilbert curve -> [x, y] on a side x side grid (side a power of two). */
export function hilbertPoint(side, d) {
  let x = 0
  let y = 0
  let t = d
  for (let s = 1; s < side; s *= 2) {
    const rx = 1 & (t >> 1)
    const ry = 1 & (t ^ rx)
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x
        y = s - 1 - y
      }
      const swap = x
      x = y
      y = swap
    }
    x += s * rx
    y += s * ry
    t = Math.floor(t / 4)
  }
  return [x, y]
}

/** For each distance d, the pixel index y * side + x. */
export function hilbertPixels(side) {
  const out = new Uint32Array(side * side)
  for (let d = 0; d < out.length; d++) {
    const [x, y] = hilbertPoint(side, d)
    out[d] = y * side + x
  }
  return out
}

/** Accumulates the digraph and the per-cell byte-class counts over streamed chunks. */
export function createAccumulator(size) {
  const layout = hilbertLayout(size)
  const digraph = new Uint32Array(256 * 256)
  const classCounts = new Uint32Array(layout.cells * CLASS_COUNT)
  let previous = -1
  let bytesSeen = 0

  return {
    layout,
    digraph,
    classCounts,
    get bytesSeen() { return bytesSeen },
    /** `contiguous` means the chunk starts right after the previous one, so the pair across the boundary counts. */
    add(chunk, offset, contiguous) {
      const n = chunk.length
      if (!n) return
      let prev = contiguous ? previous : -1
      if (prev >= 0) digraph[(prev << 8) | chunk[0]]++
      for (let i = 1; i < n; i++) digraph[(chunk[i - 1] << 8) | chunk[i]]++
      previous = chunk[n - 1]

      const { cellBytes, cells } = layout
      let i = 0
      while (i < n) {
        const cell = Math.floor((offset + i) / cellBytes)
        if (cell >= cells) break
        const stop = Math.min(n, (cell + 1) * cellBytes - offset)
        const base = cell * CLASS_COUNT
        for (; i < stop; i++) classCounts[base + CLASS_INDEX[chunk[i]]]++
      }
      bytesSeen += n
    }
  }
}

/**
 * Mixes the class colours of each cell in proportion to its counts. Cells
 * with no bytes read stay transparent.
 *
 * @param {Uint32Array} classCounts
 * @param {Array<[number, number, number]>} colors   one RGB triple per byte class
 * @returns {Uint8ClampedArray} RGBA per cell, in file order
 */
export function cellColors(classCounts, colors, out) {
  const cells = classCounts.length / CLASS_COUNT
  const rgba = out || new Uint8ClampedArray(cells * 4)
  for (let c = 0; c < cells; c++) {
    let total = 0
    let r = 0
    let g = 0
    let b = 0
    for (let k = 0; k < CLASS_COUNT; k++) {
      const n = classCounts[c * CLASS_COUNT + k]
      total += n
      r += n * colors[k][0]
      g += n * colors[k][1]
      b += n * colors[k][2]
    }
    const o = c * 4
    if (total) {
      rgba[o] = r / total
      rgba[o + 1] = g / total
      rgba[o + 2] = b / total
      rgba[o + 3] = 255
    } else {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = rgba[o + 3] = 0
    }
  }
  return rgba
}

/** Largest count in the digraph, for scaling. */
export function digraphMax(digraph) {
  let max = 0
  for (let i = 0; i < digraph.length; i++) if (digraph[i] > max) max = digraph[i]
  return max
}
