// Finds every start offset where one of several patterns matches. Scanning
// runs in chunks of start offsets; a match may extend past its chunk, since
// candidates are verified against the whole buffer.

/** @typedef {import('./pattern.js').Pattern} Pattern */

export const DEFAULT_CAP = 1000000
export const CHUNK_SIZE = 1 << 20

// How common each byte value is in typical binaries, used when the file
// itself gives no sample (tiny files, tests): zeros are everywhere, 0xff and
// spaces pad, letters and digits fill text, the rest is rarer.
const TYPICAL = new Float64Array(256).fill(1)
for (let b = 0x30; b <= 0x39; b++) TYPICAL[b] = 3
for (let b = 0x41; b <= 0x5a; b++) TYPICAL[b] = 3
for (let b = 0x61; b <= 0x7a; b++) TYPICAL[b] = 4
TYPICAL[0x20] = 8
TYPICAL[0xff] = 12
TYPICAL[0x00] = 64

const SAMPLE_BLOCKS = 64
const SAMPLE_BLOCK = 4096

/**
 * How common each byte value is in `bytes`, from a few evenly spaced blocks,
 * so the scan can look first for the byte the file has least of. The typical
 * weights only break ties between bytes the sample has equally few of.
 * @returns {Float64Array} 256 weights; lower is rarer
 */
export function byteWeights(bytes) {
  const counts = new Float64Array(256)
  const total = SAMPLE_BLOCKS * SAMPLE_BLOCK
  if (bytes.length <= total) {
    for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++
  } else {
    const step = Math.floor((bytes.length - SAMPLE_BLOCK) / (SAMPLE_BLOCKS - 1))
    for (let k = 0; k < SAMPLE_BLOCKS; k++) {
      const from = k * step
      for (let i = from; i < from + SAMPLE_BLOCK; i++) counts[bytes[i]]++
    }
  }
  const weights = new Float64Array(256)
  for (let b = 0; b < 256; b++) weights[b] = counts[b] * 1024 + TYPICAL[b]
  return weights
}

/**
 * The position in the pattern to look for first: the fixed byte that is
 * rarest by `weights` (a case pair counts both letters), the earliest on a
 * tie.
 * @returns {{ index: number, a: number, b: number }}
 */
export function chooseAnchor(pattern, weights = TYPICAL) {
  let best = null
  let bestCost = Infinity
  for (let i = 0; i < pattern.values.length; i++) {
    if (!pattern.mask[i]) continue
    const a = pattern.values[i]
    const b = pattern.alt[i]
    const cost = a === b ? weights[a] : weights[a] + weights[b]
    if (cost < bestCost) {
      best = { index: i, a, b }
      bestCost = cost
    }
  }
  return best
}

/**
 * What the scan needs for one pattern: its anchor, and the other fixed
 * positions in the order to check them, rarest byte first, so a candidate
 * that does not match usually fails on its first comparison.
 */
export function planPattern(pattern, weights = TYPICAL) {
  const anchor = chooseAnchor(pattern, weights)
  const positions = []
  for (let i = 0; i < pattern.values.length; i++) {
    if (pattern.mask[i] && i !== anchor.index) positions.push(i)
  }
  const cost = (i) => (pattern.values[i] === pattern.alt[i] ? weights[pattern.values[i]] : weights[pattern.values[i]] + weights[pattern.alt[i]])
  positions.sort((x, y) => cost(x) - cost(y) || x - y)
  const order = Int32Array.from(positions)
  return {
    pattern,
    anchor,
    order,
    values: Uint8Array.from(positions, i => pattern.values[i]),
    alt: Uint8Array.from(positions, i => pattern.alt[i])
  }
}

function verify(bytes, plan, start) {
  const { order, values, alt } = plan
  for (let j = 0; j < order.length; j++) {
    const byte = bytes[start + order[j]]
    if (byte !== values[j] && byte !== alt[j]) return false
  }
  return true
}

/** Match starts of one pattern in [from, to), ascending, appended to `out`. */
export function scanPattern(bytes, plan, from, to, out) {
  const { pattern, anchor } = plan
  const length = pattern.values.length
  const end = Math.min(to, bytes.length - length + 1)
  if (length === 0 || from >= end) return
  const k = anchor.index
  const base = from + k
  const window = bytes.subarray(base, end + k)
  const single = plan.order.length === 0
  if (anchor.a === anchor.b) {
    for (let q = window.indexOf(anchor.a); q !== -1; q = window.indexOf(anchor.a, q + 1)) {
      const start = base + q - k
      if (single || verify(bytes, plan, start)) out.push(start)
    }
    return
  }
  let qa = window.indexOf(anchor.a)
  let qb = window.indexOf(anchor.b)
  while (qa !== -1 || qb !== -1) {
    let q
    if (qb === -1 || (qa !== -1 && qa < qb)) {
      q = qa
      qa = window.indexOf(anchor.a, qa + 1)
    } else {
      q = qb
      qb = window.indexOf(anchor.b, qb + 1)
    }
    const start = base + q - k
    if (single || verify(bytes, plan, start)) out.push(start)
  }
}

// Byte comparisons one chunk may cost at most: a chunk of start offsets is
// shortened for long patterns, since in the worst case (a common anchor
// byte, as with a run of zeros) every offset is checked over the whole
// pattern. About 4 ms of work in a browser.
export const CHUNK_WORK = 4 << 20

/** Start offsets per chunk for these patterns: at most `limit`, and few enough that a chunk stays within CHUNK_WORK. */
export function chunkPositions(patterns, limit = CHUNK_SIZE) {
  let work = 0
  for (const pattern of patterns) work += Math.max(1, pattern.values.length)
  return Math.max(1, Math.min(limit, Math.floor(CHUNK_WORK / work)))
}

/**
 * Collects matches as offsets (Float64Array) and the index of the pattern
 * that matched (Uint8Array). Where several patterns match at one offset the
 * earliest pattern in the list wins.
 */
export class MatchList {
  constructor(cap = DEFAULT_CAP) {
    this.cap = cap
    this.count = 0
    this.offsets = new Float64Array(1024)
    this.kinds = new Uint8Array(1024)
  }

  get full() {
    return this.count >= this.cap
  }

  push(offset, kind) {
    if (this.count >= this.cap) return false
    if (this.count === this.offsets.length) {
      const size = Math.min(this.cap, this.offsets.length * 2)
      const offsets = new Float64Array(size)
      offsets.set(this.offsets)
      const kinds = new Uint8Array(size)
      kinds.set(this.kinds)
      this.offsets = offsets
      this.kinds = kinds
    }
    this.offsets[this.count] = offset
    this.kinds[this.count] = kind
    this.count++
    return true
  }
}

/** Scans start offsets [from, to) for all patterns and appends to `list`. */
export function scanChunk(bytes, plans, from, to, list) {
  if (plans.length === 1) {
    const found = []
    scanPattern(bytes, plans[0], from, to, found)
    for (let i = 0; i < found.length; i++) if (!list.push(found[i], 0)) return
    return
  }
  const lists = plans.map((plan) => {
    const found = []
    scanPattern(bytes, plan, from, to, found)
    return found
  })
  const positions = new Array(lists.length).fill(0)
  for (;;) {
    let best = -1
    let bestOffset = Infinity
    for (let i = 0; i < lists.length; i++) {
      const offset = lists[i][positions[i]]
      if (offset !== undefined && offset < bestOffset) {
        best = i
        bestOffset = offset
      }
    }
    if (best === -1) return
    for (let i = 0; i < lists.length; i++) {
      if (lists[i][positions[i]] === bestOffset) positions[i]++
    }
    if (!list.push(bestOffset, best)) return
  }
}

/** Synchronous search over the whole buffer (used by tests). */
export function findAll(bytes, patterns, { cap = DEFAULT_CAP, chunkSize = CHUNK_SIZE, weights = byteWeights(bytes) } = {}) {
  const plans = patterns.map(pattern => planPattern(pattern, weights))
  const list = new MatchList(cap)
  for (let from = 0; from < bytes.length && !list.full; from += chunkSize) {
    scanChunk(bytes, plans, from, Math.min(bytes.length, from + chunkSize), list)
  }
  return list
}

function defaultSchedule() {
  if (typeof MessageChannel === 'undefined') return callback => setTimeout(callback, 0)
  const channel = new MessageChannel()
  const queue = []
  channel.port1.onmessage = () => queue.shift()?.()
  return callback => {
    queue.push(callback)
    channel.port2.postMessage(null)
  }
}

/**
 * Time-sliced search on the calling thread: scans for about `sliceMs` at a
 * time, then yields so the page stays responsive. Each slice scans at least
 * one chunk, and chunks are sized by the patterns' length (see
 * chunkPositions), so no slice runs much past `sliceMs` whatever the pattern.
 *
 * @param {Uint8Array} bytes
 * @param {Pattern[]} patterns
 * @param {Object} options
 * @param {(list: MatchList, scanned: number) => void} [options.onProgress]   after each slice
 * @param {(list: MatchList, info: { capped: boolean, ms: number }) => void} [options.onDone]
 * @returns {{ cancel: () => void, list: MatchList }}
 */
export function startSearch(bytes, patterns, {
  cap = DEFAULT_CAP,
  chunkSize = 256 * 1024,
  sliceMs = 8,
  onProgress,
  onDone,
  schedule = defaultSchedule(),
  now = () => performance.now()
} = {}) {
  const started = now()
  const weights = byteWeights(bytes)
  const plans = patterns.map(pattern => planPattern(pattern, weights))
  const positions = chunkPositions(patterns, chunkSize)
  const list = new MatchList(cap)
  let position = 0
  let cancelled = false

  const step = () => {
    if (cancelled) return
    const sliceStart = now()
    do {
      if (position >= bytes.length || list.full) break
      const to = Math.min(bytes.length, position + positions)
      scanChunk(bytes, plans, position, to, list)
      position = to
    } while (now() - sliceStart < sliceMs)
    if (position >= bytes.length || list.full) {
      onDone?.(list, { capped: list.full, ms: now() - started })
      return
    }
    onProgress?.(list, position)
    schedule(step)
  }
  schedule(step)

  return {
    list,
    cancel() { cancelled = true }
  }
}

/** Index of the first offset > `offset` (or >= when `inclusive`), by binary search. */
export function firstAfter(offsets, count, offset, inclusive = false) {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (inclusive ? offsets[mid] < offset : offsets[mid] <= offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Next or previous match from `offset`, wrapping around.
 * @returns {number} match index, or -1 when there are no matches
 */
export function stepMatch(offsets, count, offset, direction) {
  if (!count) return -1
  if (direction > 0) {
    const i = firstAfter(offsets, count, offset)
    return i < count ? i : 0
  }
  const i = firstAfter(offsets, count, offset, true) - 1
  return i >= 0 ? i : count - 1
}
