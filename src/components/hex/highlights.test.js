import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHighlightIndex, segmentsIn, highlightAt } from './highlights.js'

const ids = segs => segs.map(s => [s.start, s.end, s.highlight.id])

test('no highlights gives an empty index', () => {
  for (const input of [undefined, null, [], [null, { start: 5, end: 5 }, { start: 'a', end: 9 }]]) {
    const index = buildHighlightIndex(input)
    assert.deepEqual(index.segments, [])
    assert.equal(highlightAt(index, 0), null)
    assert.deepEqual(segmentsIn(index, 0, 100), [])
  }
})

test('separate ranges are found by offset and by window', () => {
  const index = buildHighlightIndex([
    { id: 'b', start: 20, end: 30 },
    { id: 'a', start: 0, end: 4 }
  ])
  assert.equal(highlightAt(index, 0).id, 'a')
  assert.equal(highlightAt(index, 3).id, 'a')
  assert.equal(highlightAt(index, 4), null)
  assert.equal(highlightAt(index, 29).id, 'b')
  assert.equal(highlightAt(index, 30), null)
  assert.deepEqual(ids(segmentsIn(index, 2, 21)), [[0, 4, 'a'], [20, 30, 'b']])
  assert.deepEqual(ids(segmentsIn(index, 4, 20)), [])
})

test('the shortest of overlapping ranges wins', () => {
  const index = buildHighlightIndex([
    { id: 'file', start: 0, end: 100 },
    { id: 'header', start: 0, end: 16 },
    { id: 'magic', start: 0, end: 4 }
  ])
  assert.deepEqual(ids(index.segments), [[0, 4, 'magic'], [4, 16, 'header'], [16, 100, 'file']])
})

test('equal-length overlaps go to the later range, partial overlaps split', () => {
  const index = buildHighlightIndex([
    { id: 'x', start: 0, end: 10 },
    { id: 'y', start: 5, end: 15 }
  ])
  assert.deepEqual(ids(index.segments), [[0, 5, 'x'], [5, 15, 'y']])
  const swapped = buildHighlightIndex([
    { id: 'y', start: 5, end: 15 },
    { id: 'x', start: 0, end: 10 }
  ])
  assert.deepEqual(ids(swapped.segments), [[0, 10, 'x'], [10, 15, 'y']])
})

test('a long range keeps winning after a short one inside it ends', () => {
  const index = buildHighlightIndex([
    { id: 'outer', start: 0, end: 50 },
    { id: 'inner', start: 10, end: 12 },
    { id: 'later', start: 40, end: 60 }
  ])
  assert.deepEqual(ids(index.segments), [
    [0, 10, 'outer'], [10, 12, 'inner'], [12, 40, 'outer'], [40, 60, 'later']
  ])
})

test('thousands of ranges index quickly and look up correctly', () => {
  const hl = []
  for (let i = 0; i < 20000; i++) hl.push({ id: i, start: i * 100, end: i * 100 + 60 })
  hl.push({ id: 'all', start: 0, end: 2_000_000 })
  const t0 = Date.now()
  const index = buildHighlightIndex(hl)
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(highlightAt(index, 1_234_510).id, 12345)
  assert.equal(highlightAt(index, 1_234_570).id, 'all')
  assert.equal(segmentsIn(index, 1_000_000, 1_000_032).length, 1)
  assert.equal(segmentsIn(index, 1_000_050, 1_000_150).length, 3)
})

test('ranges near 2 GB work', () => {
  const index = buildHighlightIndex([{ id: 'end', start: 2 ** 31 - 4, end: 2 ** 31 }])
  assert.equal(highlightAt(index, 2 ** 31 - 1).id, 'end')
  assert.equal(highlightAt(index, 2 ** 31 - 5), null)
})
