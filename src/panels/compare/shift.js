// Detects the common case that defeats an equal-offset comparison: a block of
// bytes inserted into (or removed from) one file, after which the content
// matches again at a shifted offset. Pure JS, used in the worker and tests.

export const MAX_SHIFT = 1 << 20
const PROBE = 32
// How far past the divergence to look for a probe that is not all one byte
const PROBE_SEARCH = 64 << 10
const VERIFY = 4096
const VERIFY_RATIO = 0.95

/** Bytes after the divergence that both windows should hold. */
export const WINDOW_EXTRA = PROBE_SEARCH + PROBE + VERIFY

/**
 * Whether the equal-offset result looks like content that stopped lining up:
 * after the first difference, most bytes differ.
 * @param {import('./diff.js').DiffStats} stats
 */
export function shouldLookForShift(stats) {
  if (stats.diffBytes === 0 || stats.firstDiff < 0) return false
  const after = stats.common - stats.firstDiff
  return after >= 2 * PROBE && stats.diffBytes / after > 0.25
}

function isPlain(bytes, start) {
  let distinct = 0
  const seen = new Set()
  for (let i = start; i < start + PROBE; i++) {
    if (!seen.has(bytes[i])) {
      seen.add(bytes[i])
      if (++distinct >= 4) return false
    }
  }
  return true
}

function choosePosition(bytes, limit) {
  const last = Math.min(limit, bytes.length - PROBE)
  for (let p = 0; p <= last; p += 8) if (!isPlain(bytes, p)) return p
  return 0
}

function equalRatio(x, xStart, y, yStart, length) {
  if (length <= 0) return 0
  let equal = 0
  for (let i = 0; i < length; i++) if (x[xStart + i] === y[yStart + i]) equal++
  return equal / length
}

/**
 * Finds the smallest k in [0, maxShift] such that `from` at `p` reappears in
 * `into` at `p + k`, checked over a longer stretch than the probe itself.
 * @returns {number} k, or -1
 */
function searchForward(from, into, maxShift) {
  if (from.length < PROBE) return -1
  const p = choosePosition(from, PROBE_SEARCH)
  const first = from[p]
  const lastK = Math.min(maxShift, into.length - PROBE - p)
  for (let k = 0; k <= lastK; k++) {
    if (into[p + k] !== first) continue
    let i = 1
    while (i < PROBE && into[p + k + i] === from[p + i]) i++
    if (i < PROBE) continue
    const length = Math.min(VERIFY, from.length - p, into.length - p - k)
    if (equalRatio(from, p, into, p + k, length) >= VERIFY_RATIO) return k
  }
  return -1
}

/**
 * Both windows start at the first differing offset. Returns the shift that
 * makes the content after it line up again: positive when B has bytes
 * inserted there, negative when B lacks bytes that A has, 0 when the files
 * line up again at equal offsets, or null when nothing was found.
 * @param {Uint8Array} a   A from the divergence on
 * @param {Uint8Array} b   B from the divergence on
 * @param {{ maxShift?: number }} [options]
 * @returns {number|null}
 */
export function findShift(a, b, { maxShift = MAX_SHIFT } = {}) {
  const inserted = searchForward(a, b, maxShift)
  const removed = searchForward(b, a, maxShift)
  if (inserted === 0 || removed === 0) return 0
  if (inserted < 0 && removed < 0) return null
  if (removed < 0 || (inserted >= 0 && inserted <= removed)) return inserted
  return -removed
}

/**
 * Checks a shift against the whole files by comparing blocks spread over the
 * rest of them. Returns the fraction of sampled blocks that match exactly.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {number} at      first differing offset
 * @param {number} shift   from findShift
 */
export function verifyShift(a, b, at, shift, { samples = 256, block = 16 } = {}) {
  const startA = shift >= 0 ? at : at - shift
  const startB = shift >= 0 ? at + shift : at
  const length = Math.min(a.length - startA, b.length - startB)
  if (length <= 0) return { ratio: 0, length: 0, checked: 0 }
  const size = Math.min(block, length)
  const count = Math.max(1, Math.min(samples, Math.floor(length / size)))
  const step = count > 1 ? (length - size) / (count - 1) : 0
  let matching = 0
  for (let s = 0; s < count; s++) {
    const offset = Math.floor(s * step)
    let i = 0
    while (i < size && a[startA + offset + i] === b[startB + offset + i]) i++
    if (i === size) matching++
  }
  return { ratio: matching / count, length, checked: count }
}
