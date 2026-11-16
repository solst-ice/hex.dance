import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findShift, shouldLookForShift, verifyShift } from './shift.js'
import { diffBytes } from './diff.js'

function random(length, seed = 1) {
  const bytes = new Uint8Array(length)
  let x = seed
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    bytes[i] = x >>> 24
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

function detect(a, b) {
  const { stats } = diffBytes(a, b)
  if (!shouldLookForShift(stats)) return null
  const at = stats.firstDiff
  const shift = findShift(a.subarray(at), b.subarray(at))
  if (!shift) return { shift, at }
  return { shift, at, ...verifyShift(a, b, at, shift) }
}

test('finds bytes inserted in B', () => {
  const a = random(200000)
  const b = concat(a.subarray(0, 100000), random(16, 9), a.subarray(100000))
  const found = detect(a, b)
  assert.equal(found.shift, 16)
  assert.equal(found.at, 100000)
  assert.equal(found.ratio, 1)
})

test('finds bytes removed from B', () => {
  const a = random(200000)
  const b = concat(a.subarray(0, 5000), a.subarray(5300))
  const found = detect(a, b)
  assert.equal(found.shift, -300)
  assert.equal(found.at, 5000)
  assert.equal(found.ratio, 1)
})

test('an insertion that starts like the original still lines up', () => {
  const a = random(50000, 4)
  const insert = random(40, 5)
  insert[0] = a[1000]
  insert[1] = a[1001]
  const b = concat(a.subarray(0, 1000), insert, a.subarray(1000))
  const found = detect(a, b)
  assert.equal(found.at, 1002)
  assert.equal(found.shift, 40)
  assert.equal(found.ratio, 1)
})

test('skips a run of one byte when choosing what to look for', () => {
  const a = concat(random(1000, 2), new Uint8Array(500), random(5000, 3))
  const b = concat(a.subarray(0, 1000), new Uint8Array([1, 2, 3, 4, 5, 6, 7]), a.subarray(1000))
  const found = detect(a, b)
  assert.equal(found.shift, 7)
})

test('scattered changes do not trigger a search', () => {
  const a = random(100000)
  const b = a.slice()
  for (let i = 0; i < 100000; i += 1000) b[i] ^= 1
  assert.equal(detect(a, b), null)
})

test('unrelated files find no shift', () => {
  const found = detect(random(100000, 1), random(100000, 2))
  assert.equal(found.shift, null)
})

test('shifts beyond the window are not found', () => {
  const a = random(10000, 1)
  const b = concat(a.subarray(0, 100), random(3000, 8), a.subarray(100))
  assert.equal(findShift(a.subarray(100), b.subarray(100), { maxShift: 1000 }), null)
  assert.equal(findShift(a.subarray(100), b.subarray(100), { maxShift: 5000 }), 3000)
})

test('short tails are left alone', () => {
  const a = random(100)
  const b = concat(a.subarray(0, 90), random(5, 6), a.subarray(90))
  assert.equal(detect(a, b), null)
  assert.equal(findShift(new Uint8Array(0), new Uint8Array(0)), null)
})

test('verification reports partial matches', () => {
  const a = random(100000)
  const b = concat(a.subarray(0, 1000), random(10, 2), a.subarray(1000))
  b.set(random(50000, 11), 50000)
  const { ratio } = verifyShift(a, b, 1000, 10)
  assert.ok(ratio > 0.4 && ratio < 0.6, String(ratio))
})
