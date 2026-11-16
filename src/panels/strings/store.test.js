import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StringStore, collectMatches, compileFilter, lowerBound } from './store.js'
import { CLASSES, classify } from './classify.js'

function storeOf(items) {
  const store = new StringStore()
  // Two batches, to exercise growth and appending
  for (const part of [items.slice(0, 2), items.slice(2)]) {
    store.append({
      offsets: part.map(p => p[0]),
      lengths: part.map(p => p[2].length),
      encodings: part.map(p => p[1]),
      classes: part.map(p => classify(p[2])),
      texts: part.map(p => p[2])
    })
  }
  return store
}

const items = [
  [0x10, 0, 'GetProcAddress'],
  [0x40, 1, 'https://example.com/x'],
  [0x90, 0, 'Error: cannot open %s'],
  [0x100, 0, 'C:\\Windows\\System32'],
  [0x200, 1, 'kernel32.dll']
]

const run = (store, filter) => {
  const { test: predicate, error } = compileFilter(filter)
  assert.equal(error, null)
  return predicate ? collectMatches(store, predicate, 0, []) : null
}

test('appends batches and counts classes and encodings', () => {
  const store = storeOf(items)
  assert.equal(store.count, 5)
  assert.deepEqual(store.encodingCounts, [3, 2])
  const url = CLASSES.findIndex(c => c.id === 'url')
  assert.equal(store.classCounts[url], 1)
  assert.equal(store.byteLength(1), 42)
  assert.equal(store.offsets[4], 0x200)
})

test('filters by text, class, encoding and regex', () => {
  const store = storeOf(items)
  assert.equal(run(store, {}), null)
  assert.deepEqual(run(store, { query: 'KERNEL' }), [4])
  assert.deepEqual(run(store, { query: '32' }), [3, 4])
  assert.deepEqual(run(store, { query: 'c:\\win' }), [3])
  assert.deepEqual(run(store, { encoding: 1 }), [1, 4])
  assert.deepEqual(run(store, { classBit: 8 }), [3])
  assert.deepEqual(run(store, { query: '/^get|dll$/' }), [0, 4])
  assert.deepEqual(run(store, { query: 'e', encoding: 0, classBit: 64 }), [2])
  assert.match(compileFilter({ query: '/(/' }).error, /./)
})

test('lowerBound', () => {
  assert.equal(lowerBound([1, 3, 5], 0), 0)
  assert.equal(lowerBound([1, 3, 5], 3), 1)
  assert.equal(lowerBound([1, 3, 5], 4), 2)
  assert.equal(lowerBound([1, 3, 5], 9), 3)
})
