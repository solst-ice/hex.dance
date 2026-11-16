import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { scanFile, parserExtent } from './scan.js'
import { buildReport, rangeEnd, extractName } from './report.js'
import { memorySource } from './source.js'
import { FORMATS } from '../../formats/index.js'
import * as F from './testFixtures.js'

const utf8 = (text) => new TextEncoder().encode(text)

const { concat, noise } = F

async function scan(data, options = {}) {
  return scanFile({ source: memorySource(data), formats: FORMATS, ...options })
}

const brief = (hits) => hits.map(h => `${h.type}@${h.start}+${h.end === null ? '?' : h.end - h.start}`).sort()

test('PNG + ZIP + PDF: every part at its exact offset and size', async () => {
  const png = F.png()
  const zip = F.zip([{ name: 'inner.txt', data: 'zip content' }])
  const pdf = F.pdf()
  const data = concat(png, zip, pdf)
  const { hits } = await scan(data)
  const wanted = [`png@0+${png.length}`, `zip@${png.length}+${zip.length}`, `pdf@${png.length + zip.length}+${pdf.length}`]
  for (const w of wanted) assert.ok(brief(hits).includes(w), `${w} in ${brief(hits)}`)
  const report = buildReport(hits, { size: data.length, formatId: 'png' })
  assert.equal(report.main.type, 'png')
  assert.equal(report.summary, '2 embedded files found after the main PNG image.')
  const appended = report.findings.find(f => f.kind === 'appended')
  assert.equal(appended.start, png.length)
  assert.equal(appended.end, data.length)
})

test('the same hits whatever the chunk size', async () => {
  const data = concat(noise(5000, 1), F.gif(), noise(3000, 2), F.tar([{ name: 'x', data: F.elf(300) }]), noise(777, 3), gzipSync(utf8('a'.repeat(5000))))
  const reference = brief((await scan(data)).hits)
  assert.ok(reference.includes('elf@' + (5000 + F.gif().length + 3000 + 512) + '+300'), reference.join())
  for (const chunkSize of [512, 4096, 10000]) {
    assert.deepEqual(brief((await scan(data, { limits: { chunkSize } })).hits), reference, `chunk ${chunkSize}`)
  }
})

test('pseudo-random data yields no hits', async () => {
  const data = noise(8 << 20, 12345)
  const { hits, stats } = await scan(data)
  assert.deepEqual(brief(hits), [])
  const candidates = Object.values(stats).reduce((n, s) => n + s.candidates, 0)
  assert.ok(candidates > 100, `only ${candidates} candidates; the prefilter is not being exercised`)
})

test('records a walker already visited are not reported again', async () => {
  const zip = F.zip([{ name: 'a', data: 'one' }, { name: 'b', data: 'two' }, { name: 'c', data: 'three' }])
  const t = F.tar([{ name: 'a', data: new Uint8Array(10) }, { name: 'b', data: new Uint8Array(10) }])
  const { hits } = await scan(concat(zip, t))
  assert.deepEqual(brief(hits), [`tar@${zip.length}+${t.length}`, `zip@0+${zip.length}`])
})

test('the hit cap stops the scan', async () => {
  const parts = []
  for (let i = 0; i < 30; i++) parts.push(F.gif(), noise(50, i + 1))
  const result = await scan(concat(...parts), { limits: { maxHits: 10 } })
  assert.equal(result.hits.length, 10)
  assert.equal(result.capped, true)
})

test('format modules confirm hits: parse, detect only, or reject', async () => {
  const data = concat(noise(64, 1), F.png())
  const withParsers = await scan(data)
  assert.equal(withParsers.hits[0].parser, 'parsed')
  const without = await scan(data, { formats: [] })
  assert.equal(without.hits[0].parser, null)
  assert.equal(without.hits[0].confidence, 'high')
  const sceptic = { id: 'png', name: 'PNG', detect: () => false, parse: () => ({}) }
  const rejected = await scan(data, { formats: [sceptic] })
  assert.equal(rejected.hits[0].parser, 'rejected')
  assert.equal(rejected.hits[0].confidence, 'low')
  const broken = { id: 'png', name: 'PNG', detect: () => true, parse: () => { throw new Error('boom') } }
  const failed = await scan(data, { formats: [broken] })
  assert.equal(failed.hits[0].parser, 'parse-error')
  assert.equal(failed.hits[0].confidence, 'medium')
})

test('a parser can supply an end the validator could not', async () => {
  const stub = { id: 'bzip2', name: 'bzip2', detect: () => true, parse: () => ({ regions: [{ name: 'Stream', offset: 0, length: 40 }, { name: 'Trailing data', offset: 40, length: 1000 }] }) }
  const data = concat(noise(10, 1), F.bytes('BZh9', 0x31, 0x41, 0x59, 0x26, 0x53, 0x59), noise(500, 2))
  const { hits } = await scan(data, { formats: [stub] })
  assert.equal(hits[0].end, 10 + 40)
  assert.equal(hits[0].endKind, 'estimated')
  assert.equal(parserExtent({ fields: [{ name: 'a', offset: 2, length: 5 }], regions: [] }), 7)
})

test('a PDF ends at the last %%EOF before the next PDF', async () => {
  const a = F.pdf()
  const update = new TextEncoder().encode('2 0 obj\n<<>>\nendobj\n%%EOF\n')
  const b = F.pdf()
  const data = concat(a, update, noise(100, 1), b)
  const { hits } = await scan(data)
  assert.deepEqual(brief(hits), [`pdf@0+${a.length + update.length}`, `pdf@${a.length + update.length + 100}+${b.length}`])
})

test('the report: internal streams, prepended data, trailing data, polyglots and overlaps', () => {
  const hit = (id, type, start, end, extra = {}) => ({ id, type, name: type.toUpperCase(), start, end, endKind: 'exact', confidence: 'high', note: '', ext: type, parser: null, ...extra })
  const internal = buildReport([hit(0, 'png', 0, 100), hit(1, 'zlib', 33, 90)], { size: 100, formatId: 'png' })
  assert.equal(internal.hits[1].role, 'internal')
  assert.equal(internal.summary, 'Nothing embedded beyond the main PNG.')

  const prepended = buildReport([hit(0, 'gzip', 50, 80)], { size: 120 })
  assert.deepEqual(prepended.findings.map(f => f.kind), ['prepended', 'trailing'])

  const zeros = buildReport([hit(0, 'elf', 0, 100)], { size: 200, lastNonZero: 99, formatId: 'elf' })
  assert.match(zeros.findings[0].title, /zero bytes/)

  const overlay = buildReport([hit(0, 'pe', 0, 100), hit(1, 'zip', 150, 300)], { size: 300, formatId: 'pe' })
  assert.deepEqual(overlay.findings.map(f => f.kind), ['overlay', 'polyglot'])

  const both = buildReport([hit(0, 'iso9660', 0, 1000), hit(1, 'mbr', 0, 800)], { size: 1000, formatId: 'iso9660' })
  assert.ok(both.findings.some(f => f.kind === 'polyglot' && /both/.test(f.title)))

  const shiftedPdf = buildReport([hit(0, 'jpeg', 0, 500), hit(1, 'pdf', 200, 900)], { size: 900, formatId: 'jpeg' })
  assert.deepEqual(shiftedPdf.findings.map(f => f.kind).sort(), ['appended', 'overlap', 'polyglot'])

  assert.equal(buildReport([], { size: 10 }).summary, 'No embedded files found: no known signature passed validation.')
})

test('ends for unknown extents and extract names', () => {
  const hits = [
    { id: 0, start: 10, end: null, role: 'embedded', parent: null },
    { id: 1, start: 20, end: 25, role: 'internal', parent: 0 },
    { id: 2, start: 40, end: 60, role: 'embedded', parent: null }
  ]
  assert.equal(rangeEnd(hits[0], hits, 100, 'next'), 40)
  assert.equal(rangeEnd(hits[0], hits, 100, 'eof'), 100)
  assert.equal(rangeEnd(hits[2], hits, 100, 'next'), 60)
  assert.equal(extractName('photo.final.jpg', { start: 0x1A2B, ext: 'zip' }), 'photo.final-0x1A2B.zip')
  assert.equal(extractName('', { start: 0, ext: 'png' }), 'file-0x0.png')
})

test('empty and tiny files', async () => {
  for (const data of [new Uint8Array(0), new Uint8Array([0x4D]), new Uint8Array([0x4D, 0x5A])]) {
    const result = await scan(data)
    assert.deepEqual(result.hits, [])
  }
})
