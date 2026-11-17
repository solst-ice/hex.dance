import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHexViewStore } from './hexViewStore.js'
import { createGatedHexViewStore } from './gatedHexViewStore.js'

const now = callback => callback()
const view = (start, end) => ({ start, end, bytesPerRow: 16, visibleRows: 10 })

test('passes changes through while live', () => {
  const source = createHexViewStore({ schedule: now })
  const gated = createGatedHexViewStore(source)
  let calls = 0
  gated.subscribeCursor(() => calls++)
  source.setCursor(4)
  assert.equal(calls, 1)
  assert.equal(gated.getCursor(), 4)
  assert.equal(gated.reader, source.reader)
})

test('holds the last values and stays quiet while paused, then catches up once', () => {
  const source = createHexViewStore({ schedule: now })
  source.setCursor(1)
  source.setViewport(view(0, 160))
  const gated = createGatedHexViewStore(source)
  const calls = []
  gated.subscribeCursor(() => calls.push('cursor'))
  gated.subscribeViewport(() => calls.push('viewport'))

  gated.setLive(false)
  source.setCursor(2)
  source.setCursor(3)
  source.setViewport(view(16, 176))
  assert.deepEqual(calls, [])
  assert.equal(gated.getCursor(), 1)
  assert.deepEqual(gated.getViewport(), view(0, 160))

  gated.setLive(true)
  assert.deepEqual(calls, ['cursor', 'viewport'])
  assert.equal(gated.getCursor(), 3)
  assert.deepEqual(gated.getViewport(), view(16, 176))
})

test('says nothing on resume when nothing changed', () => {
  const source = createHexViewStore({ schedule: now })
  source.setCursor(7)
  const gated = createGatedHexViewStore(source, false)
  let calls = 0
  gated.subscribeCursor(() => calls++)
  gated.setLive(true)
  gated.setLive(true)
  assert.equal(calls, 0)
  assert.equal(gated.isLive(), true)
})

test('subscribes to the source only while it has subscribers', () => {
  const source = createHexViewStore({ schedule: now })
  let sourceSubscriptions = 0
  const counting = {
    ...source,
    subscribeCursor: (listener) => {
      sourceSubscriptions++
      const stop = source.subscribeCursor(listener)
      return () => { sourceSubscriptions--; stop() }
    }
  }
  const gated = createGatedHexViewStore(counting)
  const stopA = gated.subscribeCursor(() => {})
  const stopB = gated.subscribeCursor(() => {})
  assert.equal(sourceSubscriptions, 1)
  stopA()
  assert.equal(sourceSubscriptions, 1)
  stopB()
  assert.equal(sourceSubscriptions, 0)
})
