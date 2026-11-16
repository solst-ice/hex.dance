import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildModel, capabilitySummary, describeType, filterRows, sortedOrder } from './model.js'
import { CATALOG_SIZE, lookupApi, TAGS } from '../../formats/apiCatalog.js'

const SYMBOLS = [
  { name: 'compute', type: 'T', address: '0x119B', kind: 'function', offset: 4507 },
  { name: 'connect', type: 'U', library: 'libc.so.6', note: 'libc.so.6' },
  { name: 'global_counter', type: 'D', address: '0x4010', kind: 'data' },
  { name: 'helper', type: 't', address: '0x1189' },
  { name: 'main', type: 'T', address: '0x11BE' },
  { name: 'printf@GLIBC_2.2.5', type: 'U', kind: 'function' },
  { name: 'scratch', type: 'b', address: '0xFFFFFFFF00004014' },
  { name: '__gmon_start__', type: 'w' },
  { name: 'VirtualProtect', type: 'U', library: 'KERNEL32.dll' }
]

const names = (model, rows) => [...rows].map(i => model.symbols[i].name)

describe('symbols model', () => {
  const model = buildModel(SYMBOLS)

  it('counts kinds, imports and exports', () => {
    assert.deepEqual(model.counts, { all: 9, function: 4, data: 2, import: 4, export: 3 })
  })

  it('filters by substring, ignoring case', () => {
    assert.deepEqual(names(model, filterRows(model, { query: 'COUN' })), ['global_counter'])
    assert.deepEqual(names(model, filterRows(model, { query: '  c ' })), ['compute', 'connect', 'global_counter', 'printf@GLIBC_2.2.5', 'scratch', 'VirtualProtect'])
    assert.equal(filterRows(model, { query: 'nothing like this' }).length, 0)
  })

  it('applies the quick filters', () => {
    assert.deepEqual(names(model, filterRows(model, { quick: 'function' })), ['compute', 'helper', 'main', 'printf@GLIBC_2.2.5'])
    assert.deepEqual(names(model, filterRows(model, { quick: 'data' })), ['global_counter', 'scratch'])
    assert.deepEqual(names(model, filterRows(model, { quick: 'import' })), ['connect', 'printf@GLIBC_2.2.5', '__gmon_start__', 'VirtualProtect'])
    assert.deepEqual(names(model, filterRows(model, { quick: 'export' })), ['compute', 'global_counter', 'main'])
  })

  it('sorts by type and by 64-bit address, keeping symbols without an address last', () => {
    assert.deepEqual(names(model, filterRows(model, { sortKey: 'address' })), [
      'helper', 'compute', 'main', 'global_counter', 'scratch', 'connect', 'printf@GLIBC_2.2.5', '__gmon_start__', 'VirtualProtect'
    ])
    assert.deepEqual(names(model, filterRows(model, { sortKey: 'address', descending: true })).slice(0, 2), ['VirtualProtect', '__gmon_start__'])
    assert.deepEqual([...filterRows(model, { sortKey: 'type' })].map(i => model.symbols[i].type).join(''), 'DTTUUUbtw')
    assert.equal(sortedOrder(model, 'type'), sortedOrder(model, 'type'))
  })

  it('searches demangled aliases and filters by capability tag', () => {
    const alias = i => (model.symbols[i].name === 'main' ? 'demangled::entry()' : null)
    assert.deepEqual(names(model, filterRows(model, { query: 'entry', alias })), ['main'])
    const tagOf = i => (lookupApi(model.symbols[i].name) || {}).tag || null
    assert.deepEqual(names(model, filterRows(model, { tag: TAGS.network, tagOf })), ['connect'])
    assert.deepEqual(capabilitySummary(model, tagOf), [[TAGS.console, 1], [TAGS.memory, 1], [TAGS.network, 1]])
  })

  it('filters 200,000 symbols quickly', () => {
    const many = Array.from({ length: 200000 }, (_, i) => ({ name: `symbol_${i}_${i % 7 ? 'fn' : 'data'}`, type: i % 3 ? 'T' : 'U', address: i % 3 ? `0x${i.toString(16)}` : undefined }))
    const big = buildModel(many)
    const t = performance.now()
    const rows = filterRows(big, { query: '99_', quick: 'export' })
    assert.ok(performance.now() - t < 250)
    assert.ok(rows.length > 0)
  })

  it('explains type letters', () => {
    assert.equal(describeType('T'), 'Code (text section)')
    assert.equal(describeType('t'), 'Code (text section), local to this file')
    assert.match(describeType('w'), /Weak, undefined/)
  })
})

describe('API catalogue', () => {
  it('knows a few hundred functions', () => {
    assert.ok(CATALOG_SIZE >= 300)
  })

  it('normalises versions, wrappers, suffixes and A/W variants', () => {
    assert.equal(lookupApi('printf@GLIBC_2.2.5').tag, TAGS.console)
    assert.equal(lookupApi('CreateFileW').tag, TAGS.file)
    assert.equal(lookupApi('CreateProcessA').tag, TAGS.spawn)
    assert.equal(lookupApi('LoadLibraryExW').tag, TAGS.dynload)
    assert.equal(lookupApi('fopen$DARWIN_EXTSN').tag, TAGS.file)
    assert.equal(lookupApi('__isoc99_sscanf').tag, TAGS.string)
    assert.match(lookupApi('__memcpy_chk').description, /bounds-checked/)
    assert.equal(lookupApi('IsDebuggerPresent').tag, TAGS.antidebug)
    assert.equal(lookupApi('rand').tag, null)
    assert.equal(lookupApi('my_own_function'), null)
    assert.equal(lookupApi('toString'), null)
  })
})
