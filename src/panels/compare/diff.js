// Byte-for-byte comparison of two files at equal offsets, fed in chunks.
// Pure JS so it runs in the worker and under `node --test`.

export const DEFAULT_GAP = 4
export const GAP_CHOICES = [0, 1, 2, 4, 8, 16, 32, 64]
// Ranges kept for the list; counts stay exact beyond this
export const RANGE_CAP = 100000
export const BUCKETS = 512

/**
 * @typedef {Object} DiffStats
 * @property {number} sizeA
 * @property {number} sizeB
 * @property {number} common          bytes compared: the shorter size
 * @property {number} position        bytes compared so far
 * @property {number} diffBytes       differing bytes within `common`
 * @property {number} rangeCount      merged ranges (exact, may exceed the stored ones)
 * @property {number} firstDiff       -1 when none within `common`
 * @property {number} lastDiff        offset of the last differing byte, -1 when none
 * @property {boolean} truncated      more ranges than `cap` were found
 * @property {number} gap
 * @property {number} bucketSize      bytes per density bucket, over the larger size
 * @property {Uint32Array} density    differing bytes per bucket (the size difference is not included)
 *
 * @typedef {{ starts: Float64Array, ends: Float64Array, diffs: Float64Array }} RangeBatch
 */

/**
 * @param {Object} options
 * @param {number} options.sizeA
 * @param {number} options.sizeB
 * @param {number} [options.gap]       equal bytes allowed inside one range
 * @param {number} [options.cap]       ranges kept
 * @param {number} [options.buckets]
 */
export function createDiffer({ sizeA, sizeB, gap = DEFAULT_GAP, cap = RANGE_CAP, buckets = BUCKETS }) {
  const common = Math.min(sizeA, sizeB)
  const total = Math.max(sizeA, sizeB)
  const bucketSize = Math.max(1, Math.ceil(total / buckets))
  const density = new Uint32Array(total ? Math.ceil(total / bucketSize) : 0)
  const gapLimit = Math.max(0, Math.floor(gap) || 0)

  let position = 0
  let diffBytes = 0
  let rangeCount = 0
  let firstDiff = -1
  let lastDiff = -1
  let truncated = false
  let open = null
  let pending = { starts: [], ends: [], diffs: [] }
  let stored = 0

  const close = () => {
    if (!open) return
    rangeCount++
    if (stored < cap) {
      pending.starts.push(open.start)
      pending.ends.push(open.end)
      pending.diffs.push(open.diffs)
      stored++
    } else {
      truncated = true
    }
    open = null
  }

  const addRun = (start, end) => {
    diffBytes += end - start
    if (firstDiff < 0) firstDiff = start
    lastDiff = end - 1
    for (let bucket = Math.floor(start / bucketSize), last = Math.floor((end - 1) / bucketSize); bucket <= last; bucket++) {
      const from = Math.max(start, bucket * bucketSize)
      const to = Math.min(end, (bucket + 1) * bucketSize)
      density[bucket] += to - from
    }
    if (open && start - open.end <= gapLimit) {
      open.end = end
      open.diffs += end - start
    } else {
      close()
      open = { start, end, diffs: end - start }
    }
  }

  return {
    /**
     * Compares one chunk. Chunks must arrive in order and cover [0, common).
     * @param {Uint8Array} a
     * @param {Uint8Array} b   same length as `a`
     * @param {number} offset  absolute offset of both chunks
     */
    push(a, b, offset) {
      if (offset !== position) throw new Error(`Chunk at ${offset}, expected ${position}`)
      const n = Math.min(a.length, b.length, common - offset)
      if (n <= 0) return
      const words = a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0 ? n >> 2 : 0
      const wa = words ? new Uint32Array(a.buffer, a.byteOffset, words) : null
      const wb = words ? new Uint32Array(b.buffer, b.byteOffset, words) : null
      let i = 0
      while (i < n) {
        if (words && (i & 3) === 0) {
          let w = i >> 2
          while (w < words && wa[w] === wb[w]) w++
          i = w << 2
          if (i >= n) break
        }
        if (a[i] === b[i]) {
          i++
          continue
        }
        let j = i + 1
        while (j < n && a[j] !== b[j]) j++
        addRun(offset + i, offset + j)
        i = j
      }
      position = offset + n
    },

    /** Ranges closed since the last call, as transferable arrays. */
    takeRanges() {
      const batch = {
        starts: Float64Array.from(pending.starts),
        ends: Float64Array.from(pending.ends),
        diffs: Float64Array.from(pending.diffs)
      }
      pending = { starts: [], ends: [], diffs: [] }
      return batch
    },

    /** @returns {DiffStats} */
    stats() {
      return {
        sizeA, sizeB, common, position, diffBytes,
        rangeCount: rangeCount + (open ? 1 : 0),
        firstDiff, lastDiff, truncated, gap: gapLimit, bucketSize,
        density: density.slice()
      }
    },

    /** Closes the last range. Call once every chunk has been pushed. */
    finish() {
      close()
      return this.stats()
    }
  }
}

/**
 * Compares two whole arrays in chunks of `chunkSize`. Used by tests and for
 * small inputs; the panel streams through the worker instead.
 */
export function diffBytes(a, b, { gap = DEFAULT_GAP, cap = RANGE_CAP, chunkSize = 1 << 20, buckets = BUCKETS } = {}) {
  const differ = createDiffer({ sizeA: a.length, sizeB: b.length, gap, cap, buckets })
  const common = Math.min(a.length, b.length)
  for (let offset = 0; offset < common; offset += chunkSize) {
    const end = Math.min(common, offset + chunkSize)
    differ.push(a.slice(offset, end), b.slice(offset, end), offset)
  }
  const stats = differ.finish()
  const batch = differ.takeRanges()
  const ranges = Array.from(batch.starts, (start, index) => ({ start, end: batch.ends[index], diffs: batch.diffs[index] }))
  return { stats, ranges }
}
