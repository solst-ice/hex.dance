import { useEffect, useState } from 'react'
import { chunkPlan } from './stats.js'

// Results per file buffer, so coming back to the panel does not start over
const cache = new WeakMap()
const IN_FLIGHT = 2
const EDIT_DEBOUNCE_MS = 800

const IDLE = { status: 'idle' }

/**
 * Streams the file through the statistics worker in 1 MB copies (or sampled
 * blocks for huge files) and returns progressively filled results. Starts
 * only while `enabled`; restarts after edits, debounced.
 *
 * @returns {{ status: 'idle'|'running'|'done'|'error', bytesSeen?: number, digraph?: Uint32Array,
 *   classCounts?: Uint32Array, magic?: object[], plan?: object, firstMs?: number, totalMs?: number, error?: string }}
 */
export default function useFilePass(bytes, revision, enabled) {
  const [state, setState] = useState({ key: null, value: IDLE })

  useEffect(() => {
    if (!enabled || !bytes || !bytes.length) return
    const cached = cache.get(bytes)
    if (cached && cached.revision === revision) {
      setState({ key: bytes, value: cached.value })
      return
    }

    let worker = null
    let cancelled = false
    const plan = chunkPlan(bytes.length)
    const t0 = performance.now()
    let firstMs = null
    let next = 0
    let acked = 0

    const sendNext = () => {
      if (next >= plan.chunks.length) return
      const { offset, length, contiguous } = plan.chunks[next++]
      const copy = bytes.slice(offset, offset + length)
      worker.postMessage({ type: 'chunk', offset, contiguous, buffer: copy.buffer }, [copy.buffer])
    }

    const start = () => {
      if (cancelled) return
      try {
        worker = new Worker(new URL('./visualize.worker.js', import.meta.url), { type: 'module' })
      } catch (err) {
        setState({ key: bytes, value: { status: 'error', error: String(err && err.message || err) } })
        return
      }
      worker.onerror = (event) => {
        event.preventDefault?.()
        setState({ key: bytes, value: { status: 'error', error: event.message || 'The statistics worker failed.' } })
        worker.terminate()
      }
      worker.onmessage = (event) => {
        if (cancelled) return
        const message = event.data
        if (message.type === 'ack') {
          acked++
          if (acked === plan.chunks.length) worker.postMessage({ type: 'end' })
          else sendNext()
          return
        }
        if (firstMs === null) firstMs = performance.now() - t0
        const value = {
          status: message.type === 'done' ? 'done' : 'running',
          bytesSeen: message.bytesSeen,
          digraph: message.digraph,
          classCounts: message.classCounts,
          magic: message.magic || null,
          plan,
          firstMs,
          totalMs: message.type === 'done' ? performance.now() - t0 : null
        }
        if (message.type === 'done') {
          cache.set(bytes, { revision, value })
          worker.terminate()
          worker = null
        }
        setState({ key: bytes, value })
      }
      worker.postMessage({ type: 'start', size: bytes.length })
      setState(previous => ({
        key: bytes,
        value: { ...(previous.key === bytes ? previous.value : {}), status: 'running', plan, bytesSeen: 0 }
      }))
      for (let i = 0; i < IN_FLIGHT; i++) sendNext()
    }

    const timer = cached ? setTimeout(start, EDIT_DEBOUNCE_MS) : setTimeout(start, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
      worker?.terminate()
    }
  }, [bytes, revision, enabled])

  return state.key === bytes ? state.value : IDLE
}
