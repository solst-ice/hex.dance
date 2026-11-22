import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBytes } from '../analysis/analyze.js'
import { buildELF, buildFatMachO, buildLinkedELF, buildMachO, CPU_TYPE_ARM64, CPU_TYPE_X86_64 } from './__fixtures__/executables.js'
import { buildCustomPE, buildManySectionsPE, buildSegmentedMachO, elfSegments } from './__fixtures__/oddities.js'
import { buildPNG } from './__fixtures__/fileFormats.js'

const analyse = bytes => analyzeBytes(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))

test('PE: one entry per section, by RVA, with rwx flags and the entry point', () => {
  const a = analyse(buildCustomPE({ entry: 0x1010 }))
  assert.deepEqual(a.image, {
    addressLabel: 'RVA',
    entry: { address: 0x1010, offset: 0x410 },
    sections: [
      { name: '.text', offset: 0x400, size: 0x200, address: 0x1000, memSize: 0x180, flags: 'r-x' },
      { name: '.rdata', offset: 0x600, size: 0x200, address: 0x2000, memSize: 0x120, flags: 'r--' },
      { name: '.data', offset: 0x800, size: 0x200, address: 0x3000, memSize: 0x300, flags: 'rw-' }
    ],
    total: 3
  })
})

test('PE: a section with no data has size 0, and a DLL without an entry point has none', () => {
  const a = analyse(buildCustomPE({
    entry: 0,
    sections: [
      { name: '.text', vsize: 0x100, va: 0x1000, rawSize: 0x200, raw: 0x400, flags: 0x60000020 },
      { name: '.bss', vsize: 0x800, va: 0x2000, rawSize: 0, raw: 0, flags: 0xC0000080 }
    ]
  }))
  assert.equal(a.image.entry, null)
  assert.deepEqual(a.image.sections[1], { name: '.bss', offset: 0, size: 0, address: 0x2000, memSize: 0x800, flags: 'rw-' })
})

test('PE: the 96-section file lists all 96, writable and executable but not readable', () => {
  const a = analyse(buildManySectionsPE())
  assert.equal(a.image.total, 96)
  assert.equal(a.image.sections.length, 96)
  assert.ok(a.image.sections.every(s => s.flags === '-wx' && s.size === 0x200 && s.name === ''))
  assert.deepEqual(a.image.entry, { address: 0x2000 + 95 * 0x1000, offset: 0x1200 + 95 * 0x200 })
})

test('ELF: PT_LOAD segments named by their permissions', () => {
  const bytes = new Uint8Array(buildLinkedELF())
  const a = analyse(bytes)
  const loads = elfSegments(bytes).filter(s => s.type === 1)
  assert.equal(a.image.addressLabel, 'address')
  assert.equal(a.image.total, loads.length)
  a.image.sections.forEach((s, i) => {
    const flags = `${loads[i].flags & 4 ? 'r' : '-'}${loads[i].flags & 2 ? 'w' : '-'}${loads[i].flags & 1 ? 'x' : '-'}`
    assert.deepEqual(s, { name: `LOAD ${flags}`, offset: loads[i].offset, size: loads[i].filesz, address: loads[i].vaddr, memSize: loads[i].memsz, flags })
  })
  assert.ok(a.image.sections.some(s => s.name === 'LOAD r-x'))
  assert.ok(Number.isSafeInteger(a.image.entry.offset))
})

test('ELF: without program headers, the sections that have an address', () => {
  const a = analyse(buildELF())
  assert.ok(a.image.sections.length > 0)
  assert.ok(a.image.sections.every(s => s.address > 0 && /^[r-][w-][x-]$/.test(s.flags)))
  assert.ok(a.image.sections.some(s => s.name === '.text' && s.flags.endsWith('x')))
})

test('ELF: a segment whose address is not a safe integer is left out but counted', () => {
  const bytes = new Uint8Array(buildLinkedELF())
  const load = elfSegments(bytes).find(s => s.type === 1)
  new DataView(bytes.buffer).setBigUint64(load.at + 16, 0xFFFFFFFF80000000n, true)
  const a = analyse(bytes)
  const loads = elfSegments(bytes).filter(s => s.type === 1).length
  assert.equal(a.image.total, loads)
  assert.equal(a.image.sections.length, loads - 1)
})

test('Mach-O: segments with their addresses, protections and LC_MAIN entry point', () => {
  const a = analyse(buildSegmentedMachO())
  assert.deepEqual(a.image.sections.map(s => [s.name, s.offset, s.size, s.address, s.memSize, s.flags]), [
    ['__PAGEZERO', 0, 0, 0, 0x100000000, '---'],
    ['__TEXT', 0, 0x4000, 0x100000000, 0x4000, 'r-x'],
    ['__DATA', 0x4000, 0x1000, 0x100004000, 0x4000, 'rw-'],
    ['__LINKEDIT', 0x5000, 0x100, 0x100008000, 0x4000, 'r--']
  ])
  assert.deepEqual(a.image.entry, { address: 0x100003F00, offset: 0x3F00 })
  assert.equal(a.image.total, 4)
})

test('Mach-O: a fat file describes its first architecture, at its place in the file', () => {
  const first = buildSegmentedMachO()
  const second = new Uint8Array(buildMachO())
  const fat = buildFatMachO([{ cputype: CPU_TYPE_ARM64, image: first.buffer }, { cputype: CPU_TYPE_X86_64, image: second.buffer }])
  const a = analyse(fat)
  assert.equal(a.image.sections[1].name, '__TEXT')
  assert.equal(a.image.sections[1].offset, 0x1000)
  assert.deepEqual(a.image.entry, { address: 0x100003F00, offset: 0x1000 + 0x3F00 })
})

test('formats that are not loaded have no layout', () => {
  assert.equal(analyse(buildPNG()).image, null)
  assert.equal(analyse(new Uint8Array([1, 2, 3])).image, null)
})
