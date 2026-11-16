import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAGIC_CONSTANTS, createMagicScanner, expectedByChance, magicPatterns } from './magic.js'

const find = (results, hex, order) => results.find(r => r.hex === hex && r.order === order)

test('every constant is valid hex and symmetric ones are looked for once', () => {
  for (const { hex } of MAGIC_CONSTANTS) assert.match(hex, /^([0-9A-F]{2}){3,4}$/)
  const patterns = magicPatterns()
  assert.equal(patterns.filter(p => p.constant.hex === 'CDCDCDCD').length, 1)
  assert.equal(patterns.filter(p => p.constant.hex === 'DEADBEEF').length, 2)
})

test('finds constants in both byte orders', () => {
  const scanner = createMagicScanner()
  const bytes = Uint8Array.of(0, 0xca, 0xfe, 0xba, 0xbe, 1, 0xcf, 0xfa, 0xed, 0xfe, 2)
  scanner.scan(bytes, 0, false)
  const results = scanner.results()
  assert.deepEqual(find(results, 'CAFEBABE', 'BE').offsets, [1])
  assert.deepEqual(find(results, 'FEEDFACF', 'LE').offsets, [6])
  assert.equal(find(results, 'CAFEBABE', 'LE'), undefined)
})

test('finds a match split across contiguous chunks exactly once', () => {
  const scanner = createMagicScanner()
  scanner.scan(Uint8Array.of(9, 9, 0xde, 0xad), 0, false)
  scanner.scan(Uint8Array.of(0xbe, 0xef, 0xde, 0xad, 0xbe), 4, true)
  scanner.scan(Uint8Array.of(0xef), 9, true)
  const hit = find(scanner.results(), 'DEADBEEF', 'BE')
  assert.equal(hit.count, 2)
  assert.deepEqual(hit.offsets, [2, 6])
})

test('a 3-byte constant inside the carried tail is not counted twice', () => {
  const scanner = createMagicScanner()
  scanner.scan(Uint8Array.of(1, 0xc0, 0xff, 0xee), 0, false)
  scanner.scan(Uint8Array.of(5, 6, 7), 4, true)
  assert.equal(find(scanner.results(), 'C0FFEE', 'BE').count, 1)
})

test('does not join chunks that are not contiguous', () => {
  const scanner = createMagicScanner()
  scanner.scan(Uint8Array.of(0xde, 0xad), 0, false)
  scanner.scan(Uint8Array.of(0xbe, 0xef), 100, false)
  assert.equal(find(scanner.results(), 'DEADBEEF', 'BE'), undefined)
})

test('runs of a repeated byte count once per four bytes and offsets are capped', () => {
  const scanner = createMagicScanner(undefined, { maxOffsets: 2 })
  scanner.scan(new Uint8Array(16).fill(0xcd), 0, false)
  const hit = find(scanner.results(), 'CDCDCDCD', 'BE')
  assert.equal(hit.count, 4)
  assert.deepEqual(hit.offsets, [0, 4])
})

test('expectedByChance', () => {
  assert.equal(expectedByChance(3, 4), 0)
  assert.equal(expectedByChance(2 ** 32 + 3, 4), 1)
})
