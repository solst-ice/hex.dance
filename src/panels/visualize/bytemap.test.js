import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectStride, offsetAt, overviewStrip, paintByteMap, pixelsPerRow } from './bytemap.js'

const classColors = [[0, 0, 0], [10, 10, 10], [20, 20, 20], [30, 30, 30], [40, 40, 40]]

test('pixelsPerRow and offsetAt agree for each mode', () => {
  assert.equal(pixelsPerRow(64, 'class'), 64)
  assert.equal(pixelsPerRow(64, 'rgb'), 21)
  assert.equal(pixelsPerRow(2, 'rgb'), 1)
  assert.equal(offsetAt(100, 64, 'grey', 3, 2, 1000), 231)
  assert.equal(offsetAt(100, 64, 'rgb', 3, 2, 1000), 237)
  assert.equal(offsetAt(100, 64, 'grey', 3, 20, 1000), -1)
})

test('paintByteMap draws each mode and leaves bytes past the end transparent', () => {
  const bytes = Uint8Array.of(0, 0x41, 0x0a, 0xff, 0x90)
  const grey = paintByteMap(new Uint8ClampedArray(2 * 3 * 4), bytes, { top: 0, stride: 2, mode: 'grey', width: 2, rows: 3, classColors })
  assert.deepEqual(Array.from(grey.slice(0, 8)), [0, 0, 0, 255, 0x41, 0x41, 0x41, 255])
  assert.deepEqual(Array.from(grey.slice(20, 24)), [0, 0, 0, 0])

  const cls = paintByteMap(new Uint8ClampedArray(5 * 4), bytes, { top: 0, stride: 5, mode: 'class', width: 5, rows: 1, classColors })
  assert.deepEqual([0, 1, 2, 3, 4].map(i => cls[i * 4]), [0, 10, 20, 30, 40])

  const rgb = paintByteMap(new Uint8ClampedArray(2 * 4), bytes, { top: 0, stride: 6, mode: 'rgb', width: 2, rows: 1, classColors })
  assert.deepEqual(Array.from(rgb), [0, 0x41, 0x0a, 255, 0xff, 0x90, 0, 255])
})

test('detectStride finds the row length of a raw bitmap', () => {
  const width = 300
  const bytes = new Uint8Array(width * 60)
  for (let y = 0; y < 60; y++) {
    for (let x = 0; x < width; x++) bytes[y * width + x] = (x * 37) % 251 ^ (x >> 3)
  }
  assert.deepEqual(detectStride(bytes, 0)?.stride, width)
})

test('detectStride gives up on noise and on tiny input', () => {
  let seed = 1
  const noise = Uint8Array.from({ length: 20000 }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24)
  assert.equal(detectStride(noise, 0), null)
  assert.equal(detectStride(Uint8Array.of(1, 2), 0), null)
})

test('overviewStrip gives one colour per line', () => {
  const bytes = new Uint8Array(100)
  bytes.fill(0x41, 50)
  const strip = overviewStrip(bytes, 2, classColors)
  assert.deepEqual(Array.from(strip), [0, 0, 0, 255, 10, 10, 10, 255])
  assert.equal(overviewStrip(new Uint8Array(0), 3, classColors).length, 12)
})
