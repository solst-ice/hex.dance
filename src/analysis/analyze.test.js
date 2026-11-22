import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBytes } from './analyze.js'
import { FORMATS } from '../formats/index.js'
import { buildELF, buildPE } from '../formats/__fixtures__/executables.js'
import { buildPNG, buildZip, toArrayBuffer } from '../formats/__fixtures__/fileFormats.js'

const KEYS = ['formatId', 'formatName', 'category', 'summary', 'fields', 'regions', 'symbols', 'entries', 'warnings', 'unusual', 'image']
const lines = analysis => analysis.summary.map(entry => `${entry.label}: ${entry.value}`)

test('fills every property for recognised formats', () => {
  for (const buffer of [buildELF(), buildPE(), buildPNG(), buildZip([{ name: 'a', data: 'a' }])]) {
    const analysis = analyzeBytes(new Uint8Array(buffer), { fileName: 'x', mimeType: '' })
    assert.deepEqual(Object.keys(analysis).sort(), [...KEYS].sort())
    assert.ok(analysis.fields.some(field => field.kind === 'magic'), analysis.formatId)
  }
})

test('describes unknown files with generic facts', () => {
  const analysis = analyzeBytes(new Uint8Array(toArrayBuffer([0x41, 0x0A])), { mimeType: 'text/plain' })
  assert.equal(analysis.formatId, 'unknown')
  assert.equal(analysis.category, 'unknown')
  assert.deepEqual(lines(analysis), ['File Size: 2 Bytes', 'File Type: text/plain', 'First Bytes: 0x410A'])
  assert.deepEqual(lines(analyzeBytes(new Uint8Array(0))), ['File Size: 0 Bytes', 'File Type: application/octet-stream'])
  assert.ok(lines(analyzeBytes(new Uint8Array([1, 2, 3, 4, 5]))).includes('First Bytes: 0x01020304'))
})

test('accepts an ArrayBuffer as well as a Uint8Array', () => {
  assert.equal(analyzeBytes(buildELF()).formatId, 'elf')
})

test('turns a parser exception into a warning with generic facts', () => {
  // ELF magic followed by an invalid class byte
  const analysis = analyzeBytes(new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 9, 1, 1, 0]), { mimeType: '' })
  assert.equal(analysis.formatId, 'elf')
  assert.deepEqual(analysis.warnings, ['Error analyzing file: ELF parsing error: unsupported ELF class 9'])
  assert.ok(lines(analysis).includes('File Size: 8 Bytes'))
})

test('never throws, even when a parser misbehaves', () => {
  const broken = { id: 'broken', name: 'Broken', category: 'data', detect: bytes => bytes[0] === 0xEE, parse: () => { throw 'not an Error' } }
  FORMATS.unshift(broken)
  try {
    const analysis = analyzeBytes(new Uint8Array([0xEE, 1]))
    assert.equal(analysis.formatId, 'broken')
    assert.deepEqual(analysis.warnings, ['Error analyzing file: not an Error'])
  } finally {
    FORMATS.shift()
  }
})

test('drops and clips byte ranges that fall outside the file', () => {
  const custom = {
    id: 'ranges',
    name: 'Ranges',
    category: 'data',
    detect: bytes => bytes[0] === 0xEF,
    parse: () => ({
      fields: [{ name: 'ok', offset: 0, length: 2 }, { name: 'long', offset: 2, length: 100 }, { name: 'out', offset: 50, length: 1 }],
      regions: [{ name: 'b', offset: 4, length: 2 }, { name: 'a', offset: 0, length: 4 }, { name: 'neg', offset: -1, length: 2 }]
    })
  }
  FORMATS.unshift(custom)
  try {
    const analysis = analyzeBytes(new Uint8Array(8).fill(0xEF))
    assert.deepEqual(analysis.fields.map(f => [f.name, f.offset, f.length]), [['ok', 0, 2], ['long', 2, 6]])
    assert.deepEqual(analysis.regions.map(r => r.name), ['a', 'b'])
  } finally {
    FORMATS.shift()
  }
})
