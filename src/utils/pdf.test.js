import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePDF, formatPDFDate } from './pdf.js'
import { buildPDF, SIMPLE_PDF, truncate } from './__fixtures__/fileFormats.js'

const list = set => [...set]

test('reads version, page count from the page tree root and the Info dictionary', () => {
  assert.deepEqual(list(parsePDF(buildPDF(SIMPLE_PDF))), [
    'Version: PDF 1.7',
    'Pages: 3',
    'Title: Report (draft) A',
    'Author: Émile',
    'Producer: handmade',
    'Creation Date: 2025-01-01 12:00:00 +02:00'
  ])
})

test('falls back to the largest /Type /Pages count without a trailer', () => {
  const body = SIMPLE_PDF.replace(/trailer[\s\S]*$/, '')
  const result = list(parsePDF(buildPDF(body)))
  assert.ok(result.includes('Pages: 3'))
  // Without /Info, the untyped dictionary with document keys is used
  assert.ok(result.includes('Producer: handmade'))
  assert.ok(!result.some(item => item.includes('Bookmark')))
})

test('uses the latest trailer and object definitions after incremental updates', () => {
  const update = `
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
10 0 obj
<< /Title (Revised) >>
endobj
trailer
<< /Size 11 /Root 1 0 R /Info 10 0 R /Prev 0 >>
%%EOF
`
  const result = list(parsePDF(buildPDF(SIMPLE_PDF + update)))
  assert.ok(result.includes('Pages: 1'))
  assert.ok(result.includes('Title: Revised'))
  assert.ok(!result.some(item => item.startsWith('Producer')))
})

test('does not read Info strings of encrypted documents', () => {
  const body = SIMPLE_PDF.replace('/Info 4 0 R', '/Info 4 0 R /Encrypt 8 0 R')
  const result = list(parsePDF(buildPDF(body)))
  assert.ok(result.includes('Encrypted: Yes'))
  assert.ok(!result.some(item => item.startsWith('Title')))
})

test('never throws on truncated or odd input', () => {
  const pdf = buildPDF(SIMPLE_PDF)
  for (let length = 0; length <= pdf.byteLength; length++) {
    assert.doesNotThrow(() => parsePDF(truncate(pdf, length)))
  }
  assert.deepEqual(list(parsePDF(buildPDF('%PDF-'))), ['Version: PDF unknown'])
  assert.doesNotThrow(() => parsePDF(buildPDF('%PDF-1.4\n1 0 obj << /Title (unterminated \\')))
  assert.doesNotThrow(() => parsePDF(buildPDF('%PDF-1.4\n1 0 obj << /Title <FEFFD8>')))
})

test('scans only the start and end of large files', () => {
  const filler = 'x'.repeat(3 * 1024 * 1024)
  const result = list(parsePDF(buildPDF(SIMPLE_PDF + filler + '\n% tail\n')))
  assert.ok(result.includes('Pages: 3'))
})

test('scan time stays linear on repetitive input', () => {
  const enc = new TextEncoder()
  const cases = [
    '1'.repeat(400000),
    '/Linearized'.repeat(40000),
    '1 0 obj << /A 1 >> endobj\n'.repeat(40000)
  ]
  for (const body of cases) {
    const start = performance.now()
    parsePDF(enc.encode('%PDF-1.4\n' + body).buffer)
    // Quadratic behaviour takes tens of seconds on these inputs
    assert.ok(performance.now() - start < 3000)
  }
})

test('formats PDF dates, including partial ones', () => {
  assert.equal(formatPDFDate('D:20250101120000Z'), '2025-01-01 12:00:00 UTC')
  assert.equal(formatPDFDate("D:19991231235959-05'00'"), '1999-12-31 23:59:59 -05:00')
  assert.equal(formatPDFDate('D:2024'), '2024')
  assert.equal(formatPDFDate('D:202403'), '2024-03')
  assert.equal(formatPDFDate('yesterday'), 'yesterday')
})
