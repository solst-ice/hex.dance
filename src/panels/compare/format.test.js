import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportText, hexPreview, percent, shiftText, verdict } from './format.js'
import { diffBytes } from './diff.js'

const toRanges = (ranges) => ({
  starts: ranges.map(r => r.start),
  ends: ranges.map(r => r.end),
  length: ranges.length
})

test('verdicts', () => {
  const v = (a, b) => verdict(diffBytes(new Uint8Array(a), new Uint8Array(b), { gap: 0 }).stats)
  assert.equal(v([], []).kind, 'identical')
  assert.match(v([], []).detail, /empty/)
  assert.equal(v([1, 2], [1, 2]).kind, 'identical')
  assert.equal(v([1, 2, 3], [1, 0, 0]).kind, 'same-size')
  assert.equal(v([1, 2, 3], [1, 0, 0]).detail, '2 differing bytes in 1 range.')
  assert.equal(v([1, 2], [1, 2, 3]).kind, 'prefix')
  assert.equal(v([1, 2], [1, 2, 3]).detail, 'A is a prefix of B: B has 1 more byte at the end.')
  assert.equal(v([], [1]).detail, 'A is empty; B has 1 byte.')
  assert.equal(v([1, 9, 3], [1, 2]).kind, 'different-size')
  assert.match(v([1, 9, 3], [1, 2]).detail, /A is 1 byte longer/)
})

test('percentages never round to the ends', () => {
  assert.equal(percent(0, 0), '100%')
  assert.equal(percent(10, 10), '100%')
  assert.equal(percent(0, 10), '0%')
  assert.equal(percent(999999, 1000000), '>99.99%')
  assert.equal(percent(1, 1000000), '<0.01%')
  assert.equal(percent(1, 2), '50.0%')
  assert.equal(percent(1, 30), '3.33%')
})

test('hex previews', () => {
  const bytes = new Uint8Array([0, 1, 0xab, 0xff])
  assert.equal(hexPreview(bytes, 0, 4), '00 01 ab ff')
  assert.equal(hexPreview(bytes, 1, 4, 2), '01 ab …')
  assert.equal(hexPreview(bytes, 2, 10), 'ab ff …')
  assert.equal(hexPreview(bytes, 4, 5), '…')
})

test('shift text', () => {
  assert.equal(shiftText(16, 0x100), 'B has 16 bytes inserted at 0x00000100')
  assert.equal(shiftText(-2, 0x10), 'B has 2 bytes removed at 0x00000010 (A has them at 0x00000010–0x00000011)')
})

test('export lists ranges and the size difference', () => {
  const a = new Uint8Array([1, 2, 3, 4, 5, 6])
  const b = new Uint8Array([1, 9, 3, 4, 5])
  const { stats, ranges } = diffBytes(a, b, { gap: 0 })
  const text = exportText({ a: { name: 'a.bin', bytes: a }, b: { name: 'b.bin', bytes: b }, stats, ranges: toRanges(ranges) })
  assert.match(text, /# A: a\.bin \(6 bytes\)/)
  assert.match(text, /^0x00000001 +1 +02 +09$/m)
  assert.match(text, /# Only in A: 0x00000005–0x00000005 \(1 byte\)/)
})

test('export is capped', () => {
  const a = new Uint8Array(100)
  const b = a.map((_, i) => (i % 2 ? 1 : 0))
  const { stats, ranges } = diffBytes(a, b, { gap: 0 })
  const text = exportText({ a: { name: 'a', bytes: a }, b: { name: 'b', bytes: b }, stats, ranges: toRanges(ranges), cap: 10 })
  assert.match(text, /Showing the first 10 of 50 ranges/)
  assert.equal(text.split('\n').filter(line => line.startsWith('0x')).length, 10)
})
