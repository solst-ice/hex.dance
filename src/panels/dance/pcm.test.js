import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkLength, createTimeline, playRange, rms, smoothLevel, toSamples } from './pcm.js'

test('toSamples maps unsigned bytes around 0x80', () => {
  const out = toSamples(Uint8Array.of(0, 0x80, 0xff, 0x40), 0, 3)
  assert.deepEqual(Array.from(out), [-1, 0, 127 / 128])
  assert.equal(toSamples(Uint8Array.of(1), 0, 0).length, 0)
})

test('playRange plays a selection, else from the cursor to the end', () => {
  assert.deepEqual(playRange({ start: 10, end: 20 }, 0, 100), { start: 10, end: 20, scope: 'selection' })
  assert.deepEqual(playRange({ start: 10, end: 11 }, 50, 100), { start: 10, end: 100, scope: 'cursor' })
  assert.deepEqual(playRange(null, 50, 100), { start: 50, end: 100, scope: 'cursor' })
  assert.deepEqual(playRange(null, NaN, 100), { start: 0, end: 100, scope: 'cursor' })
  assert.deepEqual(playRange(null, 500, 100), { start: 99, end: 100, scope: 'cursor' })
  assert.equal(playRange(null, 0, 0), null)
})

test('chunkLength is half a second of bytes', () => {
  assert.equal(chunkLength(8000), 4000)
  assert.equal(chunkLength(44100), 22050)
})

test('timeline maps audio time to file offsets', () => {
  const timeline = createTimeline()
  timeline.add(1, 100, 8000, 8000)
  timeline.add(2, 8100, 4000, 8000)
  assert.equal(timeline.offsetAt(0.5), null)
  assert.equal(timeline.offsetAt(1), 100)
  assert.equal(timeline.offsetAt(1.5), 4100)
  assert.equal(timeline.offsetAt(2.25), 8100 + 2000)
  assert.equal(timeline.offsetAt(3), null)
  assert.equal(timeline.endTime, 2.5)
  timeline.prune(2.1)
  assert.equal(timeline.size, 1)
  assert.equal(timeline.offsetAt(2.1), 8100 + 800)
})

test('rms and smoothing', () => {
  assert.equal(rms(Float32Array.of(1, -1, 1, -1)), 1)
  assert.equal(rms(new Float32Array(0)), 0)
  const up = smoothLevel(0, 1, 0.03)
  const down = smoothLevel(1, 0, 0.03)
  assert.ok(up > 0.6 && up < 0.7)
  assert.ok(down > 0.85, 'release is slower than attack')
})
