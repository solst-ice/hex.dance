import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBytes } from '../analysis/analyze.js'
import { countDirectories, MAX_DIRECTORY_DEPTH } from './zip.js'
import { buildDeepZip, buildPEImportBomb } from './__fixtures__/bombs.js'

// Only a generous ceiling on time, so a slow machine does not fail these;
// before the fix the PE bombs took seconds and gigabytes, or crashed
const CEILING_MS = 20000

function timed(bytes) {
  const started = performance.now()
  const analysis = analyzeBytes(bytes, { fileName: 'bomb' })
  return { analysis, ms: performance.now() - started }
}

test('PE: descriptors sharing one import table list its imports once', () => {
  const { analysis, ms } = timed(buildPEImportBomb())
  assert.equal(analysis.formatId, 'pe')
  assert.ok(ms < CEILING_MS)
  // 65,535 identical rows collapse into one symbol
  assert.ok(analysis.symbols.length <= 65535, `${analysis.symbols.length} symbols`)
  assert.ok(analysis.warnings.some(w => /4,095 import descriptors reuse an import table that is already listed/.test(w)), analysis.warnings.join('\n'))
})

test('PE: imported names are capped in total', () => {
  const { analysis, ms } = timed(buildPEImportBomb({ nameLength: 4093, descriptors: 1 }))
  assert.ok(ms < CEILING_MS)
  assert.ok(analysis.warnings.some(w => /Imported names add up to more than 4 million characters/.test(w)), analysis.warnings.join('\n'))
  const text = analysis.symbols.reduce((sum, symbol) => sum + symbol.name.length, 0)
  assert.ok(text <= 5 << 20, `${text} characters of names`)
})

test('PE: a descriptor whose DLL name is not a file name ends the import list', () => {
  const { analysis } = timed(buildPEImportBomb({ dllName: Uint8Array.of(0x01, 0xC3, 0x28) }))
  assert.equal(analysis.symbols.length, 0)
  assert.ok(analysis.warnings.includes('Import descriptor 1 does not look like one (its DLL name is missing or is not a file name), so the import list stops there'), analysis.warnings.join('\n'))
})

test('PE: a descriptor whose import table is outside every section ends the import list', () => {
  const bytes = buildPEImportBomb({ descriptors: 2 })
  const view = new DataView(bytes.buffer)
  // The second descriptor's tables point far past the only section
  view.setUint32(0x1000 + 20, 0x900000, true)
  view.setUint32(0x1000 + 20 + 16, 0x900000, true)
  const { analysis } = timed(bytes)
  assert.ok(analysis.symbols.length > 0)
  assert.ok(analysis.warnings.includes('Import descriptor 2 does not look like one (its import table is outside every section), so the import list stops there'), analysis.warnings.join('\n'))
})

test('ZIP: directories are counted without building every path prefix', () => {
  assert.deepEqual(countDirectories([{ name: 'a/b/c.txt' }, { name: 'a/b/' }, { name: 'a/d/' }, { name: 'x.txt' }, { name: './a/b/e' }]), { count: 3, tooDeep: 0 })
  // Same folder name under different parents counts twice
  assert.deepEqual(countDirectories([{ name: 'a/x/f' }, { name: 'b/x/f' }]), { count: 4, tooDeep: 0 })
})

test('ZIP: paths thousands of folders deep finish quickly and are counted up to a depth', () => {
  const { analysis, ms } = timed(buildDeepZip(4))
  assert.equal(analysis.formatId, 'zip')
  assert.ok(ms < CEILING_MS)
  const directories = analysis.summary.find(entry => entry.label === 'Directories')
  assert.equal(directories.value, `${4 * MAX_DIRECTORY_DEPTH} or more`)
  assert.ok(analysis.warnings.includes('4 entries have paths more than 1,024 folders deep; deeper folders are not counted'), analysis.warnings.join('\n'))
})
