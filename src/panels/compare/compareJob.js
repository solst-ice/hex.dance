import { MAX_SHIFT, WINDOW_EXTRA, shouldLookForShift, verifyShift } from './shift.js'

const IN_FLIGHT = 2

/**
 * @typedef {{ shift: number, at: number, ratio: number, checked: number }} ShiftResult
 */

/**
 * Compares A and B off the main thread. Both arrays are read chunk by chunk
 * just before each chunk is sent, so at most a few chunks exist as copies.
 * @param {Object} options
 * @param {Uint8Array} options.a
 * @param {Uint8Array} options.b
 * @param {number} options.gap
 * @param {number} [options.chunkSize]
 * @param {(stats: import('./diff.js').DiffStats, ranges: import('./diff.js').RangeBatch) => void} options.onProgress
 * @param {(stats: import('./diff.js').DiffStats, ranges: import('./diff.js').RangeBatch) => void} options.onCompared
 *   the equal-offset pass is complete; the shift search may follow
 * @param {(shift: ShiftResult|null, searched: boolean) => void} options.onDone
 * @param {(error: Error) => void} options.onError
 * @returns {{ cancel: () => void }}
 */
export function startCompare({ a, b, gap, chunkSize = 4 << 20, onProgress, onCompared, onDone, onError }) {
  const common = Math.min(a.length, b.length)
  let worker
  let finished = false
  let next = 0
  let inFlight = 0
  let stats = null

  const stop = () => {
    finished = true
    worker?.terminate()
  }
  const fail = (error) => {
    if (finished) return
    stop()
    onError(error)
  }

  const send = () => {
    while (!finished && inFlight < IN_FLIGHT && (next < common || (next === 0 && common === 0))) {
      const from = next
      const to = Math.min(common, from + chunkSize)
      const chunkA = a.slice(from, to).buffer
      const chunkB = b.slice(from, to).buffer
      next = to === from ? to + 1 : to
      inFlight++
      worker.postMessage({ type: 'chunk', a: chunkA, b: chunkB, offset: from, last: to >= common }, [chunkA, chunkB])
    }
  }

  const lookForShift = () => {
    const at = stats.firstDiff
    const length = MAX_SHIFT + WINDOW_EXTRA
    const windowA = a.slice(at, at + length).buffer
    const windowB = b.slice(at, at + length).buffer
    worker.postMessage({ type: 'shift', a: windowA, b: windowB }, [windowA, windowB])
  }

  try {
    worker = new Worker(new URL('./compare.worker.js', import.meta.url), { type: 'module' })
  } catch (error) {
    queueMicrotask(() => fail(error instanceof Error ? error : new Error(String(error))))
    return { cancel: stop }
  }

  worker.onmessage = (event) => {
    if (finished) return
    const message = event.data || {}
    if (message.type === 'progress') {
      inFlight--
      onProgress(message.stats, message.ranges)
      send()
    } else if (message.type === 'done') {
      stats = message.stats
      onCompared(message.stats, message.ranges)
      if (shouldLookForShift(stats)) {
        lookForShift()
      } else {
        stop()
        onDone(null, false)
      }
    } else if (message.type === 'shift') {
      stop()
      const { shift } = message
      if (shift === null || shift === 0) {
        onDone(null, true)
        return
      }
      const { ratio, checked } = verifyShift(a, b, stats.firstDiff, shift)
      onDone({ shift, at: stats.firstDiff, ratio, checked }, true)
    }
  }
  worker.onerror = (event) => {
    event.preventDefault?.()
    fail(new Error(event.message || 'The comparison worker failed'))
  }
  worker.onmessageerror = () => fail(new Error('The comparison worker sent an unreadable message'))

  worker.postMessage({ type: 'begin', params: { sizeA: a.length, sizeB: b.length, gap } })
  send()
  return { cancel: stop }
}
