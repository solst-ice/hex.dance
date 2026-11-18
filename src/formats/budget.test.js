import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chargeRows, chargeText, limitsFor, limitWarning, MIN_MS, MIN_ROWS, MIN_TEXT, ParseLimitError, refundRows, runParse, tick } from './budget.js'
import { analyzeBytes } from '../analysis/analyze.js'
import { FORMATS } from './index.js'
import { field } from './reader.js'
import { buildELF, buildFullPE } from './__fixtures__/executables.js'
import { buildDeepZip, buildPEImportBomb } from './__fixtures__/bombs.js'
import { scanFile } from '../panels/carve/scan.js'
import { memorySource } from '../panels/carve/source.js'

const bytes = n => new Uint8Array(n)

test('limits grow with the file from a floor', () => {
  assert.deepEqual(limitsFor(0), { rows: MIN_ROWS, text: MIN_TEXT, ms: MIN_MS })
  const big = limitsFor(1 << 30)
  assert.equal(big.rows, MIN_ROWS + (1 << 26))
  assert.equal(big.text, MIN_TEXT + 2 * 2 ** 30)
  assert.equal(big.ms, MIN_MS + 1024 * 40)
  assert.deepEqual(limitsFor(NaN), limitsFor(0))
})

test('charges outside a parse do nothing', () => {
  chargeRows(1e12)
  chargeText(1e12)
  refundRows(5)
  for (let i = 0; i < 5000; i++) tick()
})

test('a parse that builds too many rows is stopped', () => {
  const run = runParse(() => { for (;;) field('x', 0, 1) }, bytes(10), {}, { rows: 1000 })
  assert.equal(run.limit, 'rows')
  assert.equal(run.result, null)
  assert.equal(run.error, null)
  assert.equal(run.used.rows, 1001)
})

test('a parse that decodes too much text is stopped', () => {
  const run = runParse(() => { for (;;) chargeText(4096) }, bytes(10), {}, { text: 1 << 20 })
  assert.equal(run.limit, 'text')
})

test('a parse that takes too long is stopped, even in a loop that builds nothing', () => {
  const started = performance.now()
  const run = runParse(() => { for (;;) tick() }, bytes(10), {}, { ms: 50 })
  assert.equal(run.limit, 'time')
  assert.ok(performance.now() - started < 5000)
})

test('a parser that swallows the error is still reported as stopped', () => {
  const run = runParse(() => {
    try {
      for (;;) chargeRows()
    } catch {
      // A parser that carries on after an error must not hide the limit
    }
    return { summary: [] }
  }, bytes(10), {}, { rows: 10 })
  assert.equal(run.limit, 'rows')
  assert.equal(run.result, null)
})

test('once spent, every later charge throws at once', () => {
  let thrown = 0
  runParse(() => {
    for (let i = 0; i < 100; i++) {
      try {
        chargeRows()
      } catch (err) {
        assert.ok(err instanceof ParseLimitError)
        thrown++
      }
    }
  }, bytes(10), {}, { rows: 10 })
  assert.equal(thrown, 90)
})

test('rows that a capped list lets go are given back', () => {
  const run = runParse(() => {
    for (let i = 0; i < 100; i++) {
      field('x', 0, 1)
      refundRows(1)
    }
    return 'done'
  }, bytes(10), {}, { rows: 10 })
  assert.equal(run.limit, null)
  assert.equal(run.result, 'done')
})

test('ordinary errors are passed on and nested parses keep their own budget', () => {
  const run = runParse(() => {
    const inner = runParse(() => { for (;;) chargeRows() }, bytes(10), {}, { rows: 5 })
    assert.equal(inner.limit, 'rows')
    chargeRows(50)
    throw new Error('broken')
  }, bytes(10), {}, { rows: 100 })
  assert.equal(run.limit, null)
  assert.equal(run.error.message, 'broken')
  assert.equal(run.used.rows, 50)
})

test('analyzeBytes answers a spent budget with the generic summary and one plain warning', () => {
  const analysis = analyzeBytes(buildELF(), { fileName: 'a', mimeType: 'application/x-elf' }, { limits: { rows: 20 } })
  assert.equal(analysis.formatId, 'elf')
  assert.deepEqual(analysis.summary.map(entry => entry.label), ['File Size', 'File Type', 'First Bytes'])
  assert.deepEqual(analysis.fields, [])
  assert.deepEqual(analysis.symbols, [])
  assert.deepEqual(analysis.warnings, [limitWarning('rows')])
  assert.match(analysis.warnings[0], /describes far more records than a file of its size normally holds, so its analysis was stopped early/)
  assert.match(limitWarning('time'), /took longer to read than a file of its size should/)
  assert.match(limitWarning('text'), /asks for far more text/)
})

test('analyzeBytes counts rows a parser built without the shared helpers', () => {
  const fake = {
    id: 'fake',
    name: 'Fake',
    category: 'data',
    detect: data => data[0] === 0xFE && data[1] === 0xED && data[2] === 0xFA && data[3] === 0x11,
    parse: () => ({ symbols: Array.from({ length: 500 }, (_, i) => ({ name: `s${i}`, type: 'T' })) })
  }
  FORMATS.unshift(fake)
  try {
    const data = Uint8Array.of(0xFE, 0xED, 0xFA, 0x11)
    assert.equal(analyzeBytes(data).symbols.length, 500)
    const capped = analyzeBytes(data, {}, { limits: { rows: 100 } })
    assert.deepEqual(capped.symbols, [])
    assert.deepEqual(capped.warnings, [limitWarning('rows')])
  } finally {
    FORMATS.splice(FORMATS.indexOf(fake), 1)
  }
})

test('honest fixtures stay far inside their limits', () => {
  for (const data of [buildELF(), buildFullPE()]) {
    const analysis = analyzeBytes(data)
    assert.ok(!analysis.warnings.some(w => /stopped early/.test(w)), analysis.formatId)
  }
})

test('the bombs finish with bounded output under the budget', () => {
  for (const data of [buildPEImportBomb(), buildPEImportBomb({ nameLength: 4093 }), buildDeepZip(8)]) {
    const analysis = analyzeBytes(data)
    const rows = analysis.symbols.length + analysis.entries.length + analysis.regions.length
    assert.ok(rows < 100000, `${rows} rows`)
    assert.ok(JSON.stringify(analysis).length < 32 << 20)
    assert.ok(analysis.warnings.length > 0)
  }
})

test('the Embedded scan runs parsers under the same budget', async () => {
  const runaway = {
    id: 'zip',
    name: 'Runaway',
    detect: () => true,
    parse: () => { for (;;) field('x', 0, 1) }
  }
  const zip = await import('./__fixtures__/fileFormats.js')
  const data = new Uint8Array(zip.buildZip([{ name: 'a.txt', data: 'hello' }]))
  const started = performance.now()
  const { hits } = await scanFile({ source: memorySource(data), formats: [runaway] })
  assert.ok(performance.now() - started < 20000)
  const hit = hits.find(h => h.type === 'zip')
  assert.ok(hit, JSON.stringify(hits))
  assert.equal(hit.parser, 'parse-error')
  assert.match(hit.note, /parser was stopped because this data asks for far more work than its size allows/)
})
