/**
 * Feeds a byte range to a worker in chunks, so that work over a large file
 * runs off the main thread without copying the whole file at once. The hex
 * view edits the bytes in place, so each chunk is copied from the live
 * bytes just before it is sent: at most a few chunks exist as copies at any
 * time. Also used by the strings and entropy panels.
 *
 * Protocol:
 *   main → worker  { type: 'begin', params }
 *   main → worker  { type: 'chunk', data: ArrayBuffer, offset, from, last }
 *                  `data` starts at absolute `offset`; bytes before `from`
 *                  were already in the previous chunk (see `overlap`)
 *   worker → main  { type: 'ack' } after each chunk, plus any messages of
 *                  its own; { type: 'done', ... } ends the job
 */

const IN_FLIGHT = 2

/**
 * @param {Object} options
 * @param {() => Worker} options.createWorker
 * @param {Uint8Array} options.bytes
 * @param {number} [options.start]
 * @param {number} [options.end]
 * @param {*} [options.params]          sent with 'begin'
 * @param {number} [options.chunkSize]
 * @param {number} [options.firstChunkSize]   smaller first chunk, for a quick first result
 * @param {number} [options.overlap]    bytes of the previous chunk repeated at the start of the next
 * @param {(message: any) => void} options.onMessage   every worker message except 'ack'
 * @param {(error: Error) => void} options.onError
 * @returns {{ cancel: () => void }}
 */
export function streamToWorker({
  createWorker, bytes, start = 0, end = bytes.length, params,
  chunkSize = 4 << 20, firstChunkSize = chunkSize, overlap = 0, onMessage, onError
}) {
  let worker
  let finished = false
  let next = start
  let inFlight = 0

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
    while (!finished && inFlight < IN_FLIGHT && (next < end || next === start)) {
      const from = next
      const to = Math.min(end, from + (from === start ? firstChunkSize : chunkSize))
      const offset = Math.max(start, from - overlap)
      const data = bytes.slice(offset, to).buffer
      next = to === from ? to + 1 : to
      inFlight++
      worker.postMessage({ type: 'chunk', data, offset, from, last: to >= end }, [data])
    }
  }

  try {
    worker = createWorker()
  } catch (error) {
    queueMicrotask(() => fail(error instanceof Error ? error : new Error(String(error))))
    return { cancel: stop }
  }
  worker.onmessage = (event) => {
    if (finished) return
    const message = event.data || {}
    if (message.type === 'ack') {
      inFlight--
      send()
      return
    }
    if (message.type === 'done') stop()
    onMessage(message)
  }
  worker.onerror = (event) => {
    event.preventDefault?.()
    fail(new Error(event.message || 'The worker failed'))
  }
  worker.onmessageerror = () => fail(new Error('The worker sent an unreadable message'))
  worker.postMessage({ type: 'begin', params })
  send()
  return { cancel: stop }
}

/**
 * Worker side: wires `self.onmessage` to a handler object.
 * `begin(params)` runs first; `chunk(bytes, offset, from, last)` runs for
 * each chunk and may post its own messages before the ack is sent.
 * @param {{ begin: (params: any) => void, chunk: (bytes: Uint8Array, offset: number, from: number, last: boolean) => void }} handler
 */
export function acceptChunks(handler) {
  self.onmessage = (event) => {
    const message = event.data || {}
    if (message.type === 'begin') {
      handler.begin(message.params)
    } else if (message.type === 'chunk') {
      handler.chunk(new Uint8Array(message.data), message.offset, message.from, message.last)
      self.postMessage({ type: 'ack' })
    }
  }
}
