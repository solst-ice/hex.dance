// Runs the embedded-file scan off the main thread. The file's bytes stay on
// the main thread: the scan asks for each window it needs with a 'read'
// message, so only the chunks being looked at are ever copied here.
//
//   main → worker  { type: 'start', size }
//   worker → main  { type: 'read', id, start, end }
//   main → worker  { type: 'bytes', id, data: ArrayBuffer }
//   worker → main  { type: 'hits', hits, position }   new or updated hits, progress
//   worker → main  { type: 'done', stats, lastNonZero, capped, stoppedAt, fetched } | { type: 'error', message }

import { FORMATS } from '../../formats/index.js'
import { ByteSource } from './source.js'
import { scanFile } from './scan.js'

const waiting = new Map()
let nextId = 0

function fetchBytes(start, end) {
  return new Promise(resolve => {
    const id = nextId++
    waiting.set(id, resolve)
    self.postMessage({ type: 'read', id, start, end })
  })
}

async function run(size) {
  const source = new ByteSource(size, fetchBytes)
  let batch = []
  let lastPost = 0
  const flush = (position) => {
    self.postMessage({ type: 'hits', hits: batch, position })
    batch = []
    lastPost = Date.now()
  }
  const result = await scanFile({
    source,
    formats: FORMATS,
    onHit: hit => batch.push({ ...hit }),
    onUpdate: hit => batch.push({ ...hit }),
    onProgress(position) {
      if (batch.length || Date.now() - lastPost > 100) flush(position)
    }
  })
  flush(size)
  self.postMessage({
    type: 'done',
    stats: result.stats,
    lastNonZero: result.lastNonZero,
    capped: result.capped,
    stoppedAt: result.stoppedAt,
    fetched: source.fetched
  })
}

self.onmessage = (event) => {
  const message = event.data || {}
  if (message.type === 'start') {
    run(message.size).catch(error => self.postMessage({ type: 'error', message: String(error?.message || error) }))
  } else if (message.type === 'bytes') {
    const resolve = waiting.get(message.id)
    waiting.delete(message.id)
    resolve?.(new Uint8Array(message.data))
  }
}
