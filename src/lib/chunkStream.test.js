import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptChunks, streamToWorker } from './chunkStream.js'

// A fake worker running acceptChunks in the same thread; `self` is its scope
// while it handles a message
function fakeWorker(handler) {
  const page = {}
  const scope = {
    onmessage: null,
    postMessage: message => queueMicrotask(() => page.worker.onmessage?.({ data: message }))
  }
  page.worker = {
    terminated: false,
    onmessage: null,
    postMessage(message) {
      if (this.terminated) return
      queueMicrotask(() => {
        globalThis.self = scope
        scope.onmessage({ data: message })
      })
    },
    terminate() { this.terminated = true }
  }
  globalThis.self = scope
  acceptChunks(handler(scope))
  return page.worker
}

test('streams a range in chunks with overlap, waits for acks and finishes', async () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i)
  const seen = []
  let worker
  const result = await new Promise((resolve, reject) => {
    streamToWorker({
      createWorker: () => (worker = fakeWorker(scope => ({
        begin: params => seen.push(['begin', params]),
        chunk: (data, offset, from, last) => {
          seen.push([offset, from, data.length, data[0], last])
          if (last) scope.postMessage({ type: 'done', total: from })
        }
      }))),
      bytes,
      start: 10,
      end: 95,
      params: { k: 1 },
      chunkSize: 30,
      firstChunkSize: 10,
      overlap: 4,
      onMessage: resolve,
      onError: reject
    })
  })
  assert.deepEqual(seen, [
    ['begin', { k: 1 }],
    [10, 10, 10, 10, false],
    [16, 20, 34, 16, false],
    [46, 50, 34, 46, false],
    [76, 80, 19, 76, true]
  ])
  assert.equal(result.type, 'done')
  assert.equal(worker.terminated, true)
})

test('reports a worker that cannot start, and cancels', async () => {
  const error = await new Promise(resolve => {
    streamToWorker({ createWorker: () => { throw new Error('no workers') }, bytes: new Uint8Array(4), onMessage: () => {}, onError: resolve })
  })
  assert.equal(error.message, 'no workers')
  let worker
  const job = streamToWorker({
    createWorker: () => (worker = fakeWorker(() => ({ begin() {}, chunk() {} }))),
    bytes: new Uint8Array(1000),
    chunkSize: 10,
    onMessage: () => assert.fail('no messages after cancel'),
    onError: () => assert.fail('no error after cancel')
  })
  job.cancel()
  assert.equal(worker.terminated, true)
})
