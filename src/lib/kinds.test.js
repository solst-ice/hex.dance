import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIELD_KIND_ORDER, fieldKind, fieldKindColor, fieldKindLabel, fieldKindMeaning, regionKind, regionKindLabel } from './kinds.js'

test('names and colours field and region kinds, with a fallback for unknown ones', () => {
  assert.equal(fieldKind('magic'), 'magic')
  assert.equal(fieldKind('nonsense'), 'other')
  assert.equal(fieldKindLabel('string'), 'Text')
  assert.equal(fieldKindLabel(undefined), 'Other')
  assert.equal(fieldKindMeaning('nonsense'), null)
  assert.equal(fieldKindColor('size'), 'var(--sx-field-size)')
  assert.equal(fieldKindColor('nonsense'), 'var(--sx-field-other)')
  assert.equal(regionKind('code'), 'code')
  assert.equal(regionKind('nonsense'), 'other')
  assert.equal(regionKindLabel('gap'), 'Unmapped')
  assert.ok(FIELD_KIND_ORDER.includes('checksum'))
})
