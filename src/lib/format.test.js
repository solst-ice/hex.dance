import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatLength, formatOffset } from './format.js'

test('formats offsets and lengths', () => {
  assert.equal(formatOffset(0), '0x0')
  assert.equal(formatOffset(0x1f40), '0x1F40')
  assert.equal(formatLength(1), '1 byte')
  assert.equal(formatLength(0), '0 bytes')
  assert.equal(formatLength(8000), '8,000 bytes')
})
