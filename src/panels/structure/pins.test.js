import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pinKey, pinMessage } from './treeModel.js'

test('pins are keyed by offset and length', () => {
  assert.equal(pinKey(0x3c, 4), '60:4')
  assert.notEqual(pinKey(1, 23), pinKey(12, 3))
})

test('what is announced after pinning', () => {
  assert.equal(pinMessage('pinned', 'e_lfanew', 24), 'e_lfanew is pinned to the poster.')
  assert.equal(pinMessage('unpinned', 'e_lfanew', 24), 'e_lfanew is no longer pinned.')
  assert.equal(pinMessage('full', 'x', 24), '24 fields are pinned already, the most a poster takes. Unpin one first.')
  assert.equal(pinMessage('pinned', '', 24), 'This field is pinned to the poster.')
  assert.equal(pinMessage('invalid', 'x', 24), 'This field cannot be pinned.')
})
