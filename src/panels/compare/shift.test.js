import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOOK_AHEAD, LOOK_BACK, confirmShift, findShifts, shouldLookForShift, verifyShift } from './shift.js'
import { diffBytes } from './diff.js'

// Hash of (seed, index), so different seeds give unrelated bytes (an LCG's
// streams for nearby seeds overlap)
function random(length, seed = 1) {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35)
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
    bytes[i] = (x ^ (x >>> 16)) >>> 24
  }
  return bytes
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const ascii = (text) => new TextEncoder().encode(text)

// Mostly zeros with short stretches of content, like an executable's padding
function zeroHeavy(length, seed = 1) {
  const bytes = new Uint8Array(length)
  const content = random(length, seed)
  for (let at = 0; at < length; at += 4096) bytes.set(content.subarray(at, Math.min(length, at + 300)), at)
  return bytes
}

// Same steps as the panel: equal-offset pass, windows, candidates, confirmation
function detect(a, b) {
  const { stats } = diffBytes(a, b)
  if (!shouldLookForShift(stats)) return null
  const d = stats.firstDiff
  const base = Math.max(0, d - LOOK_BACK)
  const end = d + LOOK_AHEAD
  const candidates = findShifts(a.subarray(base, end), b.subarray(base, end), d - base, { endA: end >= a.length, endB: end >= b.length })
  return confirmShift(a, b, d, candidates, base)
}

test('when to look for a shift', () => {
  const stats = (patch) => ({ sizeA: 100, sizeB: 100, common: 100, diffBytes: 1, firstDiff: 10, lastDiff: 10, ...patch })
  assert.equal(shouldLookForShift(stats({ diffBytes: 0, firstDiff: -1 })), false)
  assert.equal(shouldLookForShift(stats({ sizeB: 101 })), true)
  assert.equal(shouldLookForShift(stats({ lastDiff: 40 })), false)
  assert.equal(shouldLookForShift(stats({ lastDiff: 73 })), true)
})

test('finds bytes inserted in B', () => {
  const a = random(200000)
  const b = concat(a.subarray(0, 100000), random(16, 9), a.subarray(100000))
  const found = detect(a, b)
  assert.equal(found.shift, 16)
  assert.equal(found.from, 100000)
  assert.equal(found.exact, true)
  assert.equal(found.ratio, 1)
})

test('finds bytes removed from B', () => {
  const a = random(200000)
  const b = concat(a.subarray(0, 5000), a.subarray(5300))
  const found = detect(a, b)
  assert.equal(found.shift, -300)
  assert.equal(found.from, 5000)
  assert.equal(found.exact, true)
})

test('insertion of text inside a long zero run', () => {
  const a = concat(random(3000, 2), new Uint8Array(20000), random(30000, 3), new Uint8Array(5000), random(2000, 4))
  const b = concat(a.subarray(0, 8000), ascii('INSERTED-16BYTES'), a.subarray(8000))
  const found = detect(a, b)
  assert.equal(found.shift, 16)
  assert.equal(found.from, 8000)
  assert.equal(found.exact, true)
})

test('insertion inside a zero run when the files keep the same size', () => {
  const a = concat(random(3000, 2), new Uint8Array(20000), random(30000, 3))
  const b = concat(a.subarray(0, 8000), ascii('INSERTED-16BYTES'), a.subarray(8000, a.length - 16))
  const found = detect(a, b)
  assert.equal(found.shift, 16)
  assert.equal(found.from, 8000)
  assert.equal(found.exact, true)
})

test('zeros inserted into a zero run: the point is given as a range', () => {
  const a = concat(random(3000, 2), new Uint8Array(20000), random(30000, 3))
  const b = concat(a.subarray(0, 8000), new Uint8Array(64), a.subarray(8000))
  const found = detect(a, b)
  assert.equal(found.shift, 64)
  assert.equal(found.exact, false)
  assert.equal(found.from, 3000)
  assert.equal(found.to, 23000)
})

test('removal inside a long zero run', () => {
  const a = concat(random(3000, 2), new Uint8Array(20000), random(30000, 3))
  const b = concat(a.subarray(0, 3100), a.subarray(3200))
  const found = detect(a, b)
  assert.equal(found.shift, -100)
  assert.equal(found.exact, false)
  assert.equal(found.from, 3000)
  assert.equal(found.to, 23000 - 100)
  // removing bytes that are not all zero pins the point down
  const c = concat(a.subarray(0, 22990), a.subarray(23010))
  const exact = detect(a, c)
  assert.equal(exact.shift, -20)
  assert.equal(exact.from, 22990)
  assert.equal(exact.exact, true)
})

test('insertion at the very start and near the very end', () => {
  const a = random(50000, 5)
  const start = detect(a, concat(random(10, 6), a))
  assert.equal(start.shift, 10)
  assert.equal(start.from, 0)
  assert.equal(start.exact, true)
  const end = detect(a, concat(a.subarray(0, 49960), random(7, 7), a.subarray(49960)))
  assert.equal(end.shift, 7)
  assert.equal(end.from, 49960)
  // fewer bytes after the insertion than a probe holds: the size difference still finds it
  const last = detect(a, concat(a.subarray(0, 49995), random(5, 8), a.subarray(49995)))
  assert.equal(last.shift, 5)
  assert.equal(last.from, 49995)
})

test('equal sizes: a block inserted and as many bytes dropped from the end', () => {
  const a = random(300000, 9)
  const b = concat(a.subarray(0, 120000), random(500, 10), a.subarray(120000, a.length - 500))
  const found = detect(a, b)
  assert.equal(found.shift, 500)
  assert.equal(found.from, 120000)
  assert.equal(found.ratio, 1)
})

test('an insertion that starts like the original still lines up', () => {
  const a = random(50000, 4)
  const insert = random(40, 5)
  insert[0] = a[1000]
  insert[1] = a[1001]
  const b = concat(a.subarray(0, 1000), insert, a.subarray(1000))
  const found = detect(a, b)
  assert.equal(found.shift, 40)
  assert.ok(found.from <= 1000 && found.to >= 1000 && found.to <= 1002, JSON.stringify(found))
})

test('zero-heavy files with scattered changes report no shift', () => {
  const a = zeroHeavy(400000, 3)
  const b = a.slice()
  for (let i = 100; i < a.length; i += 7919) b[i] ^= 0x41
  assert.equal(detect(a, b), null)
  const c = a.slice()
  for (let i = 50; i < a.length; i += 4096) c[i] ^= 1
  assert.equal(detect(a, c.subarray(0, a.length - 1000)), null)
})

test('unrelated files and all-zero tails report no shift', () => {
  assert.equal(detect(random(100000, 1), random(100000, 2)), null)
  assert.equal(detect(random(100000, 1), random(100500, 2)), null)
  // a tail of zeros lines up at any shift and proves nothing
  const a = concat(random(1000, 3), new Uint8Array(5000))
  const b = concat(random(1000, 4), new Uint8Array(5040))
  assert.equal(detect(a, b), null)
})

test('shifts beyond the window are not found', () => {
  const a = random(10000, 1)
  const b = concat(a.subarray(0, 100), random(3000, 8), a.subarray(100))
  assert.deepEqual(findShifts(a, b, 100, { maxShift: 1000 }), [])
  assert.equal(findShifts(a, b, 100, { maxShift: 5000 })[0].shift, 3000)
  assert.deepEqual(findShifts(new Uint8Array(0), new Uint8Array(0), 0), [])
})

test('verification ignores zero blocks and reports partial matches', () => {
  const a = random(100000)
  const b = concat(a.subarray(0, 1000), random(10, 2), a.subarray(1000))
  b.set(random(50000, 11), 50000)
  const partial = verifyShift(a, b, 1000, 10)
  assert.ok(partial.ratio > 0.4 && partial.ratio < 0.6, String(partial.ratio))
  assert.equal(partial.confirmed, false)
  const zeros = verifyShift(new Uint8Array(200000), new Uint8Array(200016), 0, 16)
  assert.equal(zeros.checked, 0)
  assert.equal(zeros.confirmed, false)
})
