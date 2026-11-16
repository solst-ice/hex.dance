import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { downloadBlob, downloadBytes, downloadText } from './download.js'

const saved = {}
function stub(name, value) {
  if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
afterEach(() => {
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
    delete saved[name]
  }
})

function fakePage() {
  const log = []
  const blobs = []
  stub('URL', { createObjectURL: blob => { blobs.push(blob); return `blob:${blobs.length}` }, revokeObjectURL: url => log.push(['revoke', url]) })
  stub('document', {
    createElement: () => ({ click() { log.push(['click', this.href, this.download, this.rel]) }, remove: () => log.push(['remove']) }),
    body: { appendChild: () => log.push(['append']) }
  })
  stub('setTimeout', (callback, ms) => { log.push(['timer', ms]); callback() })
  return { log, blobs }
}

test('saves a blob through a temporary link and frees the URL later', () => {
  const { log } = fakePage()
  downloadBlob(new Blob(['x']), 'a.txt')
  assert.deepEqual(log, [['append'], ['click', 'blob:1', 'a.txt', 'noopener'], ['remove'], ['timer', 10000], ['revoke', 'blob:1']])
})

test('wraps bytes and text in blobs of the right type', async () => {
  const { blobs } = fakePage()
  downloadBytes(new Uint8Array([1, 2, 3]), 'b.bin')
  downloadText('hi', 'c.txt')
  assert.equal(blobs[0].type, 'application/octet-stream')
  assert.deepEqual([...new Uint8Array(await blobs[0].arrayBuffer())], [1, 2, 3])
  assert.equal(blobs[1].type, 'text/plain')
  assert.equal(await blobs[1].text(), 'hi')
})
