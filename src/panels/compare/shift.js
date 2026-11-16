// Detects the common case that defeats an equal-offset comparison: a block of
// bytes inserted into (or removed from) one file, after which the content
// matches again at a shifted offset. Pure JS, used in the worker and tests.
//
// The worker gets a window of both files around the first difference and
// proposes candidate shifts; the main thread confirms one against the whole
// files with verifyShift before anything is reported.

export const MAX_SHIFT = 1 << 20
const PROBE = 32
// How far past the divergence to look for a distinctive stretch of bytes,
// so an edit inside zero padding is still found
const PROBE_SEARCH = 1 << 20
const PROBES = 3
const PROBE_SPACING = 4096
const LOCAL_VERIFY = 4096
const LOCAL_RATIO = 0.95
// Fewer distinct values than this says nothing about alignment
const DISTINCT_PROBE = 5
const DISTINCT_BLOCK = 3

/** Bytes before the divergence that both windows should hold. */
export const LOOK_BACK = 64 << 10
/** Bytes from the divergence on that both windows should hold. */
export const LOOK_AHEAD = PROBE_SEARCH + MAX_SHIFT + LOCAL_VERIFY + PROBE
/** A confirmed shift needs at least this share of informative blocks to match. */
export const CONFIRM_RATIO = 0.9

/**
 * Whether to look for a shift at all. Density is no guide (zero runs keep
 * matching at equal offsets after an insertion), so: always when the sizes
 * differ, and for equal sizes when differences continue at least two probe
 * lengths past the first one.
 * @param {import('./diff.js').DiffStats} stats
 */
export function shouldLookForShift(stats) {
  if (stats.diffBytes === 0 || stats.firstDiff < 0) return false
  if (stats.sizeA !== stats.sizeB) return true
  return stats.lastDiff - stats.firstDiff + 1 >= 2 * PROBE
}

function distinctCount(bytes, start, length, enough) {
  const seen = new Set()
  for (let i = start; i < start + length; i++) {
    seen.add(bytes[i])
    if (seen.size >= enough) break
  }
  return seen.size
}

// First offset in [from, limit] where PROBE bytes have enough distinct values
function nextDistinctive(bytes, from, limit) {
  const last = Math.min(limit, bytes.length - PROBE)
  for (let p = from; p <= last; p++) {
    // inside a run of one byte: move on without counting
    if (bytes[p] === bytes[p + 1] && bytes[p] === bytes[p + PROBE - 1]) continue
    if (distinctCount(bytes, p, PROBE, DISTINCT_PROBE) >= DISTINCT_PROBE) return p
  }
  return -1
}

function equalRatio(x, xStart, y, yStart, length) {
  if (length <= 0) return 0
  let equal = 0
  for (let i = 0; i < length; i++) if (x[xStart + i] === y[yStart + i]) equal++
  return equal / length
}

// Smallest k in [0, maxShift] with from[p..] reappearing at into[p + k..]
function findProbe(from, into, p, maxShift) {
  const first = from[p]
  const lastK = Math.min(maxShift, into.length - PROBE - p)
  for (let k = 0; k <= lastK; k++) {
    if (into[p + k] !== first) continue
    let i = 1
    while (i < PROBE && into[p + k + i] === from[p + i]) i++
    if (i < PROBE) continue
    const length = Math.min(LOCAL_VERIFY, from.length - p, into.length - p - k)
    if (equalRatio(from, p, into, p + k, length) >= LOCAL_RATIO) return k
  }
  return -1
}

// Lowest j such that from[j..p) equals into[j + k..p + k)
function walkBack(from, into, p, k) {
  let j = p
  while (j > 0 && from[j - 1] === into[j - 1 + k]) j--
  return j
}

// The prefix matches up to `at` and the shifted content matches from
// `start`, so the edit can be anywhere between the two
function candidate(shift, at, start, source) {
  return {
    shift,
    source,
    from: Math.min(start, at),
    to: Math.max(start, at),
    exact: start === at,
    mixed: start > at
  }
}

/**
 * Candidate shifts that line the content after the divergence up again.
 * Positive: B has bytes inserted; negative: B lacks bytes that A has.
 * @param {Uint8Array} a      window of A
 * @param {Uint8Array} b      window of B, starting at the same file offset
 * @param {number} at         first differing offset, within the windows
 * @param {Object} [options]
 * @param {number} [options.maxShift]
 * @param {boolean} [options.endA]   the window of A reaches the end of A
 * @param {boolean} [options.endB]
 * @returns {Array<{ shift: number, from: number, to: number, exact: boolean, mixed: boolean, source: string }>}
 *   offsets within the windows; the edit lies in `from`–`to`. `mixed` means
 *   the bytes there fit neither alignment, so other bytes changed too
 */
export function findShifts(a, b, at, { maxShift = MAX_SHIFT, endA = false, endB = false } = {}) {
  const found = []
  const add = (item) => {
    if (item.shift !== 0 && !found.some(other => other.shift === item.shift)) found.push(item)
  }

  // With the whole rest of both files at hand, the size difference itself is
  // a candidate: the rest of one may equal the tail of the other
  if (endA && endB && a.length !== b.length && at < Math.min(a.length, b.length)) {
    const k = b.length - a.length
    const [from, into, n] = k > 0 ? [a, b, k] : [b, a, -k]
    let i = at
    while (i < from.length && from[i] === into[i + n]) i++
    if (i === from.length) add(candidate(k, at, walkBack(from, into, from.length, n), 'tail'))
  }

  for (const [from, into, sign] of [[a, b, 1], [b, a, -1]]) {
    let p = at
    for (let tried = 0; tried < PROBES; tried++) {
      p = nextDistinctive(from, p, at + PROBE_SEARCH)
      if (p < 0) break
      const k = findProbe(from, into, p, maxShift)
      if (k === 0) break
      if (k > 0) {
        add(candidate(sign * k, at, walkBack(from, into, p, k), 'probe'))
        break
      }
      p += PROBE_SPACING
    }
  }
  return found
}

/**
 * Checks a shift against the whole files. Only blocks of A with some variety
 * count: zero padding matches zero padding at any shift and proves nothing.
 * Short remainders are compared block by block in full, long ones sampled.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {number} at      first differing offset
 * @param {number} shift
 * @returns {{ ratio: number, checked: number, confirmed: boolean }}
 */
export function verifyShift(a, b, at, shift, { block = 16, fullBelow = 64 << 10, samples = 4096 } = {}) {
  const startA = shift >= 0 ? at : at - shift
  const startB = shift >= 0 ? at + shift : at
  const length = Math.min(a.length - startA, b.length - startB)
  if (length <= 0) return { ratio: 0, checked: 0, confirmed: false }
  const size = Math.min(block, length)
  const blocks = Math.floor(length / size)
  const full = length <= fullBelow
  const count = full ? blocks : Math.min(samples, blocks)
  const step = count > 1 ? (length - size) / (count - 1) : 0
  const needed = Math.min(DISTINCT_BLOCK, size)
  let checked = 0
  let matching = 0
  for (let s = 0; s < count; s++) {
    const offset = full ? s * size : Math.floor(s * step)
    if (distinctCount(a, startA + offset, size, needed) < needed) continue
    checked++
    let i = 0
    while (i < size && a[startA + offset + i] === b[startB + offset + i]) i++
    if (i === size) matching++
  }
  const ratio = checked ? matching / checked : 0
  return { ratio, checked, confirmed: checked > 0 && ratio >= CONFIRM_RATIO }
}

/**
 * Confirms candidates (window offsets plus `base`) against the whole files
 * and returns the best confirmed one: the size-difference candidate first,
 * then clean edits before ones with other changes around them, then the
 * better match, then the smaller shift.
 */
export function confirmShift(a, b, at, candidates, base = 0) {
  const rank = (item) => (item.source === 'tail' ? 0 : 2) + (item.mixed ? 1 : 0)
  const confirmed = candidates
    .map(item => ({ item, check: verifyShift(a, b, at, item.shift) }))
    .filter(({ check }) => check.confirmed)
    .sort((x, y) => rank(x.item) - rank(y.item) || y.check.ratio - x.check.ratio ||
      Math.abs(x.item.shift) - Math.abs(y.item.shift))
  if (!confirmed.length) return null
  const { item, check } = confirmed[0]
  return { shift: item.shift, at, from: item.from + base, to: item.to + base, exact: item.exact, mixed: item.mixed, ratio: check.ratio, checked: check.checked }
}
