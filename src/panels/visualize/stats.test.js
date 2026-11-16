import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLASS_INDEX, cellColors, chunkPlan, createAccumulator, digraphMax, hilbertLayout, hilbertPixels, hilbertPoint
} from './stats.js'

test('chunkPlan covers small files exactly in order', () => {
  const plan = chunkPlan(2500, { chunkBytes: 1000 })
  assert.equal(plan.sampled, false)
  assert.equal(plan.covered, 2500)
  assert.deepEqual(plan.chunks, [
    { offset: 0, length: 1000, contiguous: false },
    { offset: 1000, length: 1000, contiguous: true },
    { offset: 2000, length: 500, contiguous: true }
  ])
  assert.deepEqual(chunkPlan(0).chunks, [])
})

test('chunkPlan samples evenly spaced blocks above the limit', () => {
  const plan = chunkPlan(10000, { exactLimit: 1000, blocks: 5, blockBytes: 100 })
  assert.equal(plan.sampled, true)
  assert.equal(plan.covered, 500)
  assert.deepEqual(plan.chunks.map(c => c.offset), [0, 2475, 4950, 7425, 9900])
  assert.ok(plan.chunks.every(c => !c.contiguous && c.offset + c.length <= 10000))
})

test('hilbertLayout picks the smallest square up to 256', () => {
  assert.deepEqual(hilbertLayout(0), { side: 1, cells: 1, cellBytes: 1 })
  assert.deepEqual(hilbertLayout(2), { side: 2, cells: 4, cellBytes: 1 })
  assert.deepEqual(hilbertLayout(1000), { side: 32, cells: 1024, cellBytes: 1 })
  assert.deepEqual(hilbertLayout(65536 * 10 + 1), { side: 256, cells: 65536, cellBytes: 11 })
})

test('hilbert curve visits every cell once, in steps of one, from top left to top right', () => {
  for (const side of [1, 2, 4, 16, 64]) {
    const pixels = hilbertPixels(side)
    assert.equal(new Set(pixels).size, side * side)
    for (let d = 1; d < side * side; d++) {
      const [x0, y0] = hilbertPoint(side, d - 1)
      const [x1, y1] = hilbertPoint(side, d)
      assert.equal(Math.abs(x1 - x0) + Math.abs(y1 - y0), 1)
    }
    assert.deepEqual(hilbertPoint(side, 0), [0, 0])
    assert.deepEqual(hilbertPoint(side, side * side - 1), [side - 1, 0])
  }
})

test('accumulator counts pairs across contiguous chunks only', () => {
  const acc = createAccumulator(6)
  acc.add(Uint8Array.of(1, 2, 3), 0, false)
  acc.add(Uint8Array.of(4, 5, 6), 3, true)
  assert.equal(acc.digraph[(1 << 8) | 2], 1)
  assert.equal(acc.digraph[(3 << 8) | 4], 1)
  assert.equal(acc.digraph.reduce((a, b) => a + b, 0), 5)
  assert.equal(digraphMax(acc.digraph), 1)

  const sampled = createAccumulator(100)
  sampled.add(Uint8Array.of(1, 2), 0, false)
  sampled.add(Uint8Array.of(3, 4), 50, false)
  assert.equal(sampled.digraph[(2 << 8) | 3], 0)
  assert.equal(sampled.bytesSeen, 4)
})

test('accumulator puts byte classes in the right cells', () => {
  // 64 KB + 1 byte -> 256x256 cells of 2 bytes
  const size = 65537
  const acc = createAccumulator(size)
  assert.equal(acc.layout.cellBytes, 2)
  const bytes = new Uint8Array(size)
  bytes[2] = 0x41
  bytes[3] = 0xff
  acc.add(bytes.subarray(0, 3), 0, false)
  acc.add(bytes.subarray(3), 3, true)
  const counts = cell => Array.from(acc.classCounts.subarray(cell * 5, cell * 5 + 5))
  assert.deepEqual(counts(0), [2, 0, 0, 0, 0])
  // cell 1 holds 0x41 (print) and 0xff
  assert.equal(counts(1)[CLASS_INDEX[0x41]], 1)
  assert.equal(counts(1)[CLASS_INDEX[0xff]], 1)
  // the last byte lands in the last cell
  assert.equal(counts(32768).reduce((a, b) => a + b, 0), 1)
})

test('cellColors mixes class colours and leaves empty cells transparent', () => {
  const colors = [[0, 0, 0], [200, 100, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const counts = new Uint32Array(10)
  counts[0] = 1
  counts[1] = 1
  const rgba = cellColors(counts, colors)
  assert.deepEqual(Array.from(rgba), [100, 50, 0, 255, 0, 0, 0, 0])
})
