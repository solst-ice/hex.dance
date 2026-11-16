import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ByteStats, MAX_POINTS, MIN_BLOCK, chooseBlockSize, describe, entropyOf, summarize } from './stats.js'

function statsOf(bytes, blockSize, pieces = 1) {
  const stats = new ByteStats(bytes.length, blockSize)
  const step = Math.ceil(bytes.length / pieces) || 1
  for (let i = 0; i < bytes.length; i += step) stats.update(bytes, i, Math.min(bytes.length, i + step))
  return stats
}

test('block size keeps the point count in range', () => {
  assert.equal(chooseBlockSize(0), MIN_BLOCK)
  assert.equal(chooseBlockSize(39), MIN_BLOCK)
  for (const size of [1000, 1 << 20, 20 << 20, 124902584, 2 ** 31]) {
    const block = chooseBlockSize(size)
    const points = Math.ceil(size / block)
    assert.ok(points <= MAX_POINTS, `${size}: ${points}`)
    assert.ok(block === MIN_BLOCK || points > MAX_POINTS / 2, `${size}: ${points}`)
  }
})

test('entropy of simple distributions', () => {
  const counts = new Float64Array(256)
  assert.equal(entropyOf(counts, 0), 0)
  counts[7] = 100
  assert.equal(entropyOf(counts, 100), 0)
  counts[8] = 100
  assert.equal(entropyOf(counts, 200), 1)
  counts.fill(4)
  assert.ok(Math.abs(entropyOf(counts, 1024) - 8) < 1e-12)
})

test('per-block entropy, zero share and histogram, fed in pieces', () => {
  const bytes = new Uint8Array(256 * 3 + 10)
  for (let i = 0; i < 256; i++) bytes[i] = i // block 0: uniform, 8 bits
  // block 1: zeros; block 2: two values
  for (let i = 512; i < 768; i++) bytes[i] = i & 1 ? 0x41 : 0x42
  bytes.fill(0x20, 768) // short last block
  for (const pieces of [1, 3, 7, 100]) {
    const stats = statsOf(bytes, 256, pieces)
    assert.equal(stats.points, 4)
    assert.deepEqual(Array.from(stats.entropy, e => Math.round(e * 1000) / 1000), [8, 0, 1, 0])
    assert.deepEqual(Array.from(stats.zeros), [1, 255, 0, 0])
    assert.equal(stats.histogram[0x41], 129)
    assert.equal(stats.histogram[0], 257)
    assert.equal(stats.histogram.reduce((a, b) => a + b), bytes.length)
  }
})

test('summary and reading', () => {
  const text = new TextEncoder().encode('The quick brown fox jumps over the lazy dog.\n'.repeat(200))
  let stats = statsOf(text, chooseBlockSize(text.length))
  let summary = summarize(stats.histogram)
  assert.ok(summary.printableShare === 1)
  assert.equal(summary.mostCommon[0], 0x20)
  assert.equal(summary.missing.length, 256 - summary.distinct)
  assert.match(describe(stats, summary)[0], /Mostly text/)

  const random = new Uint8Array(1 << 20)
  let seed = 1
  for (let i = 0; i < random.length; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    random[i] = seed >>> 24
  }
  stats = statsOf(random, chooseBlockSize(random.length), 5)
  summary = summarize(stats.histogram)
  assert.ok(summary.entropy > 7.99)
  assert.match(describe(stats, summary)[0], /compressed or encrypted throughout/)

  const sparse = new Uint8Array(1 << 20)
  sparse.set(random.subarray(0, 1 << 18), 1 << 19)
  stats = statsOf(sparse, chooseBlockSize(sparse.length))
  summary = summarize(stats.histogram)
  const reading = describe(stats, summary).join(' ')
  assert.match(reading, /Partly compressed or encrypted: 25%/)
  assert.match(reading, /zero-filled areas: 75%/)

  assert.deepEqual(describe(new ByteStats(0), summarize(new Float64Array(256))), ['The file is empty.'])
})
