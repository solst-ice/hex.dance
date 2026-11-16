import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseBytesPerRow, rowChars, FIXED_PX, rowCount, maxTopRow, clampRow, rowOf,
  ensureVisible, comfortableTop, wheelPixels, thumbMetrics, rowAtThumbPos, MIN_THUMB_PX
} from './layout.js'

const CH = 7

test('bytes per row is the widest choice that fits', () => {
  const need = n => rowChars(n) * CH + FIXED_PX
  assert.equal(chooseBytesPerRow(need(32), CH), 32)
  assert.equal(chooseBytesPerRow(need(32) - 1, CH), 24)
  assert.equal(chooseBytesPerRow(need(24) - 1, CH), 16)
  assert.equal(chooseBytesPerRow(need(16) - 1, CH), 8)
  assert.equal(chooseBytesPerRow(100, CH), 8)
})

test('a 390px phone fits 8 bytes per row without wrapping', () => {
  // 390px viewport minus page and panel padding
  assert.ok(rowChars(8) * CH + FIXED_PX <= 390 - 2 * 20 - 2 * 10)
  assert.equal(chooseBytesPerRow(330, CH), 8)
})

test('bytes per row falls back to 16 before anything is measured', () => {
  assert.equal(chooseBytesPerRow(0, CH), 16)
  assert.equal(chooseBytesPerRow(800, 0), 16)
})

test('row maths stays exact for files up to 2 GB', () => {
  const size = 2 ** 31
  assert.equal(rowCount(size, 16), 2 ** 27)
  assert.equal(rowCount(size - 1, 16), 2 ** 27)
  assert.equal(rowCount(size + 1, 32), 2 ** 26 + 1)
  assert.equal(rowOf(size - 1, 16), 2 ** 27 - 1)
  assert.equal(rowOf(size - 1, 24), Math.floor((size - 1) / 24))
  assert.equal(maxTopRow(2 ** 27, 30), 2 ** 27 - 30)
})

test('empty and tiny files have no scroll range', () => {
  assert.equal(rowCount(0, 16), 0)
  assert.equal(rowCount(1, 16), 1)
  assert.equal(rowCount(17, 16), 2)
  assert.equal(maxTopRow(0, 20), 0)
  assert.equal(maxTopRow(2, 20), 0)
  assert.equal(maxTopRow(25, 20), 5)
  assert.equal(maxTopRow(25, 0), 24)
})

test('clampRow keeps rows inside the scroll range', () => {
  assert.equal(clampRow(-5, 10), 0)
  assert.equal(clampRow(50, 10), 10)
  assert.equal(clampRow(3.7, 10), 3)
  assert.equal(clampRow(NaN, 10), 0)
})

test('ensureVisible scrolls by the smallest amount', () => {
  assert.equal(ensureVisible(5, 0, 10), 0)
  assert.equal(ensureVisible(10, 0, 10), 1)
  assert.equal(ensureVisible(3, 5, 10), 3)
  assert.equal(ensureVisible(14, 5, 10), 5)
})

test('comfortableTop keeps a row that is well inside, otherwise puts it a third down', () => {
  assert.equal(comfortableTop(105, 100, 30), 100)
  assert.equal(comfortableTop(100, 100, 30), 90)
  assert.equal(comfortableTop(5000, 0, 30), 4990)
  assert.equal(comfortableTop(0, 0, 1), 0)
})

test('wheelPixels converts line and page deltas', () => {
  assert.equal(wheelPixels(100, 0, 20, 30), 100)
  assert.equal(wheelPixels(3, 1, 20, 30), 60)
  assert.equal(wheelPixels(-1, 2, 20, 30), -600)
})

test('the scrollbar thumb round-trips to the same row at any size', () => {
  const track = 400
  for (const total of [10, 1000, 6_553_600, 2 ** 27]) {
    const visible = 20
    const maxTop = maxTopRow(total, visible)
    const { size, pos } = thumbMetrics(track, visible, total, maxTop, maxTop)
    assert.ok(size >= Math.min(track, MIN_THUMB_PX))
    assert.equal(rowAtThumbPos(pos, track, size, maxTop), maxTop)
    assert.equal(rowAtThumbPos(0, track, size, maxTop), 0)
    assert.equal(rowAtThumbPos(-50, track, size, maxTop), 0)
    assert.equal(rowAtThumbPos(track * 2, track, size, maxTop), maxTop)
  }
})

test('the thumb fills the track when everything fits', () => {
  assert.deepEqual(thumbMetrics(300, 20, 5, 0, 0), { size: 300, pos: 0 })
  assert.deepEqual(thumbMetrics(0, 20, 5, 0, 0), { size: 0, pos: 0 })
})
