// Finds every start offset where one of several patterns matches. Scanning
// runs in chunks of start offsets; a match may extend past its chunk, since
// candidates are verified against the whole buffer.

/** @typedef {import('./pattern.js').Pattern} Pattern */

export const DEFAULT_CAP = 1000000
export const CHUNK_SIZE = 1 << 20

// Bytes so common in binaries that they make poor anchors
const COMMON = new Set([0x00, 0xff, 0x20])

/**
 * The position in the pattern to look for first: a fixed byte, preferably
 * not a common filler byte and without a case alternative.
 * @returns {{ index: number, a: number, b: number }}
 */
export function chooseAnchor(pattern) {
  let best = null
  let bestScore = -1
  for (let i = 0; i < pattern.values.length; i++) {
    if (!pattern.mask[i]) continue
    const a = pattern.values[i]
    const b = pattern.alt[i]
    // A filler byte costs more than a case pair: zeros are everywhere in binaries
    const score = COMMON.has(a) ? (a === b ? 1 : 0) : (a === b ? 3 : 2)
    if (score > bestScore) {
      best = { index: i, a, b }
      bestScore = score
      if (score === 3) break
    }
  }
  return best
}

function verify(bytes, pattern, start) {
  const { values, alt, mask } = pattern
  for (let j = 0; j < values.length; j++) {
    if (!mask[j]) continue
    const byte = bytes[start + j]
    if (byte !== values[j] && byte !== alt[j]) return false
  }
  return true
}

/** Match starts of one pattern in [from, to), ascending, appended to `out`. */
export function scanPattern(bytes, pattern, anchor, from, to, out) {
  const length = pattern.values.length
  const end = Math.min(to, bytes.length - length + 1)
  if (length === 0 || from >= end) return
  const k = anchor.index
  const base = from + k
  const window = bytes.subarray(base, end + k)
  const single = length === 1 && pattern.mask[0]
  if (anchor.a === anchor.b) {
    for (let q = window.indexOf(anchor.a); q !== -1; q = window.indexOf(anchor.a, q + 1)) {
      const start = base + q - k
      if (single || verify(bytes, pattern, start)) out.push(start)
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
    if (verify(bytes, pattern, start)) out.push(start)
  }
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
export function scanChunk(bytes, patterns, anchors, from, to, list) {
  if (patterns.length === 1) {
    const found = []
    scanPattern(bytes, patterns[0], anchors[0], from, to, found)
    for (let i = 0; i < found.length; i++) if (!list.push(found[i], 0)) return
    return
  }
  const lists = patterns.map((pattern, i) => {
    const found = []
    scanPattern(bytes, pattern, anchors[i], from, to, found)
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
export function findAll(bytes, patterns, { cap = DEFAULT_CAP, chunkSize = CHUNK_SIZE } = {}) {
  const anchors = patterns.map(chooseAnchor)
  const list = new MatchList(cap)
  for (let from = 0; from < bytes.length && !list.full; from += chunkSize) {
    scanChunk(bytes, patterns, anchors, from, Math.min(bytes.length, from + chunkSize), list)
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
 * time, then yields so the page stays responsive.
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
  const anchors = patterns.map(chooseAnchor)
  const list = new MatchList(cap)
  const started = now()
  let position = 0
  let cancelled = false

  const step = () => {
    if (cancelled) return
    const sliceStart = now()
    while (position < bytes.length && !list.full && now() - sliceStart < sliceMs) {
      const to = Math.min(bytes.length, position + chunkSize)
      scanChunk(bytes, patterns, anchors, position, to, list)
      position = to
    }
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
