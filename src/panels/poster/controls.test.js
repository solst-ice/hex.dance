import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SHOW, TALL_MAX_ROWS, describePlan, hasPointerField, includeChoices, posterOptions, shownPlaces } from './controls.js'
import { buildPoster } from './render.js'
import { planPoster } from './plan.js'

const OPTIONS = { bytesPerRow: 16, depth: 3, maxLabels: 36, style: 'dark', proportion: 'landscape' }

test('the options handed to buildPoster, per mode', () => {
  const pins = [{ offset: 0x3c, length: 4, name: 'e_lfanew' }]
  const tour = posterOptions({ options: OPTIONS, mode: 'tour', range: null, fieldIndex: 0, pins, show: DEFAULT_SHOW })
  assert.deepEqual(tour, {
    mode: 'tour',
    range: null,
    fieldIndex: 0,
    bytesPerRow: 16,
    depth: 3,
    maxLabels: 36,
    style: 'dark',
    proportion: 'landscape',
    pins: [{ offset: 0x3c, length: 4 }],
    show: { pointers: true, unusual: true, tiles: true, memory: true }
  })
  assert.equal('maxRows' in tour, false, 'the planner keeps its default row limit')

  const auto = posterOptions({ options: OPTIONS, mode: 'auto', range: null, fieldIndex: 0, pins, show: DEFAULT_SHOW })
  assert.equal(auto.mode, 'auto')
  assert.deepEqual(auto.pins, [{ offset: 0x3c, length: 4 }], 'pins go along in every mode')

  const selection = posterOptions({ options: OPTIONS, mode: 'selection', range: { start: 4, end: 20 }, fieldIndex: 0, pins: [], show: DEFAULT_SHOW })
  assert.equal(selection.mode, 'selection')
  assert.deepEqual(selection.range, { start: 4, end: 20 })
  assert.deepEqual(selection.pins, [])

  const field = posterOptions({ options: OPTIONS, mode: 'field', range: null, fieldIndex: 3, pins: [], show: DEFAULT_SHOW })
  assert.equal(field.mode, 'field')
  assert.equal(field.fieldIndex, 3)

  assert.equal(posterOptions({ options: OPTIONS, mode: 'nonsense', pins: [], show: DEFAULT_SHOW }).mode, 'tour')
})

test('a tall page asks for more rows; switches that are off reach the layout', () => {
  const tall = posterOptions({
    options: { ...OPTIONS, proportion: 'tall' },
    mode: 'tour',
    range: null,
    fieldIndex: 0,
    pins: [],
    show: { pointers: false, unusual: true, tiles: false, memory: true }
  })
  assert.equal(tall.proportion, 'tall')
  assert.equal(tall.maxRows, TALL_MAX_ROWS)
  assert.deepEqual(tall.show, { pointers: false, unusual: true, tiles: false, memory: true })
  assert.deepEqual(posterOptions({ options: OPTIONS, mode: 'tour', pins: [] }).show, DEFAULT_SHOW, 'missing switches are on')
})

test('the tall row limit reaches the planner through buildPoster', () => {
  const bytes = new Uint8Array(64 * 1024)
  const fields = Array.from({ length: 80 }, (_, i) => ({ name: `f${i}`, offset: i * 512, length: 4 }))
  const analysis = { formatName: 'Test', fields, regions: [], summary: [], warnings: [] }
  const options = posterOptions({ options: { ...OPTIONS, proportion: 'tall', maxLabels: 99 }, mode: 'tour', pins: [], show: DEFAULT_SHOW })
  const { plan } = buildPoster({ bytes, analysis, fileName: 'x.bin', options })
  assert.equal(plan.maxRows, TALL_MAX_ROWS)
  assert.match(describePlan(plan), /at most 120/)
})

test('which Include switches apply to a file', () => {
  assert.deepEqual(includeChoices(null), { pointers: false, unusual: false, tiles: false, memory: false })
  assert.deepEqual(includeChoices({ fields: [], regions: [], unusual: [], image: null }), { pointers: false, unusual: false, tiles: false, memory: false })
  const nested = [{ name: 'a', offset: 0, length: 8, children: [{ name: 'b', offset: 0, length: 4, children: [{ name: 'c', offset: 0, length: 4, target: 0x200 }] }] }]
  assert.equal(includeChoices({ fields: nested }).pointers, true)
  assert.equal(includeChoices({ fields: [{ offset: 0, length: 4, target: -1 }] }).pointers, false)
  assert.equal(includeChoices({ unusual: [{ text: 'The entry point is in the last section.' }] }).unusual, true)
  const regions = n => Array.from({ length: n }, (_, i) => ({ name: `r${i}`, offset: i, length: 1 }))
  assert.equal(includeChoices({ regions: regions(2) }).tiles, false)
  assert.equal(includeChoices({ regions: regions(3) }).tiles, true)
  const image = { addressLabel: 'RVA', entry: null, sections: [{ name: '.text', offset: 0x400, size: 0x200, address: 0x1000, memSize: 0x200, flags: 'r-x' }], total: 1 }
  assert.deepEqual(includeChoices({ image, regions: [] }), { pointers: false, unusual: false, tiles: true, memory: true })
  assert.equal(includeChoices({ image: { sections: [] } }).memory, false)
})

test('the pointer search is bounded', () => {
  const wide = Array.from({ length: 30000 }, (_, i) => ({ offset: i, length: 1 }))
  wide.push({ offset: 0, length: 1, target: 5 })
  assert.equal(hasPointerField(wide), false, 'gives up past the budget')
  assert.equal(hasPointerField(wide, 40000), true)
  // A deep chain does not recurse
  let deep = { offset: 0, length: 1, target: 1 }
  for (let i = 0; i < 50000; i++) deep = { offset: 0, length: 1, children: [deep] }
  assert.equal(hasPointerField([deep], 100000), true)
})

const row = (start, end) => ({ type: 'row', start, end })
const gap = (start, end) => ({ type: 'break', start, end, where: 'inside' })

test('rows are grouped into the places they come from', () => {
  assert.deepEqual(shownPlaces([]), { rows: 0, places: [] })
  const items = [row(0, 16), row(16, 32), gap(32, 0x400), row(0x400, 0x410), gap(0x410, 0xd000), row(0xd000, 0xd010), row(0xd010, 0xd020)]
  assert.deepEqual(shownPlaces(items), { rows: 5, places: [{ start: 0, end: 32 }, { start: 0x400, end: 0x410 }, { start: 0xd000, end: 0xd020 }] })
})

test('the summary sentence for one place and for many', () => {
  const one = { items: [row(0, 16), row(16, 32)], labels: [{ offset: 0, length: 4 }], maxRows: 40, omittedLabels: 0 }
  assert.equal(describePlan(one), 'Showing 0x0–0x1F in 2 rows (at most 40, long runs collapsed) with 1 label.')
  const many = {
    items: [row(0, 16), gap(16, 0x400), row(0x400, 0x410), gap(0x410, 0xd000), row(0xd000, 0xd010)],
    labels: [{ offset: 0, length: 2 }, { offset: 0x3c, length: 4 }, { offset: 0xd000, length: 4 }],
    maxRows: 120,
    omittedLabels: 1
  }
  assert.equal(describePlan(many), 'Showing 3 rows (at most 120, long runs collapsed) from 3 places between 0x0 and 0xD00F, with 3 labels. 1 more field is not labelled.')
  assert.equal(
    describePlan(many, { pins: [{ offset: 0x3c, length: 4 }, { offset: 0x500, length: 8 }] }),
    'Showing 3 rows (at most 120, long runs collapsed) from 3 places between 0x0 and 0xD00F, with 3 labels. 1 more field is not labelled. 1 of 2 pinned fields is labelled.'
  )
  assert.match(describePlan(many, { pins: [{ offset: 0x3c, length: 4 }] }), /The pinned field is labelled\.$/)
  assert.equal(describePlan({ items: [{ type: 'break', start: 0, end: 10, where: 'after' }], labels: [] }), 'Nothing to show.')
  assert.equal(describePlan(null), '')
})

test('the summary stays true for a real plan', () => {
  const fields = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, offset: i * 4, length: 4 }))
  const plan = planPoster({ analysis: { fields }, size: 4096, mode: 'auto' })
  const text = describePlan(plan)
  assert.match(text, /^Showing 0x0–0x7F in 8 rows \(at most 40, long runs collapsed\) with \d+ labels?\./)
  assert.equal(text.includes(`with ${plan.labels.length} label`), true)
})

test('the summary uses the planner\'s count of pinned fields, and leaves pins out of the other modes', () => {
  const child = (name, offset) => ({ name, offset, length: 4, value: `0x${offset.toString(16)}`, kind: 'size' })
  const fields = [
    { name: 'Magic', offset: 0, length: 4, kind: 'magic', value: 'TEST' },
    { name: 'Header', offset: 4, length: 12, children: [child('a', 4), child('b', 8), child('c', 12)] },
    { name: 'Body', offset: 16, length: 64, kind: 'data' }
  ]
  const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7 + 1) & 0xff)
  // The pinned field has children, so it is labelled through them, not as one box of its own
  const pins = [{ offset: 4, length: 12 }]
  const tour = planPoster({ analysis: { fields }, size: bytes.length, bytes, mode: 'tour', pins })
  assert.equal(tour.pins.labelled, 1)
  assert.match(describePlan(tour, { pins }), /The pinned field is labelled\.$/)
  const start = planPoster({ analysis: { fields }, size: bytes.length, bytes, mode: 'auto', pins })
  assert.doesNotMatch(describePlan(start, { pins }), /pinned/)
})
