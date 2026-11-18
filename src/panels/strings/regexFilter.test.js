import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StringStore, collectMatches, compileFilter } from './store.js'
import { classify } from './classify.js'
import { regexShown, startRegexFilter } from './regexFilter.js'

// The real worker's message handler, run in this thread: `self` routes its
// replies to whichever fake worker is handling a message
let replyTo = null
globalThis.self = { postMessage: (data) => replyTo?.(data) }
await import('./filter.worker.js')
const workerHandler = globalThis.self.onmessage

/**
 * A stand-in for `new Worker(...)`. Messages are handled a turn later, as
 * in a browser. `stuckOn` makes it hang (reply nothing) on a chunk holding
 * that text; `ignoreTerminate` makes it keep replying after terminate(), to
 * check that the job itself drops late replies.
 */
class FakeWorker {
  constructor({ stuckOn = null, ignoreTerminate = false } = {}) {
    this.stuckOn = stuckOn
    this.ignoreTerminate = ignoreTerminate
    this.terminated = false
    this.onmessage = null
    this.onerror = null
  }

  postMessage(data) {
    setTimeout(() => {
      if (this.terminated && !this.ignoreTerminate) return
      if (data.type === 'chunk' && this.stuckOn !== null && data.texts.includes(this.stuckOn)) return
      const replies = []
      replyTo = (reply) => replies.push(reply)
      workerHandler({ data })
      replyTo = null
      for (const reply of replies) setTimeout(() => this.onmessage?.({ data: reply }), 0)
    }, 0)
  }

  terminate() {
    this.terminated = true
  }
}

function storeOf(texts, store = new StringStore()) {
  store.append({
    offsets: texts.map((_, i) => store.count * 16 + i * 16),
    lengths: texts.map(t => t.length),
    encodings: texts.map((_, i) => i % 3 === 0 ? 1 : 0),
    classes: texts.map(t => classify(t)),
    texts
  })
  return store
}

function words(n, seed = 1) {
  const out = []
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    out.push(['GetProcAddress', 'kernel32.dll', 'https://x.org/a', 'Error: %s', 'hello world', 'C:\\temp'][s % 6] + (s >>> 20))
  }
  return out
}

function run(store, filter, options = {}) {
  const updates = []
  return new Promise((resolve) => {
    startRegexFilter({
      store,
      regex: filter.regex,
      prefilter: filter.prefilter,
      createWorker: () => options.worker || new FakeWorker(),
      timeLimit: options.timeLimit,
      onUpdate(update) {
        updates.push({ ...update, list: update.list.slice(0, update.count) })
        if (update.status !== 'running') resolve({ updates, last: updates.at(-1) })
      }
    })
  })
}

test('the worker finds what the synchronous filter finds, across chunks and with class and encoding', async () => {
  const store = storeOf(words(70000))
  for (const query of ['/^get/', '/\\d{4}$/', '/DLL/', '/dll/s', '/^(?!h)/', '/zzz/']) {
    for (const extra of [{}, { encoding: 1 }, { classBit: 4 }]) {
      const filter = compileFilter({ query, ...extra })
      assert.ok(filter.regex)
      const { last } = await run(store, filter)
      assert.equal(last.status, 'done')
      assert.deepEqual(last.list, collectMatches(store, filter.test, 0, []))
      assert.equal(last.scanned, store.count)
    }
  }
})

test('a growing store: update() tests the new strings and reports again', async () => {
  const store = storeOf(words(3000, 2))
  const filter = compileFilter({ query: '/^get/' })
  const results = []
  let job = null
  await new Promise((resolve) => {
    job = startRegexFilter({
      store,
      regex: filter.regex,
      createWorker: () => new FakeWorker(),
      onUpdate(update) {
        if (update.status !== 'done') return
        results.push({ list: update.list.slice(0, update.count), scanned: update.scanned })
        if (results.length === 1) {
          storeOf(words(12000, 3), store)
          job.update()
        } else {
          resolve()
        }
      }
    })
  })
  assert.equal(results[0].scanned, 3000)
  assert.equal(results[1].scanned, 15000)
  assert.deepEqual(results[1].list, collectMatches(store, filter.test, 0, []))
  assert.deepEqual(results[1].list.slice(0, results[0].list.length), results[0].list)
})

test('a pattern stuck on one string is stopped after the time limit', async () => {
  const store = storeOf([...words(10000, 4), 'a'.repeat(26) + '!', ...words(100, 5)])
  const filter = compileFilter({ query: '/(a+)+$/' })
  const worker = new FakeWorker({ stuckOn: 'a'.repeat(26) + '!' })
  const started = Date.now()
  const { last, updates } = await run(store, filter, { worker, timeLimit: 80 })
  const waited = Date.now() - started
  assert.equal(last.status, 'slow')
  assert.ok(worker.terminated)
  assert.ok(waited >= 80 && waited < 1000, `stopped after ${waited} ms`)
  assert.ok(!updates.some(u => u.status === 'done'))
})

test('a slow filter that keeps reporting progress is not stopped', async () => {
  // Every chunk takes longer than the time limit, but the worker ticks
  class TickingWorker extends FakeWorker {
    postMessage(data) {
      if (data.type !== 'chunk') return super.postMessage(data)
      let ticks = 0
      const tick = setInterval(() => {
        if (++ticks < 6) return this.onmessage?.({ data: { type: 'tick' } })
        clearInterval(tick)
        super.postMessage(data)
      }, 20)
    }
  }
  const store = storeOf(words(9000, 6))
  const filter = compileFilter({ query: '/^get/' })
  const { last } = await run(store, filter, { worker: new TickingWorker(), timeLimit: 60 })
  assert.equal(last.status, 'done')
  assert.deepEqual(last.list, collectMatches(store, filter.test, 0, []))
})

test('a cancelled filter never reports, even if its worker answers late', async () => {
  const store = storeOf(words(20000, 7))
  const filter = compileFilter({ query: '/^get/' })
  const worker = new FakeWorker({ ignoreTerminate: true })
  let reported = 0
  const job = startRegexFilter({
    store,
    regex: filter.regex,
    createWorker: () => worker,
    onUpdate: () => reported++
  })
  job.cancel()
  job.update()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(reported, 0)
  assert.ok(worker.terminated)
})

test('an empty store reports at once', async () => {
  const { last } = await run(new StringStore(), compileFilter({ query: '/x/' }))
  assert.equal(last.status, 'done')
  assert.equal(last.count, 0)
})

test('which list is shown: the current result, else the previous list for the same strings', () => {
  const store = {}
  const other = {}
  const previous = { key: 'a', store, list: [1, 2], count: 2 }
  const result = { key: 'b', store, list: [3], count: 1 }
  // The filter's own result once ready
  assert.equal(regexShown({ key: 'b', store, current: { key: 'b', store, result }, previous }), result)
  // Still running, or stopped as too slow: the list as it was
  assert.equal(regexShown({ key: 'b', store, current: { key: 'b', store, result: null }, previous }), previous)
  // A result for an older pattern is never shown for a newer one
  assert.equal(regexShown({ key: 'c', store, current: { key: 'b', store, result }, previous }), previous)
  // Nor a result for strings that have since been rescanned
  assert.equal(regexShown({ key: 'b', store: other, current: { key: 'b', store, result }, previous }), null)
  assert.equal(regexShown({ key: 'b', store: other, current: null, previous }), null)
})
