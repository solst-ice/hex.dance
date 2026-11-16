import { test } from 'node:test'
import assert from 'node:assert/strict'
import { highlightWindow, itemAt, itemCount, itemNear, rangeAfter } from './items.js'

const ranges = { starts: [10, 20, 40], ends: [12, 30, 41], diffs: [2, 5, 1], length: 3 }
const sameSize = { sizeA: 100, sizeB: 100, common: 100 }
const longerB = { sizeA: 50, sizeB: 80, common: 50 }

test('items include the size difference', () => {
  assert.equal(itemCount(sameSize, ranges), 3)
  assert.equal(itemCount(longerB, ranges), 4)
  assert.deepEqual(itemAt(longerB, ranges, 3), { start: 50, end: 80, diffs: 30, kind: 'tail', only: 'B' })
  assert.equal(itemAt(sameSize, ranges, 3), null)
  assert.deepEqual(itemAt(sameSize, ranges, 1), { start: 20, end: 30, diffs: 5, kind: 'range' })
})

test('finding the item for an offset', () => {
  assert.equal(rangeAfter(ranges, 0), 0)
  assert.equal(rangeAfter(ranges, 11), 0)
  assert.equal(rangeAfter(ranges, 12), 1)
  assert.equal(rangeAfter(ranges, 41), 3)
  assert.equal(itemNear(sameSize, ranges, 35), 2)
  assert.equal(itemNear(sameSize, ranges, 90), 2)
  assert.equal(itemNear(longerB, ranges, 60), 3)
  assert.equal(itemNear(sameSize, { starts: [], ends: [], length: 0 }, 5), -1)
})

test('highlight window', () => {
  assert.deepEqual(highlightWindow(ranges, 0), { key: 'all', from: 0, to: 3 })
  const many = { starts: [], ends: [], length: 10000 }
  for (let i = 0; i < 10000; i++) {
    many.starts.push(i * 10)
    many.ends.push(i * 10 + 1)
  }
  assert.deepEqual(highlightWindow(many, 0, 2000), { key: '0', from: 0, to: 2000 })
  const middle = highlightWindow(many, 50000, 2000)
  assert.ok(middle.from <= 5000 && middle.to > 5000)
  assert.equal(middle.to - middle.from, 2000)
  assert.equal(highlightWindow(many, 50010, 2000).key, middle.key)
  assert.deepEqual(highlightWindow(many, 1e9, 2000), { key: '8000', from: 8000, to: 10000 })
})
