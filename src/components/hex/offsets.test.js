import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOffset } from './offsets.js'

const SIZE = 0x10000

const at = (input, current = 0, size = SIZE) => parseOffset(input, { current, size })

test('accepts 0x-prefixed, h-suffixed and decimal offsets', () => {
  assert.deepEqual(at('0x1f40'), { ok: true, offset: 0x1f40 })
  assert.deepEqual(at('0X1F40'), { ok: true, offset: 0x1f40 })
  assert.deepEqual(at('1F40h'), { ok: true, offset: 0x1f40 })
  assert.deepEqual(at('1f40H'), { ok: true, offset: 0x1f40 })
  assert.deepEqual(at('8000'), { ok: true, offset: 8000 })
  assert.deepEqual(at('  0 '), { ok: true, offset: 0 })
})

test('treats bare digits as decimal and bare hex with letters as hex', () => {
  assert.equal(at('10').offset, 10)
  assert.equal(at('ff').offset, 0xff)
  assert.equal(at('dead').offset, 0xdead)
})

test('relative offsets move from the current position', () => {
  assert.equal(at('+16', 100).offset, 116)
  assert.equal(at('-0x10', 100).offset, 84)
  assert.equal(at('+10h', 0).offset, 16)
  assert.equal(at('- 4', 4).offset, 0)
})

test('rejects garbage, empty input and out-of-range offsets', () => {
  assert.equal(at('').ok, false)
  assert.equal(at('0x').ok, false)
  assert.equal(at('12g').ok, false)
  assert.equal(at('0x10000').ok, false)
  assert.equal(at('0xffff').offset, 0xffff)
  assert.equal(at('-1', 0).ok, false)
  assert.equal(at('+1', SIZE - 1).ok, false)
  assert.equal(at('0', 0, 0).ok, false)
  assert.equal(at('0x' + 'f'.repeat(20)).ok, false)
})

test('handles offsets in 2 GB files exactly', () => {
  const size = 2 ** 31
  assert.equal(at('0x7fffffff', 0, size).offset, 2 ** 31 - 1)
  assert.equal(at('2147483647', 0, size).offset, 2 ** 31 - 1)
  assert.equal(at('0x80000000', 0, size).ok, false)
})
