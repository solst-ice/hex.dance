import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ASCII, StringScanner, UTF16LE, extractStrings, readString } from './scan.js'

function utf16(text) {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i++) out[i * 2] = text.charCodeAt(i)
  return out
}

function concat(...parts) {
  const items = parts.map(p => (typeof p === 'string' ? new TextEncoder().encode(p) : Uint8Array.from(p)))
  const out = new Uint8Array(items.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of items) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function fixture() {
  return concat(
    [0, 1, 2], 'hello world', [0xff], 'abc', [0], // "abc" is too short
    'tab\there', [0x80, 0x0a],
    utf16('Wide string'), [0xff, 0xff, 0x41],
    utf16('odd one'), [0x90, 0x90],
    'tail'
  )
}

test('finds ASCII and UTF-16LE runs with offsets and lengths', () => {
  const bytes = fixture()
  const found = extractStrings(bytes, { minLength: 5 })
  assert.deepEqual(found.map(s => [s.offset, s.encoding, s.length, s.text]), [
    [3, ASCII, 11, 'hello world'],
    [19, ASCII, 8, 'tab\there'],
    [29, UTF16LE, 11, 'Wide string'],
    [54, UTF16LE, 7, 'odd one']
  ])
  assert.equal(found[3].offset % 2, 0)
})

test('odd alignment UTF-16 runs are found', () => {
  const bytes = concat([7], utf16('aligned?'), [1, 1])
  const found = extractStrings(bytes, { minLength: 4 })
  assert.deepEqual(found.map(s => [s.offset, s.encoding, s.text]), [[1, UTF16LE, 'aligned?']])
})

test('minimum length is honoured and runs at the very end are reported', () => {
  const bytes = concat([0], 'abcd', [0], 'abcde')
  assert.deepEqual(extractStrings(bytes, { minLength: 5 }).map(s => s.text), ['abcde'])
  assert.deepEqual(extractStrings(bytes, { minLength: 4 }).map(s => s.text), ['abcd', 'abcde'])
  assert.deepEqual(extractStrings(new Uint8Array(0)), [])
  assert.deepEqual(extractStrings(Uint8Array.of(0x41, 0x42)), [])
})

test('long runs are truncated in text but keep their full length', () => {
  const long = 'x'.repeat(1000)
  const found = extractStrings(concat([0], long, [0]), { maxText: 100 })
  assert.equal(found.length, 1)
  assert.equal(found[0].length, 1000)
  assert.equal(found[0].text, 'x'.repeat(100))
})

test('chunked input gives the same result as one buffer, for any chunk size', () => {
  let seed = 99
  const random = new Uint8Array(6000)
  for (let i = 0; i < random.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    const r = seed >>> 24
    // Mix of text, zeros and noise so every kind of run crosses chunk edges
    random[i] = r < 120 ? 0x41 + (r % 26) : r < 170 ? 0 : r
  }
  const bytes = concat(fixture(), random, utf16('x'.repeat(400)), 'y'.repeat(700))
  const whole = extractStrings(bytes, { minLength: 4, maxText: 300 })
  for (const size of [1, 2, 3, 7, 64, 511, 4096]) {
    for (const overlap of [0, 1]) {
      const out = []
      const scanner = new StringScanner({ minLength: 4, maxText: 300, onString: (offset, encoding, length, text) => out.push({ offset, encoding, length, text }) })
      for (let from = 0; from < bytes.length; from += size) {
        const offset = Math.max(0, from - overlap)
        scanner.push(bytes.slice(offset, Math.min(bytes.length, from + size)), offset, from)
      }
      scanner.finish()
      assert.deepEqual(out, whole, `chunk size ${size}, overlap ${overlap}`)
    }
  }
  // Reported in offset order
  for (let i = 1; i < whole.length; i++) assert.ok(whole[i].offset > whole[i - 1].offset)
})

test('readString decodes the full string', () => {
  const bytes = fixture()
  assert.equal(readString(bytes, 29, UTF16LE, 11), 'Wide string')
  assert.equal(readString(bytes, 3, ASCII, 11), 'hello world')
  assert.equal(readString(bytes, bytes.length - 2, ASCII, 10), 'il')
})
