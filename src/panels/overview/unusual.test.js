import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UNUSUAL_SHOWN, unusualNotes } from './unusual.js'

test('no notes when the analysis has none', () => {
  assert.deepEqual(unusualNotes(null), [])
  assert.deepEqual(unusualNotes({}), [])
  assert.deepEqual(unusualNotes({ unusual: 'not a list' }), [])
})

test('keeps text notes, with an offset only when it is usable', () => {
  const notes = unusualNotes({
    unusual: [
      { text: 'The entry point is in the last section, not the first.', offset: 0xd000, length: 16 },
      { text: 'No offset here.' },
      { text: '   ' },
      null,
      { text: 42 },
      { text: 'Bad offset.', offset: -4, length: 2 },
      { text: 'Bad length.', offset: 8, length: 0 }
    ]
  })
  assert.deepEqual(notes, [
    { text: 'The entry point is in the last section, not the first.', offset: 0xd000, length: 16 },
    { text: 'No offset here.', offset: null, length: 1 },
    { text: 'Bad offset.', offset: null, length: 2 },
    { text: 'Bad length.', offset: 8, length: 1 }
  ])
})

test('lists a bounded number', () => {
  const unusual = Array.from({ length: 10000 }, (_, i) => ({ text: `Note ${i}` }))
  assert.equal(unusualNotes({ unusual }).length, UNUSUAL_SHOWN)
})
