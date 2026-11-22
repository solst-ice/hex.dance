import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBytes } from '../analysis/analyze.js'
import { buildFatMachO, buildFullPE, buildLinkedELF, CPU_TYPE_ARM64 } from './__fixtures__/executables.js'
import { buildCustomPE, buildManySectionsPE, buildSegmentedMachO, elfHeader, elfSegments } from './__fixtures__/oddities.js'
import { buildFullPDF, buildFullZip } from './__fixtures__/structure.js'
import { buildBMP, buildBplist, buildICO, buildISO, buildTIFF, buildTTF, build7z } from './__fixtures__/moreFormats.js'

const analyse = bytes => analyzeBytes(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))

// Every node in the tree, depth first, with the names of its ancestors
function nodes(fields, path = []) {
  const out = []
  for (const f of fields) {
    out.push({ f, path: [...path, f.name] })
    if (f.children) out.push(...nodes(f.children, [...path, f.name]))
  }
  return out
}

const named = (analysis, name, within) => nodes(analysis.fields)
  .filter(({ f, path }) => f.name === name && (!within || path.some(p => p.startsWith(within))))
  .map(({ f }) => f)

const one = (analysis, name, within) => {
  const found = named(analysis, name, within)
  assert.equal(found.length, 1, `${name} in ${within || 'the tree'}: ${found.length} found`)
  return found[0]
}

const ascii = (bytes, at, n) => String.fromCharCode(...bytes.subarray(at, at + n))

// Holds for every format: targets are inside the file, on fields that say they point
function assertTargetsSane(analysis, size) {
  for (const { f } of nodes(analysis.fields)) {
    if (!('target' in f)) continue
    assert.ok(Number.isSafeInteger(f.target) && f.target >= 0 && f.target < size, `${f.name}: ${f.target}`)
    assert.ok(f.kind, `${f.name} has a kind`)
  }
}

test('PE: header, section and directory pointers resolve to file offsets', () => {
  const bytes = buildCustomPE({ imports: true, tlsCallbacks: [0x1010], symbolTable: 0xA00 - 18 })
  const a = analyse(bytes)
  assertTargetsSane(a, bytes.length)
  const lfanew = one(a, 'e_lfanew')
  assert.equal(lfanew.target, 0x80)
  assert.equal(ascii(bytes, lfanew.target, 2), 'PE')
  assert.equal(lfanew.kind, 'offset')
  assert.equal(one(a, 'AddressOfEntryPoint').target, 0x400)
  assert.equal(one(a, 'PointerToSymbolTable').target, 0xA00 - 18)

  // Each section header, and its PointerToRawData, point at the section's data
  const raws = [0x400, 0x600, 0x800]
  for (const [i, name] of ['.text', '.rdata', '.data'].entries()) {
    const header = one(a, `[${i}] ${name}`)
    assert.equal(header.target, raws[i])
    assert.equal(header.kind, 'header')
    assert.equal(header.children.find(c => c.name === 'PointerToRawData').target, raws[i])
  }

  // Data directory entries are RVAs; the last section maps RVA 0x3000 to 0x800
  const importEntry = one(a, '[1] Import table')
  assert.equal(importEntry.target, 0x800)
  assert.equal(importEntry.children.find(c => c.name === 'VirtualAddress').target, 0x800)
  const descriptor = one(a, 'KERNEL32.dll', 'Import directory')
  const name = descriptor.children.find(c => c.name === 'Name')
  assert.equal(ascii(bytes, name.target, 12), 'KERNEL32.dll')
  assert.ok(descriptor.children.find(c => c.name === 'OriginalFirstThunk').target > 0x800)

  // TLS: virtual addresses less the image base
  const callbacks = one(a, 'AddressOfCallBacks')
  assert.equal(new DataView(bytes.buffer).getUint32(callbacks.target, true), 0x400000 + 0x1010)
  assert.equal(one(a, '[9] TLS table').target, one(a, 'TLS directory').offset)
})

test('PE: debug, CLR, delay-load, export and certificate pointers', () => {
  const bytes = new Uint8Array(buildFullPE())
  const a = analyse(bytes)
  assertTargetsSane(a, bytes.length)
  const certificate = one(a, '[4] Certificate table')
  assert.equal(certificate.target, one(a, 'Certificate table').offset)
  const debug = named(a, 'PointerToRawData', 'Debug directory')
  assert.ok(debug.length >= 1)
  assert.equal(ascii(bytes, debug[0].target, 4), 'RSDS')
  assert.equal(new DataView(bytes.buffer).getUint32(one(a, 'MetaDataRVA').target, true), 0x424A5342)
  const delayName = named(a, 'DllNameRVA')
  assert.ok(delayName.length >= 1 && delayName.every(f => Number.isSafeInteger(f.target)))
})

test('PE: a section with no data in the file points nowhere', () => {
  const bytes = buildCustomPE({
    sections: [
      { name: '.text', vsize: 0x100, va: 0x1000, rawSize: 0x200, raw: 0x400, flags: 0x60000020 },
      { name: '.bss', vsize: 0x100, va: 0x2000, rawSize: 0, raw: 0x600, flags: 0xC0000080 },
      { name: '.far', vsize: 0x100, va: 0x3000, rawSize: 0x200, raw: 0x10000, flags: 0x40000040 }
    ]
  })
  const a = analyse(bytes.subarray(0, 0x600))
  assert.ok(!('target' in one(a, '[1] .bss')))
  assert.ok(!('target' in one(a, '[2] .far')), 'data past the end of the file')
})

test('PE: the 96-section file has a target for every section header', () => {
  const bytes = buildManySectionsPE()
  const a = analyse(bytes)
  const headers = nodes(a.fields).filter(({ path }) => path[0] === 'Section table' && path.length === 2).map(({ f }) => f)
  assert.equal(headers.length, 96)
  headers.forEach((header, i) => assert.equal(header.target, 0x1200 + i * 0x200))
  assert.equal(one(a, 'AddressOfEntryPoint').target, 0x1200 + 95 * 0x200)
})

test('ELF: header, program header and section header pointers', () => {
  const bytes = new Uint8Array(buildLinkedELF())
  const a = analyse(bytes)
  assertTargetsSane(a, bytes.length)
  const h = elfHeader(bytes)
  assert.equal(one(a, 'e_phoff').target, h.phoff)
  assert.equal(one(a, 'e_shoff').target, h.shoff)
  const segments = elfSegments(bytes)
  const load = segments.find(s => s.type === 1 && s.vaddr <= h.entry && h.entry < s.vaddr + s.filesz)
  assert.equal(one(a, 'e_entry').target, load.offset + (h.entry - load.vaddr))

  const table = one(a, 'Program header table')
  table.children.forEach((node, i) => {
    const s = segments[i]
    const p = node.children.find(c => c.name === 'p_offset')
    if (s.filesz > 0) {
      assert.equal(node.target, s.offset, node.name)
      assert.equal(p.target, s.offset)
    } else {
      assert.ok(!('target' in node) && !('target' in p), `${node.name} has no bytes in the file`)
    }
  })
  const sections = one(a, 'Section header table').children
  const view = h.view
  sections.forEach((node, i) => {
    const at = h.shoff + i * h.shentsize
    const type = view.getUint32(at + 4, true)
    const offset = Number(view.getBigUint64(at + 24, true))
    const size = Number(view.getBigUint64(at + 32, true))
    if (i > 0 && type !== 8 && size > 0) assert.equal(node.target, offset, node.name)
    else assert.ok(!('target' in node), node.name)
    const sh = node.children.find(c => c.name === 'sh_offset')
    assert.equal(sh.target, node.target)
  })
})

test('ELF: without section headers e_shoff points nowhere', () => {
  const a = analyse(buildLinkedELF({ noSectionHeaders: true }))
  assert.ok(!('target' in one(a, 'e_shoff')))
  assert.equal(one(a, 'e_phoff').target, 64)
})

test('Mach-O: segment, section, symbol table and entry point offsets', () => {
  const bytes = buildSegmentedMachO()
  const a = analyse(bytes)
  assertTargetsSane(a, bytes.length)
  const fileoffs = named(a, 'fileoff')
  assert.deepEqual(fileoffs.map(f => f.target), [undefined, 0, 0x4000, 0x5000])
  assert.equal(one(a, '__TEXT,__text').target, 0x3F00)
  assert.equal(one(a, 'offset', '__TEXT,__text').target, 0x3F00)
  assert.equal(one(a, 'entryoff').target, 0x3F00)
  assert.equal(one(a, 'stroff').target, 0x5080)
  assert.ok(!('target' in one(a, 'symoff')), 'no symbols, so nothing to point at')
  const segmentCommands = named(a, 'LC_SEGMENT_64')
  assert.deepEqual(segmentCommands.map(f => f.target), [undefined, 0, 0x4000, 0x5000])
})

test('Mach-O: offsets inside a fat file count from the slice', () => {
  const thin = buildSegmentedMachO()
  const fat = new Uint8Array(buildFatMachO([{ cputype: CPU_TYPE_ARM64, image: thin.buffer }]))
  const a = analyse(fat)
  assertTargetsSane(a, fat.length)
  const arch = named(a, '[0] arm64')[0]
  assert.equal(arch.target, 0x1000)
  assert.equal(arch.children.find(c => c.name === 'offset').target, 0x1000)
  assert.equal(one(a, 'entryoff').target, 0x1000 + 0x3F00)
  assert.equal(one(a, '__TEXT,__text').target, 0x1000 + 0x3F00)
})

test('ZIP: the end record and every central entry point at what they name', () => {
  // A prefix that still starts like a ZIP, so the file is recognised
  const prefix = new Uint8Array(100).fill(0x90)
  prefix.set([0x50, 0x4B, 0x03, 0x04])
  const bytes = buildFullZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.txt', data: 'world!' }], { prefix })
  const a = analyse(bytes)
  assertTargetsSane(a, bytes.length)
  const end = one(a, 'End of central directory')
  const directory = end.children.find(c => c.name === 'Central directory offset')
  assert.equal(directory.target, one(a, 'Central directory').offset)
  assert.equal(ascii(bytes, directory.target, 4), 'PK\x01\x02')
  for (const name of ['a.txt', 'dir/b.txt']) {
    const entry = one(a, name, 'Central directory')
    const local = entry.children.find(c => c.name === 'Local header offset')
    assert.equal(entry.target, local.target)
    // The stored offsets ignore the prefix; the targets do not
    assert.equal(local.target, one(a, `Local file: ${name}`).offset)
    assert.equal(ascii(bytes, local.target, 4), 'PK\x03\x04')
  }
  assert.equal(one(a, 'Local header offset', 'a.txt').target, 100)
})

test('ZIP64: the locator and the ZIP64 record point at what they name', () => {
  const bytes = buildFullZip([{ name: 'a.txt', data: 'hello' }], { zip64: true })
  const a = analyse(bytes)
  const locator = one(a, 'ZIP64 end of central directory locator')
  assert.equal(locator.children.find(c => c.name === 'ZIP64 record offset').target, one(a, 'ZIP64 end of central directory').offset)
  const record = one(a, 'ZIP64 end of central directory')
  assert.equal(record.children.find(c => c.name === 'Central directory offset').target, one(a, 'Central directory').offset)
})

test('other formats: offset fields point at what they name', () => {
  const cases = [
    ['TIFF', buildTIFF({ exif: true }), a => one(a, 'First IFD offset'), (bytes, at, a) => at === one(a, 'IFD0').offset],
    ['TIFF Exif', buildTIFF({ exif: true }), a => one(a, 'ExifIFD'), (bytes, at, a) => at === named(a, 'EXIF IFD (from IFD0)')[0].offset],
    ['ICO', buildICO(), a => named(a, 'Image offset')[0], (bytes, at) => at === 6 + 2 * 16],
    ['BMP', buildBMP(), a => one(a, 'Pixel data offset'), (bytes, at) => at === 54],
    ['bplist', buildBplist(), a => one(a, 'Offset table offset'), (bytes, at, a) => at === one(a, 'Offset table').offset],
    ['ISO 9660', buildISO(), a => named(a, 'Root directory record')[0], (bytes, at) => at % 2048 === 0],
    ['7z', build7z(), a => one(a, 'Next header offset'), (bytes, at) => at >= 32 && at < bytes.length],
    ['font', buildTTF(), a => named(a, 'head')[0], (bytes, at) => at > 12],
    ['PDF', buildFullPDF(), a => one(a, 'Offset', 'startxref'), (bytes, at) => ascii(bytes, at, 4) === 'xref']
  ]
  for (const [label, built, pick, check] of cases) {
    const bytes = built instanceof Uint8Array ? built : new Uint8Array(built)
    const a = analyse(bytes)
    assertTargetsSane(a, bytes.length)
    const f = pick(a)
    assert.ok(f && Number.isSafeInteger(f.target), `${label}: ${f && f.name} has a target`)
    assert.ok(check(bytes, f.target, a), `${label}: ${f.name} -> ${f.target}`)
  }
})
