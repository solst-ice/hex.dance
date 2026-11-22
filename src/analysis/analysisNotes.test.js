import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBytes, cleanFields, cleanImage, cleanUnusual } from './analyze.js'
import { gaveUpAnalysis } from './generic.js'
import { buildCustomPE } from '../formats/__fixtures__/oddities.js'
import { buildPNG } from '../formats/__fixtures__/fileFormats.js'

const SECTION = { name: '.text', offset: 0x400, size: 0x200, address: 0x1000, memSize: 0x180, flags: 'r-x' }

test('every analysis has unusual notes and a layout, on every path', () => {
  const cases = [
    analyzeBytes(new Uint8Array(0)),
    analyzeBytes(new Uint8Array([1, 2, 3])),
    analyzeBytes(new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 9, 1, 1, 0])), // parser error
    analyzeBytes(buildCustomPE(), {}, { limits: { rows: 5 } }), // limit hit
    analyzeBytes(new Uint8Array(buildPNG())),
    gaveUpAnalysis(new Uint8Array(4), 4, {}, 'note', 'timeout')
  ]
  for (const a of cases) {
    assert.ok(Array.isArray(a.unusual), a.formatId)
    assert.ok(a.image === null || typeof a.image === 'object')
  }
  assert.deepEqual(cases.map(a => a.image), [null, null, null, null, null, null])
  assert.ok(cases.every(a => a.unusual.length === 0))
})

test('cleanFields keeps a target only when it is a safe offset inside the file', () => {
  const fields = cleanFields([
    { name: 'ok', offset: 0, length: 4, target: 99 },
    { name: 'end', offset: 0, length: 4, target: 100 },
    { name: 'negative', offset: 0, length: 4, target: -1 },
    { name: 'fraction', offset: 0, length: 4, target: 1.5 },
    { name: 'text', offset: 0, length: 4, target: '5' },
    { name: 'huge', offset: 0, length: 4, target: 2 ** 60 },
    { name: 'parent', offset: 0, length: 8, children: [{ name: 'child', offset: 4, length: 4, target: NaN }, { name: 'kept', offset: 4, length: 4, target: 0 }] }
  ], 100)
  assert.deepEqual(fields.map(f => f.target), [99, undefined, undefined, undefined, undefined, undefined, undefined])
  assert.ok(fields.slice(1, 6).every(f => !('target' in f)))
  assert.ok(!('target' in fields[6].children[0]))
  assert.equal(fields[6].children[1].target, 0)
})

test('cleanUnusual keeps at most 12 sentences and only ranges inside the file', () => {
  const junk = [null, 5, {}, { text: '' }, { text: '   ' }, { text: 42 }]
  const notes = cleanUnusual([
    ...junk,
    { text: 'Inside.', offset: 10, length: 5 },
    { text: 'Past the end.', offset: 100, length: 5 },
    { text: 'Too long a range.', offset: 90, length: 20 },
    { text: 'Bad numbers.', offset: 1.5, length: -2 },
    { text: 'x'.repeat(5000) },
    ...Array.from({ length: 20 }, (_, i) => ({ text: `Note ${i}.` }))
  ], 100)
  assert.equal(notes.length, 12)
  assert.deepEqual(notes[0], { text: 'Inside.', offset: 10, length: 5 })
  assert.deepEqual(notes[1], { text: 'Past the end.' })
  assert.deepEqual(notes[2], { text: 'Too long a range.', offset: 90 })
  assert.deepEqual(notes[3], { text: 'Bad numbers.' })
  assert.ok(notes[4].text.length <= 300 && notes[4].text.endsWith('…'))
  assert.deepEqual(cleanUnusual('nope', 100), [])
})

test('cleanImage checks the numbers, caps the sections and keeps the real count', () => {
  assert.equal(cleanImage(null, 100), null)
  assert.equal(cleanImage({ addressLabel: 'VA', entry: null, sections: [SECTION], total: 1 }, 0x1000), null)
  assert.equal(cleanImage({ addressLabel: 'RVA', entry: null, sections: 'x' }, 0x1000), null)

  const many = Array.from({ length: 3000 }, (_, i) => ({ ...SECTION, address: 0x1000 + i * 0x1000 }))
  const big = cleanImage({ addressLabel: 'RVA', entry: { address: 0x1000, offset: 0x400 }, sections: many, total: 3000 }, 0x1000)
  assert.equal(big.sections.length, 1024)
  assert.equal(big.total, 3000)

  const mixed = cleanImage({
    addressLabel: 'address',
    entry: { address: 0x1000, offset: 0x5000 },
    sections: [SECTION, { ...SECTION, address: 2 ** 64 }, { ...SECTION, size: -1 }, { ...SECTION, memSize: NaN }, null, { ...SECTION, name: 7, flags: 'rwxrwxrwxrwx' }],
    total: 'many'
  }, 0x1000)
  assert.equal(mixed.sections.length, 2)
  assert.deepEqual(mixed.entry, { address: 0x1000, offset: null }, 'an entry offset past the end of the file')
  assert.equal(mixed.total, 6)
  assert.equal(mixed.sections[1].name, '')
  assert.ok(mixed.sections[1].flags.length <= 8)
  assert.equal(cleanImage({ addressLabel: 'RVA', entry: { address: -4 }, sections: [] }, 100), null)
})

test('hidden characters in a section name are shown, in the tree, the layout and the notes', () => {
  // "a", U+202E RIGHT-TO-LEFT OVERRIDE, "txt." in UTF-8: eight bytes
  const name = [0x61, 0xE2, 0x80, 0xAE, 0x74, 0x78, 0x74, 0x2E]
  const bytes = buildCustomPE({
    sections: [
      { name, vsize: 0x100, va: 0x1000, rawSize: 0x200, raw: 0x400, flags: 0xE0000020 },
      { name: '.data', vsize: 0x100, va: 0x2000, rawSize: 0x200, raw: 0x600, flags: 0xC0000040 }
    ]
  })
  const a = analyzeBytes(bytes)
  assert.equal(a.image.sections[0].name, 'a⟨U+202E⟩txt.')
  const note = a.unusual.find(n => /writable and executable/.test(n.text))
  assert.ok(note.text.includes('"a⟨U+202E⟩txt."'), note.text)
  assert.ok(!JSON.stringify(a).includes('‮'))
  assert.ok(a.warnings.some(w => /hidden or direction-changing characters/.test(w)))
})
