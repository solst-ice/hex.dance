import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PIN_LIMIT, createPosterPins } from './posterPins.js'

test('toggles a field on and off, kept in file order', () => {
  const store = createPosterPins()
  assert.deepEqual(store.getPins(), [])
  assert.equal(store.toggle({ offset: 0x80, length: 4, name: 'Signature' }), 'pinned')
  assert.equal(store.toggle({ offset: 0x3c, length: 4, name: 'e_lfanew' }), 'pinned')
  assert.deepEqual(store.getPins().map(pin => pin.name), ['e_lfanew', 'Signature'])
  assert.equal(store.isPinned(0x3c, 4), true)
  assert.equal(store.toggle({ offset: 0x3c, length: 4, name: 'e_lfanew' }), 'unpinned')
  assert.equal(store.isPinned(0x3c, 4), false)
  assert.deepEqual(store.getPins(), [{ offset: 0x80, length: 4, name: 'Signature' }])
})

test('a field is the same pin by offset and length, whatever its name', () => {
  const store = createPosterPins()
  store.toggle({ offset: 16, length: 2, name: 'a' })
  assert.equal(store.isPinned(16, 2), true)
  assert.equal(store.isPinned(16, 4), false, 'same offset, other length: another field')
  assert.equal(store.toggle({ offset: 16, length: 4, name: 'a' }), 'pinned')
  assert.equal(store.toggle({ offset: 16, length: 2, name: 'renamed' }), 'unpinned')
  assert.deepEqual(store.getPins(), [{ offset: 16, length: 4, name: 'a' }])
})

test('stops at the limit and says so', () => {
  const store = createPosterPins()
  for (let i = 0; i < PIN_LIMIT; i++) assert.equal(store.toggle({ offset: i * 8, length: 8, name: `f${i}` }), 'pinned')
  assert.equal(store.toggle({ offset: 9999, length: 1, name: 'one too many' }), 'full')
  assert.equal(store.getPins().length, PIN_LIMIT)
  // Unpinning still works when full, and makes room
  assert.equal(store.toggle({ offset: 0, length: 8 }), 'unpinned')
  assert.equal(store.toggle({ offset: 9999, length: 1, name: 'fits now' }), 'pinned')
  const small = createPosterPins({ limit: 1 })
  small.toggle({ offset: 0, length: 1 })
  assert.equal(small.toggle({ offset: 1, length: 1 }), 'full')
})

test('ignores ranges that are not fields', () => {
  const store = createPosterPins()
  for (const field of [null, {}, { offset: -1, length: 4 }, { offset: 0, length: 0 }, { offset: 1.5, length: 2 }, { offset: 0, length: Number.NaN }]) {
    assert.equal(store.toggle(field), 'invalid')
  }
  assert.deepEqual(store.getPins(), [])
  store.toggle({ offset: 0, length: 1, name: 42 })
  assert.equal(store.getPins()[0].name, '42', 'names are kept as text')
})

test('remove, clear and reset (opening another file) notify only on change', () => {
  const store = createPosterPins()
  let calls = 0
  const stop = store.subscribe(() => calls++)
  store.toggle({ offset: 0, length: 4, name: 'a' })
  store.toggle({ offset: 4, length: 4, name: 'b' })
  assert.equal(calls, 2)
  const before = store.getPins()
  store.remove(100, 1)
  assert.equal(calls, 2, 'removing something not pinned changes nothing')
  assert.equal(store.getPins(), before, 'and keeps the identity')
  store.remove(0, 4)
  assert.deepEqual(store.getPins().map(pin => pin.name), ['b'])
  store.reset()
  assert.deepEqual(store.getPins(), [])
  assert.equal(calls, 4)
  store.clear()
  assert.equal(calls, 4, 'clearing an empty list says nothing')
  stop()
  store.toggle({ offset: 0, length: 4 })
  assert.equal(calls, 4)
})

test('every change gives a new list, so readers see it', () => {
  const store = createPosterPins()
  const seen = new Set([store.getPins()])
  store.toggle({ offset: 0, length: 1 })
  seen.add(store.getPins())
  store.toggle({ offset: 2, length: 1 })
  seen.add(store.getPins())
  store.clear()
  seen.add(store.getPins())
  assert.equal(seen.size, 4)
})
