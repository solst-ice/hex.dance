import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rangeBetween, normalizeSelection, sameSelection, clipToRow, anchorFor, moveCursor
} from './selection.js'

test('rangeBetween covers both ends in either direction', () => {
  assert.deepEqual(rangeBetween(5, 9), { start: 5, end: 10 })
  assert.deepEqual(rangeBetween(9, 5), { start: 5, end: 10 })
  assert.deepEqual(rangeBetween(3, 3), { start: 3, end: 4 })
})

test('normalizeSelection clamps to the file and drops empty ranges', () => {
  assert.equal(normalizeSelection(null, 10), null)
  assert.deepEqual(normalizeSelection({ start: -3, end: 4 }, 10), { start: 0, end: 4 })
  assert.deepEqual(normalizeSelection({ start: 8, end: 40 }, 10), { start: 8, end: 10 })
  assert.equal(normalizeSelection({ start: 4, end: 4 }, 10), null)
  assert.equal(normalizeSelection({ start: 20, end: 30 }, 10), null)
  assert.equal(normalizeSelection({ start: 'x', end: 3 }, 10), null)
  assert.equal(normalizeSelection({ start: 0, end: 3 }, 0), null)
})

test('sameSelection compares by value', () => {
  assert.ok(sameSelection(null, null))
  assert.ok(sameSelection({ start: 1, end: 2 }, { start: 1, end: 2 }))
  assert.ok(!sameSelection({ start: 1, end: 2 }, null))
  assert.ok(!sameSelection({ start: 1, end: 2 }, { start: 1, end: 3 }))
})

test('clipToRow returns the selected columns of a row', () => {
  const sel = { start: 20, end: 40 }
  assert.equal(clipToRow(sel, 0, 16), null)
  assert.deepEqual(clipToRow(sel, 16, 16), [4, 16])
  assert.deepEqual(clipToRow(sel, 32, 16), [0, 8])
  assert.equal(clipToRow(sel, 48, 16), null)
  assert.equal(clipToRow(null, 0, 16), null)
})

test('anchorFor keeps the far end of the selection', () => {
  assert.equal(anchorFor(null, 7, null), 7)
  assert.equal(anchorFor(null, 7, 3), 3)
  assert.equal(anchorFor({ start: 3, end: 8 }, 7, 3), 3)
  assert.equal(anchorFor({ start: 10, end: 20 }, 10, null), 19)
  assert.equal(anchorFor({ start: 10, end: 20 }, 19, null), 10)
  assert.equal(anchorFor({ start: 10, end: 20 }, 50, 2), 10)
})

const ctx = { bytesPerRow: 16, size: 100, pageRows: 4 }

test('moveCursor handles every navigation key', () => {
  assert.equal(moveCursor(20, 'left', ctx), 19)
  assert.equal(moveCursor(20, 'right', ctx), 21)
  assert.equal(moveCursor(20, 'up', ctx), 4)
  assert.equal(moveCursor(20, 'down', ctx), 36)
  assert.equal(moveCursor(20, 'pageDown', ctx), 84)
  assert.equal(moveCursor(84, 'pageUp', ctx), 20)
  assert.equal(moveCursor(20, 'rowStart', ctx), 16)
  assert.equal(moveCursor(20, 'rowEnd', ctx), 31)
  assert.equal(moveCursor(20, 'fileStart', ctx), 0)
  assert.equal(moveCursor(20, 'fileEnd', ctx), 99)
})

test('moveCursor stays inside the file at both ends', () => {
  assert.equal(moveCursor(0, 'left', ctx), 0)
  assert.equal(moveCursor(5, 'up', ctx), 5)
  assert.equal(moveCursor(5, 'pageUp', ctx), 5)
  assert.equal(moveCursor(99, 'right', ctx), 99)
  assert.equal(moveCursor(90, 'down', ctx), 99)
  assert.equal(moveCursor(90, 'pageDown', ctx), 99)
  assert.equal(moveCursor(97, 'rowEnd', ctx), 99)
})

test('moveCursor survives tiny and empty files and stale cursors', () => {
  const tiny = { bytesPerRow: 16, size: 2, pageRows: 20 }
  assert.equal(moveCursor(0, 'down', tiny), 1)
  assert.equal(moveCursor(0, 'pageDown', tiny), 1)
  assert.equal(moveCursor(1, 'up', tiny), 1)
  assert.equal(moveCursor(0, 'up', { bytesPerRow: 16, size: 0, pageRows: 1 }), 0)
  assert.equal(moveCursor(5000, 'up', tiny), 1)
})
