import { useEffect, useRef, useState } from 'react'

// Finished scans per loaded buffer, so switching tabs does not rescan
const cache = new WeakMap()

/**
 * Starts the scan worker and answers its read requests from the live bytes
 * (the hex view edits them in place, so each window is copied when asked for).
 * @returns {{ cancel: () => void }}
 */
function startWorker(bytes, { onHits, onDone, onError }) {
  let worker
  try {
    worker = new Worker(new URL('./carve.worker.js', import.meta.url), { type: 'module' })
  } catch (error) {
    queueMicrotask(() => onError(error))
    return { cancel() {} }
  }
  let finished = false
  const stop = () => {
    finished = true
    worker.terminate()
  }
  worker.onmessage = (event) => {
    if (finished) return
    const message = event.data || {}
    if (message.type === 'read') {
      const start = Math.max(0, Math.min(bytes.length, message.start))
      const end = Math.max(start, Math.min(bytes.length, message.end))
      const data = bytes.slice(start, end).buffer
      worker.postMessage({ type: 'bytes', id: message.id, data }, [data])
    } else if (message.type === 'hits') {
      onHits(message.hits, message.position)
    } else if (message.type === 'done') {
      stop()
      onDone(message)
    } else if (message.type === 'error') {
      stop()
      onError(new Error(message.message))
    }
  }
  worker.onerror = (event) => {
    event.preventDefault?.()
    if (finished) return
    stop()
    onError(new Error(event.message || 'The scan worker failed'))
  }
  worker.postMessage({ type: 'start', size: bytes.length })
  return { cancel: stop }
}

/**
 * Scans the current file for embedded files while the panel is mounted.
 * `token` > 0 forces a rescan. The result carries the revision it was made
 * from, so the panel can say when edits made it stale.
 */
export function useCarveScan({ buffer, bytes, revision, token }) {
  const revisionRef = useRef(revision)
  revisionRef.current = revision
  const [scan, setScan] = useState(null)
  const lastToken = useRef(token)

  useEffect(() => {
    if (!bytes) return undefined
    const cached = cache.get(buffer)
    const forced = token !== lastToken.current
    lastToken.current = token
    if (cached && !forced) {
      setScan(cached)
      return undefined
    }
    const state = {
      buffer,
      size: bytes.length,
      revision: revisionRef.current,
      status: 'scanning',
      hits: [],
      version: 0,
      position: 0,
      startedAt: performance.now(),
      doneAt: 0,
      stats: null,
      lastNonZero: bytes.length - 1,
      capped: false,
      stoppedAt: -1,
      error: null
    }
    setScan({ ...state })
    let frame = 0
    const publish = () => {
      frame = 0
      setScan({ ...state, hits: state.hits.slice() })
    }
    const job = startWorker(bytes, {
      onHits(hits, position) {
        for (const hit of hits) state.hits[hit.id] = hit
        state.position = position
        state.version++
        if (!frame) frame = requestAnimationFrame(publish)
      },
      onDone(message) {
        cancelAnimationFrame(frame)
        frame = 0
        Object.assign(state, {
          status: 'done',
          doneAt: performance.now(),
          position: state.size,
          stats: message.stats,
          lastNonZero: message.lastNonZero,
          capped: message.capped,
          stoppedAt: message.stoppedAt,
          version: state.version + 1
        })
        const final = { ...state, hits: state.hits.filter(Boolean) }
        cache.set(buffer, final)
        setScan(final)
      },
      onError(error) {
        cancelAnimationFrame(frame)
        frame = 0
        state.status = 'error'
        state.error = error
        setScan({ ...state, hits: state.hits.filter(Boolean) })
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      job.cancel()
    }
  }, [buffer, bytes, token])

  return scan && scan.buffer === buffer ? scan : null
}
