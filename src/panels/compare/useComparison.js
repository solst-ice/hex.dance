import { useEffect, useRef, useState } from 'react'
import { startCompare } from './compareJob.js'
import { cacheResult, cachedResult } from './store.js'

// Wait this long after the last edit before comparing again
const EDIT_DEBOUNCE_MS = 700
const PAINT_MS = 120

/**
 * @typedef {Object} Comparison
 * @property {number} revision      A's revision when the comparison started
 * @property {import('./diff.js').DiffStats|null} stats
 * @property {{ starts: number[], ends: number[], diffs: number[], length: number }} ranges
 * @property {boolean} compared     the equal-offset pass is complete
 * @property {boolean} done         the shift search (if any) is complete too
 * @property {import('./compareJob.js').ShiftResult|null} shift
 * @property {boolean} shiftSearched
 * @property {Error|null} error
 * @property {number} ms
 * @property {number} version       bumps whenever the object changes
 */

function newComparison(revision) {
  return {
    revision, stats: null, ranges: { starts: [], ends: [], diffs: [], length: 0 },
    compared: false, done: false, shift: null, shiftSearched: false, error: null, ms: 0, version: 0
  }
}

function append(ranges, batch) {
  for (let i = 0; i < batch.starts.length; i++) {
    ranges.starts.push(batch.starts[i])
    ranges.ends.push(batch.ends[i])
    ranges.diffs.push(batch.diffs[i])
  }
  ranges.length = ranges.starts.length
}

/**
 * Compares A with B, streaming partial results, and compares again (after a
 * pause) when A is edited.
 * @returns {{ result: Comparison|null, running: Comparison|null, stale: boolean, rerun: () => void }}
 *   `result` is the last finished comparison for this A, B and gap (possibly
 *   stale); `running` is the one in progress, if any
 */
export function useComparison({ buffer, bytes, revision, b, gap }) {
  const [running, setRunning] = useState(null)
  const [request, setRequest] = useState(0)
  const [, setPaint] = useState(0)
  const revisionRef = useRef(revision)
  revisionRef.current = revision

  useEffect(() => {
    if (!bytes || !b) return undefined
    const cached = cachedResult(buffer, b.id, gap)
    if (cached && cached.revision === revisionRef.current) return undefined

    const run = newComparison(revisionRef.current)
    const started = performance.now()
    let lastPaint = 0
    const paint = (force) => {
      const now = performance.now()
      if (!force && now - lastPaint < PAINT_MS) return
      lastPaint = now
      run.version++
      setPaint(n => n + 1)
    }
    setRunning(run)

    const job = startCompare({
      a: bytes,
      b: b.bytes,
      gap,
      onProgress(stats, batch) {
        run.stats = stats
        append(run.ranges, batch)
        paint(false)
      },
      onCompared(stats, batch) {
        run.stats = stats
        run.compared = true
        append(run.ranges, batch)
        paint(true)
      },
      onDone(shift, searched) {
        run.shift = shift
        run.shiftSearched = searched
        run.done = true
        run.ms = performance.now() - started
        run.version++
        cacheResult(buffer, b.id, gap, run)
        setRunning(current => (current === run ? null : current))
      },
      onError(error) {
        run.error = error
        paint(true)
      }
    })
    return () => {
      job.cancel()
      setRunning(current => (current === run ? null : current))
    }
  }, [buffer, bytes, b, gap, request])

  const result = b ? cachedResult(buffer, b.id, gap) : null
  const stale = Boolean(result && result.revision !== revision)

  useEffect(() => {
    if (!stale || running) return undefined
    const timer = setTimeout(() => setRequest(n => n + 1), EDIT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [stale, running, revision])

  return { result, running, stale, rerun: () => setRequest(n => n + 1) }
}
