import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSegments, layoutSegments, offsetToX, regionsOf } from './layout.js'

test('fills gaps and clips overlapping regions', () => {
  const segments = buildSegments([
    { name: 'b', offset: 50, length: 30, kind: 'data' },
    { name: 'a', offset: 10, length: 50, kind: 'header' },
    { name: 'inside', offset: 20, length: 5 }
  ], 100)
  assert.deepEqual(segments.map(s => [s.name, s.start, s.end, s.kind]), [
    ['Unmapped bytes', 0, 10, 'gap'],
    ['a', 10, 60, 'header'],
    ['b', 60, 80, 'data'],
    ['Unmapped bytes', 80, 100, 'gap']
  ])
  assert.deepEqual(buildSegments([], 100), [])
})

test('gives every segment a minimum width and the rest by size', () => {
  const laid = layoutSegments(buildSegments([
    { name: 'tiny', offset: 0, length: 1 },
    { name: 'big', offset: 1, length: 999 }
  ], 1000), 200, 10)
  assert.equal(laid.length, 2)
  assert.ok(laid[0].width >= 10)
  assert.ok(Math.abs(laid[0].width + laid[1].width - 200) < 1e-9)
  assert.equal(laid[1].left, laid[0].width)
})

test('merges runs of segments too small to show', () => {
  const regions = Array.from({ length: 1000 }, (_, i) => ({ name: `r${i}`, offset: i, length: 1, kind: i % 2 ? 'data' : 'table' }))
  regions.push({ name: 'rest', offset: 1000, length: 99000, kind: 'data' })
  const laid = layoutSegments(buildSegments(regions, 100000), 300, 10)
  assert.ok(laid.length <= 31)
  assert.ok(laid.some(item => item.kind === 'mixed' && item.count > 1))
  const total = laid.reduce((sum, item) => sum + item.width, 0)
  assert.ok(Math.abs(total - 300) < 1e-6)
  for (let i = 1; i < laid.length; i++) assert.equal(laid[i].start, laid[i - 1].end)
})

test('maps offsets to positions on the bar', () => {
  const laid = layoutSegments(buildSegments([{ name: 'a', offset: 0, length: 100 }], 100), 100, 10)
  assert.equal(offsetToX(laid, 50), 50)
  assert.equal(offsetToX(laid, 100), null)
})

test('falls back to top-level fields when there are no regions', () => {
  const analysis = { regions: [], fields: [{ name: 'Signature', offset: 0, length: 4, kind: 'magic' }, { name: 'Blob', offset: 4, length: 8, kind: 'data' }] }
  assert.deepEqual(regionsOf(analysis).map(r => r.kind), ['header', 'data'])
  assert.deepEqual(regionsOf(null), [])
})
