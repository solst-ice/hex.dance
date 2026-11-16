import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDiffer, diffBytes } from './diff.js'

function random(length, seed = 1) {
  const bytes = new Uint8Array(length)
  let x = seed
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    bytes[i] = x >>> 24
  }
  return bytes
}

function flip(bytes, offsets) {
  const copy = bytes.slice()
  for (const offset of offsets) copy[offset] ^= 0xff
  return copy
}

// Reference: every differing offset, then merged with the gap rule
function reference(a, b, gap) {
  const common = Math.min(a.length, b.length)
  const ranges = []
  let count = 0
  for (let i = 0; i < common; i++) {
    if (a[i] === b[i]) continue
    count++
    const last = ranges[ranges.length - 1]
    if (last && i - last.end <= gap) {
      last.end = i + 1
      last.diffs++
    } else {
      ranges.push({ start: i, end: i + 1, diffs: 1 })
    }
  }
  return { count, ranges }
}

test('identical inputs have no differences', () => {
  const a = random(10000)
  const { stats, ranges } = diffBytes(a, a.slice())
  assert.equal(stats.diffBytes, 0)
  assert.equal(stats.rangeCount, 0)
  assert.equal(stats.firstDiff, -1)
  assert.equal(stats.lastDiff, -1)
  assert.deepEqual(ranges, [])
})

test('empty files', () => {
  const empty = new Uint8Array(0)
  let result = diffBytes(empty, empty)
  assert.equal(result.stats.common, 0)
  assert.equal(result.stats.diffBytes, 0)
  assert.equal(result.stats.density.length, 0)
  result = diffBytes(empty, random(100))
  assert.equal(result.stats.common, 0)
  assert.equal(result.stats.sizeB, 100)
  assert.equal(result.stats.diffBytes, 0)
  assert.deepEqual(result.ranges, [])
})

test('single flipped bytes at the start, middle and end', () => {
  const a = random(4097)
  for (const offset of [0, 2048, 4096]) {
    const { stats, ranges } = diffBytes(a, flip(a, [offset]), { chunkSize: 1000 })
    assert.equal(stats.diffBytes, 1)
    assert.deepEqual(ranges, [{ start: offset, end: offset + 1, diffs: 1 }])
    assert.equal(stats.firstDiff, offset)
    assert.equal(stats.lastDiff, offset)
  }
})

test('gap tolerance merges near-contiguous changes', () => {
  const a = new Uint8Array(100)
  const b = flip(a, [10, 11, 14, 20, 40])
  assert.deepEqual(diffBytes(a, b, { gap: 0 }).ranges.map(r => [r.start, r.end]), [[10, 12], [14, 15], [20, 21], [40, 41]])
  assert.deepEqual(diffBytes(a, b, { gap: 2 }).ranges.map(r => [r.start, r.end]), [[10, 15], [20, 21], [40, 41]])
  assert.deepEqual(diffBytes(a, b, { gap: 5 }).ranges.map(r => [r.start, r.end, r.diffs]), [[10, 21, 4], [40, 41, 1]])
  assert.equal(diffBytes(a, b, { gap: 100 }).stats.rangeCount, 1)
})

test('runs and gaps that cross chunk boundaries', () => {
  const a = random(5000, 7)
  const changed = []
  for (let i = 0; i < 5000; i += 97) changed.push(i, i + 1, i + 2)
  for (let i = 995; i < 1010; i++) changed.push(i)
  const b = flip(a, changed.filter(i => i < 5000))
  for (const gap of [0, 1, 4, 30]) {
    const expected = reference(a, b, gap)
    for (const chunkSize of [1, 3, 4, 7, 1000, 1 << 20]) {
      const { stats, ranges } = diffBytes(a, b, { gap, chunkSize })
      assert.equal(stats.diffBytes, expected.count, `gap ${gap} chunk ${chunkSize}`)
      assert.deepEqual(ranges, expected.ranges, `gap ${gap} chunk ${chunkSize}`)
    }
  }
})

test('unaligned views fall back to byte comparison', () => {
  const backing = random(1001, 3)
  const a = backing.subarray(1)
  const b = flip(a, [5, 500, 999])
  const differ = createDiffer({ sizeA: a.length, sizeB: b.length, gap: 0 })
  differ.push(a, b, 0)
  assert.equal(differ.finish().diffBytes, 3)
})

test('different sizes compare only the common length', () => {
  const a = random(300)
  const b = flip(a, [5]).slice(0, 200)
  const { stats, ranges } = diffBytes(a, b)
  assert.equal(stats.common, 200)
  assert.equal(stats.diffBytes, 1)
  assert.equal(ranges.length, 1)
  assert.equal(diffBytes(b, a).stats.diffBytes, 1)
})

test('range cap keeps exact counts', () => {
  const a = new Uint8Array(1000)
  const b = flip(a, Array.from({ length: 100 }, (_, i) => i * 10))
  const { stats, ranges } = diffBytes(a, b, { gap: 0, cap: 25 })
  assert.equal(ranges.length, 25)
  assert.equal(stats.rangeCount, 100)
  assert.equal(stats.diffBytes, 100)
  assert.equal(stats.truncated, true)
  assert.equal(stats.lastDiff, 990)
})

test('density buckets cover the larger file', () => {
  const a = new Uint8Array(1024)
  const b = flip(a, [0, 1, 1023]).slice()
  const { stats } = diffBytes(a, new Uint8Array([...b, 1, 2, 3, 4]), { buckets: 4 })
  assert.equal(stats.bucketSize, 257)
  assert.equal(stats.density.length, 4)
  assert.deepEqual(Array.from(stats.density), [2, 0, 0, 1])
  // a run that spans buckets is split between them
  const { stats: spread } = diffBytes(new Uint8Array(8), new Uint8Array(8).fill(1), { buckets: 4 })
  assert.deepEqual(Array.from(spread.density), [2, 2, 2, 2])
})

test('streaming takes ranges in batches', () => {
  const a = new Uint8Array(100)
  const b = flip(a, [1, 50, 99])
  const differ = createDiffer({ sizeA: 100, sizeB: 100, gap: 0 })
  differ.push(a.slice(0, 60), b.slice(0, 60), 0)
  const first = differ.takeRanges()
  assert.deepEqual(Array.from(first.starts), [1])
  assert.equal(differ.stats().rangeCount, 2)
  differ.push(a.slice(60), b.slice(60), 60)
  differ.finish()
  const rest = differ.takeRanges()
  assert.deepEqual(Array.from(rest.starts), [50, 99])
  assert.throws(() => differ.push(a, b, 5))
})
