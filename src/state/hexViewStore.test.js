import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHexViewStore } from './hexViewStore.js'

const view = (start, end, bytesPerRow = 16, visibleRows = 10) => ({ start, end, bytesPerRow, visibleRows })

test('starts empty and reports the latest values at once', () => {
  const store = createHexViewStore({ schedule: callback => callback() })
  assert.equal(store.getCursor(), null)
  assert.equal(store.getViewport(), null)
  store.setCursor(42)
  store.setViewport(view(0, 160))
  assert.equal(store.reader.getCursor(), 42)
  assert.deepEqual(store.reader.getViewport(), view(0, 160))
  store.reporter.setCursor(null)
  store.reporter.setViewport(null)
  assert.equal(store.getCursor(), null)
  assert.equal(store.getViewport(), null)
})

test('notifies cursor and viewport subscribers separately, only on change', () => {
  const store = createHexViewStore({ schedule: callback => callback() })
  const calls = []
  store.subscribeCursor(() => calls.push('cursor'))
  const stop = store.subscribeViewport(() => calls.push('viewport'))
  store.setCursor(1)
  store.setCursor(1)
  store.setViewport(view(16, 176))
  const first = store.getViewport()
  store.setViewport(view(16, 176))
  assert.equal(store.getViewport(), first, 'an equal viewport keeps its identity')
  store.setCursor(Number.NaN)
  assert.equal(store.getCursor(), null)
  stop()
  store.setViewport(view(32, 192))
  assert.deepEqual(calls, ['cursor', 'viewport', 'cursor'])
})

test('coalesces changes until the scheduled notification runs', () => {
  const pending = []
  const store = createHexViewStore({ schedule: callback => pending.push(callback) })
  let cursorCalls = 0
  let viewportCalls = 0
  store.subscribeCursor(() => cursorCalls++)
  store.subscribeViewport(() => viewportCalls++)
  store.setCursor(1)
  store.setCursor(2)
  store.setCursor(3)
  assert.equal(pending.length, 1)
  assert.equal(cursorCalls, 0)
  assert.equal(store.getCursor(), 3)
  pending.shift()()
  assert.equal(cursorCalls, 1)
  assert.equal(viewportCalls, 0)
  store.setViewport(view(0, 16))
  pending.shift()()
  assert.equal(viewportCalls, 1)
})

test('notifies after the code that made the changes has finished, by default', async () => {
  const store = createHexViewStore()
  let calls = 0
  store.subscribeCursor(() => calls++)
  store.setCursor(5)
  store.setCursor(6)
  assert.equal(calls, 0)
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(store.getCursor(), 6)
})
