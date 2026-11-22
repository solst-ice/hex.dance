import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { analyzeBytes } from '../analysis/analyze.js'
import { buildELF, buildFatMachO, buildFullPE, buildJavaClass, buildLinkedELF, buildMachO, buildPE, CPU_TYPE_ARM64 } from './__fixtures__/executables.js'
import { buildCustomPE, buildManySectionsPE, buildSegmentedMachO, elfHeader, elfSegments } from './__fixtures__/oddities.js'
import { buildFullClass, buildFullGIF, buildFullJPEG, buildFullPDF, buildFullPNG, buildFullZip } from './__fixtures__/structure.js'
import { buildGIF, buildJPEG, buildPNG, buildZip } from './__fixtures__/fileFormats.js'
import * as more from './__fixtures__/moreFormats.js'

const analyse = bytes => analyzeBytes(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
const notes = bytes => analyse(bytes).unusual.map(n => n.text)

function assertNote(bytes, pattern) {
  const found = notes(bytes)
  assert.ok(found.some(text => pattern.test(text)), `expected a note matching ${pattern}, got ${JSON.stringify(found)}`)
}

function assertNoNote(bytes, pattern) {
  const found = notes(bytes)
  assert.ok(!found.some(text => pattern.test(text)), `expected no note matching ${pattern}, got ${JSON.stringify(found)}`)
}

const TEXT = { name: '.text', vsize: 0x100, va: 0x1000, rawSize: 0x200, raw: 0x400, flags: 0x60000020 }
const RDATA = { name: '.rdata', vsize: 0x100, va: 0x2000, rawSize: 0x200, raw: 0x600, flags: 0x40000040 }
const DATA = { name: '.data', vsize: 0x100, va: 0x3000, rawSize: 0x200, raw: 0x800, flags: 0xC0000040 }
const RELOC = { name: '.reloc', vsize: 0x100, va: 0x4000, rawSize: 0x200, raw: 0xA00, flags: 0x42000040 }

// ---------------------------------------------------------------- ordinary files

test('ordinary fixtures and samples get no notes', () => {
  const files = [
    ['buildELF', buildELF()], ['buildELF 32-bit', buildELF({ is64: false })], ['buildLinkedELF', buildLinkedELF()],
    ['buildLinkedELF exec', buildLinkedELF({ kind: 'exec' })], ['buildLinkedELF shared', buildLinkedELF({ kind: 'shared' })],
    ['buildMachO', buildMachO()], ['buildFatMachO', buildFatMachO([{ cputype: CPU_TYPE_ARM64, image: buildMachO() }])],
    ['buildSegmentedMachO', buildSegmentedMachO()], ['buildPE', buildPE()], ['buildPE PE32', buildPE({ pe32Plus: false })],
    ['buildFullPE', buildFullPE()], ['buildCustomPE', buildCustomPE()],
    ['buildCustomPE 64-bit, imports, TLS', buildCustomPE({ pe32Plus: true, imports: true, tlsCallbacks: [0x1010] })],
    ['buildJavaClass', buildJavaClass()], ['buildFullClass', buildFullClass()],
    ['buildZip', buildZip([{ name: 'a.txt', data: 'hello' }])], ['buildFullZip', buildFullZip([{ name: 'a.txt', data: 'hello' }, { name: 'd/', data: '' }])],
    ['buildFullZip zip64', buildFullZip([{ name: 'a.txt', data: 'hello' }], { zip64: true })],
    ['buildPNG', buildPNG()], ['buildFullPNG', buildFullPNG()], ['buildGIF', buildGIF()], ['buildFullGIF', buildFullGIF()],
    ['buildJPEG', buildJPEG()], ['buildFullJPEG', buildFullJPEG()], ['buildFullPDF', buildFullPDF()]
  ]
  for (const [name, fn] of Object.entries(more)) {
    if (!/^build/.test(name) || ['buildRIFF', 'buildText', 'buildUtf16'].includes(name)) continue
    files.push([name, fn()])
  }
  const samples = new URL('../../public/samples/', import.meta.url)
  for (const name of readdirSync(samples)) files.push([name, new Uint8Array(readFileSync(new URL(name, samples)))])
  for (const [name, built] of files) {
    const a = analyse(built)
    assert.deepEqual(a.unusual, [], `${name} (${a.formatId})`)
  }
})

// ---------------------------------------------------------------- PE

test('PE: the 96-section file gets the notes its bytes show', () => {
  const found = notes(buildManySectionsPE())
  assert.equal(found.length, 6)
  assert.match(found[0], /96 sections, the most the Windows XP loader accepts/)
  assert.match(found[1], /entry point is in the last of the 96 sections/)
  assert.match(found[2], /^All 96 sections are both writable and executable \(flags 0xA0000000\)/)
  assert.match(found[3], /^All 96 sections have the same size \(0x200 bytes\) and flags \(0xA0000000\)/)
  assert.match(found[4], /None of the 96 sections has a name/)
  assert.match(found[5], /timestamp is zero/)
  const first = analyse(buildManySectionsPE()).unusual[0]
  assert.deepEqual([first.offset, first.length], [0x46, 2])
})

test('PE: section counts', () => {
  assertNote(buildManySectionsPE({ count: 100, named: true, flags: 0x60000020 }), /100 sections; the Windows XP loader accepts at most 96/)
  assertNoNote(buildManySectionsPE({ count: 95, named: true, flags: 0x60000020 }), /loader accepts/)
  assertNote(buildCustomPE({ sections: [] }), /section table is empty/)
})

test('PE: where the entry point is', () => {
  assertNote(buildCustomPE({ entry: 0x9000 }), /entry point \(RVA 0x9000\) is outside every section/)
  assertNote(buildCustomPE({ sections: [RDATA, DATA, TEXT], entry: 0x1000 }), /entry point is in the last of the 3 sections/)
  assertNote(buildCustomPE({ sections: [TEXT, DATA, RELOC], entry: 0x3000 }), /entry point is in section "\.data", which is writable/)
  assertNoNote(buildCustomPE({ sections: [TEXT, DATA, RELOC], entry: 0x1000 }), /entry point/)
})

test('PE: writable code', () => {
  const bytes = buildCustomPE({ sections: [{ ...TEXT, flags: 0xE0000020 }, RDATA, DATA] })
  const note = analyse(bytes).unusual.find(n => /writable and executable/.test(n.text))
  assert.match(note.text, /^Section "\.text" is both writable and executable \(flags 0xE0000020\)/)
  // Points at that section's Characteristics
  assert.equal(new DataView(bytes.buffer).getUint32(note.offset, true), 0xE0000020)
  // The entry point's own section is covered by that note, not a second one
  assertNoNote(bytes, /entry point is in section/)
})

test('PE: many sections alike, and names', () => {
  const alike = Array.from({ length: 10 }, (_, i) => ({ ...RDATA, name: `.r${i}`, va: 0x2000 + i * 0x1000, raw: 0x600 + i * 0x200 }))
  assertNote(buildCustomPE({ sections: [TEXT, ...alike] }), /^10 sections have the same size \(0x200 bytes in the file, 0x100 in memory\) and flags \(0x40000040\)/)
  assertNoNote(buildCustomPE({ sections: [TEXT, ...alike.slice(0, 7)] }), /same size/)
  assertNote(buildCustomPE({ sections: [{ ...TEXT, name: '' }] }), /The only section has no name/)
  assertNoNote(buildCustomPE({ sections: [TEXT, { ...RDATA, name: '' }] }), /name/)
})

test('PE: overlapping sections', () => {
  assertNote(buildCustomPE({ sections: [TEXT, { ...RDATA, raw: 0x500 }, DATA] }), /Sections "\.text" and "\.rdata" overlap in the file/)
  assertNote(buildCustomPE({ sections: [TEXT, { ...RDATA, va: 0x1080 }, DATA] }), /Sections "\.text" and "\.rdata" overlap in memory/)
  // Sharing an RVA range is checked on the declared sizes, so adjacent sections are fine
  assertNoNote(buildCustomPE({ sections: [{ ...TEXT, vsize: 0x1000 }, RDATA, DATA] }), /overlap/)
})

test('PE: timestamps', () => {
  assertNote(buildCustomPE({ timestamp: 0 }), /timestamp is zero/)
  assertNote(buildCustomPE({ timestamp: 0xF0000000 }), /timestamp is 2097-.*in the future/)
  // A Repro debug entry says the timestamp is a hash; Go writes zero
  assertNoNote(buildCustomPE({ timestamp: 0xF0000000, repro: true }), /timestamp/)
  assertNoNote(buildCustomPE({ timestamp: 0, repro: true }), /timestamp/)
  const go = Array.from('\xFF Go build ID: "abc"', c => c.charCodeAt(0))
  assertNoNote(buildCustomPE({ timestamp: 0, textPrefix: go }), /timestamp/)
})

test('PE: header placement, sizes and alignment', () => {
  const late = [TEXT, RDATA, DATA].map(s => ({ ...s, raw: s.raw + 0x3000 }))
  assertNote(buildCustomPE({ peOffset: 0x20 }), /PE header starts at 0x20, inside the 64-byte DOS header/)
  assertNote(buildCustomPE({ peOffset: 0x2000, sections: late }), /PE header starts at 0x2000, far into the file/)
  assertNoNote(buildCustomPE({ peOffset: 0x200, sections: late }), /PE header/)
  assertNote(buildCustomPE({ rvaCount: 10 }), /lists 10 data directories instead of the usual 16/)
  assertNote(buildCustomPE({ optionalHeaderSize: 0xF8 }), /declared as 248 bytes long; in a 32-bit program it is normally 224/)
  assertNoNote(buildCustomPE({ pe32Plus: true }), /optional header/)
  assertNote(buildCustomPE({ fileAlignment: 0x20, sectionAlignment: 0x20 }), /aligned to 0x20 bytes in the file and 0x20 in memory/)
  assertNoNote(buildCustomPE({ fileAlignment: 0x20, sectionAlignment: 0x20, subsystem: 10 }), /aligned/)
  assertNoNote(buildCustomPE({ fileAlignment: 0x1000, sectionAlignment: 0x10000 }), /aligned/)
})

test('PE: TLS callbacks outside code', () => {
  assertNote(buildCustomPE({ tlsCallbacks: [0x3010] }), /TLS callback, which runs before the entry point, is at RVA 0x3010, outside every code section/)
  assertNote(buildCustomPE({ tlsCallbacks: [0x9000] }), /outside every code section/)
  assertNoNote(buildCustomPE({ tlsCallbacks: [0x1010, 0x1020] }), /TLS/)
})

test('PE: at most eight notes, most telling first', () => {
  const bytes = buildManySectionsPE({ count: 120 })
  const a = analyse(bytes)
  assert.ok(a.unusual.length <= 8)
  assert.match(a.unusual[0].text, /120 sections/)
})

// ---------------------------------------------------------------- ELF

const patched = (bytes, change) => {
  const copy = new Uint8Array(bytes)
  change(copy, new DataView(copy.buffer))
  return copy
}

test('ELF: missing section headers', () => {
  assertNote(buildLinkedELF({ noSectionHeaders: true }), /no section headers/)
})

test('ELF: entry point outside every loadable segment', () => {
  assertNote(patched(buildLinkedELF(), (b, v) => v.setBigUint64(24, 0x7f0000000n, true)), /entry point \(0x7F0000000\) is outside every loadable segment/)
})

test('ELF: writable and executable segment', () => {
  const bytes = patched(buildLinkedELF(), (b, v) => {
    const rw = elfSegments(b).find(s => s.type === 1 && s.flags === 6)
    v.setUint32(rw.at + 4, 7, true)
  })
  assertNote(bytes, /Loadable segment \d+ is both writable and executable/)
})

test('ELF: overlapping header tables', () => {
  const bytes = patched(buildLinkedELF(), (b, v) => v.setBigUint64(40, BigInt(elfHeader(b).phoff), true))
  assertNote(bytes, /program header table and the section header table overlap/)
})

test('ELF: e_shstrndx that names no string table', () => {
  assertNote(patched(buildLinkedELF(), (b, v) => v.setUint16(62, 0x7777, true)), /e_shstrndx \(30583\) does not name a string table section/)
  assertNote(patched(buildLinkedELF(), (b, v) => v.setUint16(62, 0, true)), /e_shstrndx is 0/)
})

// ---------------------------------------------------------------- Mach-O

function machO(change) {
  const segments = [
    { name: '__PAGEZERO', vmaddr: 0, vmsize: 0x100000000, fileoff: 0, filesize: 0, initprot: 0, sections: [] },
    { name: '__TEXT', vmaddr: 0x100000000, vmsize: 0x4000, fileoff: 0, filesize: 0x4000, initprot: 5, sections: [] },
    { name: '__DATA', vmaddr: 0x100004000, vmsize: 0x4000, fileoff: 0x4000, filesize: 0x1000, initprot: 3, sections: [] }
  ]
  const options = { segments, entryoff: 0x3F00 }
  change(options)
  return buildSegmentedMachO(options)
}

test('Mach-O: writable and executable segment, but not an old __IMPORT', () => {
  assertNote(machO(o => { o.segments[2].initprot = 7 }), /Segment "__DATA" is both writable and executable/)
  assertNoNote(machO(o => { o.segments.push({ name: '__IMPORT', vmaddr: 0x100008000, vmsize: 0x1000, fileoff: 0x5000, filesize: 0x100, initprot: 7, sections: [] }) }), /writable/)
})

test('Mach-O: entry point outside every segment, and overlapping segments', () => {
  assertNote(machO(o => { o.entryoff = 0x100000 }), /entry point \(0x100100000\) is outside every segment/)
  assertNote(machO(o => { o.segments[2].fileoff = 0x3000 }), /Segments "__TEXT" and "__DATA" overlap in the file/)
})

// ---------------------------------------------------------------- ZIP

test('ZIP: data before the archive, after the end record, and counts that disagree', () => {
  const prefix = new Uint8Array(64).fill(0x90)
  prefix.set([0x50, 0x4B, 0x03, 0x04])
  const before = analyse(buildFullZip([{ name: 'a.txt', data: 'hello' }], { prefix })).unusual
  assert.match(before[0].text, /archive starts 64 bytes into the file/)
  assert.deepEqual([before[0].offset, before[0].length], [0, 64])
  assertNote(buildFullZip([{ name: 'a.txt', data: 'hello' }], { trailing: 'junk' }), /^4 bytes follow the end of central directory record/)
  const zip64 = patched(buildFullZip([{ name: 'a.txt', data: 'hello' }], { zip64: true }), (b, v) => v.setUint16(b.length - 22 + 10, 3, true))
  assertNote(zip64, /end record counts 3 entries and the ZIP64 end record 1 entry/)
})
