import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildELF } from '../formats/__fixtures__/executables.js'
import { formatBytes } from '../formats/shared.js'

// A stand-in for the browser's Worker. `behaviour` decides what it does:
// 'answer' posts an analysis, 'hang' never answers, 'crash' fires an error
// event after loading, 'reject' posts an error message, 'unloadable' fails
// before it has loaded.
let behaviour = 'answer'
const created = []

class FakeWorker {
  constructor() {
    this.terminated = false
    this.mode = behaviour
    created.push(this)
    queueMicrotask(() => {
      if (this.mode === 'unloadable') this.onerror?.({ message: '', preventDefault() {} })
      else this.onmessage?.({ data: { ready: true } })
    })
  }

  postMessage({ id }) {
    queueMicrotask(() => {
      if (this.terminated) return
      if (this.mode === 'answer') this.onmessage?.({ data: { id, analysis: { formatId: 'from-worker' } } })
      if (this.mode === 'crash') this.onerror?.({ message: 'Uncaught RangeError: Maximum call stack size exceeded', preventDefault() {} })
      if (this.mode === 'reject') this.onmessage?.({ data: { id, error: 'boom' } })
    })
  }

  terminate() {
    this.terminated = true
  }
}

globalThis.Worker = FakeWorker

let copies = 0
// A fresh copy of the client for each test, so worker state does not leak between them
const freshClient = () => import(`./client.js?copy=${++copies}`)

const elfFile = () => new File([buildELF()], 'tool.elf', { type: 'application/x-elf' })

test('answers with the worker\'s analysis', async () => {
  behaviour = 'answer'
  const { analyzeFile } = await freshClient()
  assert.equal((await analyzeFile(elfFile())).formatId, 'from-worker')
})

test('a worker that crashes gets the generic facts and its error in a note, not a second parse on the page', async () => {
  behaviour = 'crash'
  const { analyzeFile } = await freshClient()
  const analysis = await analyzeFile(elfFile())
  assert.equal(analysis.gaveUp, 'crash')
  // The main-thread parser would have said 'elf'
  assert.equal(analysis.formatId, 'unknown')
  assert.deepEqual(analysis.summary.map(entry => `${entry.label}: ${entry.value}`).slice(0, 3), [
    `File Size: ${formatBytes(buildELF().byteLength)}`,
    'File Type: application/x-elf',
    'First Bytes: 0x7F454C46'
  ])
  assert.deepEqual(analysis.warnings, [
    'The analysis stopped with an error (Uncaught RangeError: Maximum call stack size exceeded), so only basic facts are shown. The hex view and byte tools still work on the whole file.'
  ])
  assert.ok(created.at(-1).terminated)
})

test('an error the worker reports is kept for the note', async () => {
  behaviour = 'reject'
  const { analyzeFile } = await freshClient()
  const analysis = await analyzeFile(elfFile())
  assert.equal(analysis.gaveUp, 'crash')
  assert.match(analysis.warnings[0], /^The analysis stopped with an error \(boom\)/)
})

test('a worker that does not answer in time is ended by the watchdog', async (t) => {
  behaviour = 'hang'
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { analyzeFile, timeoutFor } = await freshClient()
  const file = elfFile()
  const result = analyzeFile(file)
  await new Promise(resolve => queueMicrotask(resolve))
  t.mock.timers.tick(timeoutFor(file.size))
  const analysis = await result
  assert.equal(analysis.gaveUp, 'timeout')
  assert.equal(analysis.warnings[0], 'The analysis gave up after 20 seconds without finishing, so only basic facts are shown. The hex view and byte tools still work on the whole file.')
  assert.ok(created.at(-1).terminated)
})

test('the watchdog allows more time for bigger files', async () => {
  const { timeoutFor } = await freshClient()
  assert.equal(timeoutFor(0), 20000)
  assert.equal(timeoutFor(1 << 30), 20000 + 1024 * 100)
})

test('a worker that cannot load at all leaves the analysis to the page', async () => {
  behaviour = 'unloadable'
  const { analyzeFile } = await freshClient()
  const analysis = await analyzeFile(elfFile())
  assert.equal(analysis.formatId, 'elf')
  assert.equal(analysis.gaveUp, undefined)
})

test('after a crash the next file gets a new worker', async () => {
  behaviour = 'crash'
  const { analyzeFile } = await freshClient()
  assert.equal((await analyzeFile(elfFile())).gaveUp, 'crash')
  behaviour = 'answer'
  assert.equal((await analyzeFile(elfFile())).formatId, 'from-worker')
})
