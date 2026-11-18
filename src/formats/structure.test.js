import { test } from 'node:test'
import assert from 'node:assert/strict'
import png from './png.js'
import jpeg from './jpeg.js'
import gif from './gif.js'
import zip, { identifyContainer } from './zip.js'
import pdf from './pdf.js'
import javaClass from './javaClass.js'
import { FieldList } from './fieldTree.js'
import { crc32 } from '../lib/crc32.js'
import { analyzeBytes } from '../analysis/analyze.js'
import {
  buildFullPNG, buildFullJPEG, buildFullGIF, buildFullZip, buildFullPDF, buildFullClass,
  concat, pngChunk, PNG_SIGNATURE
} from './__fixtures__/structure.js'

/**
 * Every field lies inside the file, children inside their parent, siblings
 * in file order without overlapping. Returns the number of fields.
 */
function checkTree(fields, size, parent = null, path = '') {
  let count = 0
  let previousEnd = parent ? parent.offset : 0
  for (const f of fields) {
    const where = `${path}/${f.name}`
    assert.ok(Number.isInteger(f.offset) && Number.isInteger(f.length), `${where}: integer range`)
    assert.ok(f.length > 0, `${where}: positive length (${f.length})`)
    assert.ok(f.offset >= 0 && f.offset + f.length <= size, `${where}: inside the file (${f.offset}+${f.length} > ${size})`)
    if (parent) {
      assert.ok(f.offset >= parent.offset && f.offset + f.length <= parent.offset + parent.length, `${where}: inside its parent`)
    }
    assert.ok(f.offset >= previousEnd, `${where}: does not overlap its previous sibling (${f.offset} < ${previousEnd})`)
    previousEnd = f.offset + f.length
    assert.equal(typeof f.name, 'string')
    if (f.value !== undefined) assert.equal(typeof f.value, 'string', `${where}: value is a string`)
    count++
    if (f.children) count += checkTree(f.children, size, f, where)
  }
  return count
}

function checkRegions(regions, size) {
  let previous = -1
  for (const region of regions) {
    assert.ok(region.length > 0 && region.offset >= 0 && region.offset + region.length <= size, `region ${region.name} inside the file`)
    assert.ok(region.offset >= previous, 'regions sorted')
    previous = region.offset
  }
}

function find(fields, name) {
  for (const f of fields) {
    if (f.name === name) return f
    const inner = f.children && find(f.children, name)
    if (inner) return inner
  }
  return null
}

function findAll(fields, test, out = []) {
  for (const f of fields) {
    if (test(f)) out.push(f)
    if (f.children) findAll(f.children, test, out)
  }
  return out
}

const parse = (format, bytes, meta = {}) => format.parse(bytes, meta)

function checkPrefixes(format, file, meta) {
  for (let length = 0; length <= file.length; length++) {
    const bytes = file.subarray(0, length)
    let result
    assert.doesNotThrow(() => { result = parse(format, bytes, meta) }, `length ${length}`)
    checkTree(result.fields || [], length, null, `[${length}]`)
    checkRegions(result.regions || [], length)
  }
}

test('CRC-32 matches the standard check value', () => {
  const data = new TextEncoder().encode('123456789')
  assert.equal(crc32(data, 0, data.length), 0xCBF43926)
  // The CRC of every empty IEND chunk
  const iend = new TextEncoder().encode('IEND')
  assert.equal(crc32(iend, 0, 4), 0xAE426082)
})

test('FieldList caps children and covers the rest with one placeholder', () => {
  const list = new FieldList(3, 'things')
  for (let i = 0; i < 10; i++) list.push({ name: `f${i}`, offset: i * 4, length: 4 })
  const out = list.toArray()
  assert.equal(out.length, 4)
  assert.equal(list.count, 10)
  assert.deepEqual([out[3].offset, out[3].length], [12, 28])
  assert.match(out[3].name, /7 more not shown/)
})

test('PNG: signature bytes, chunks, decoded IHDR and text, CRCs verified', () => {
  const file = buildFullPNG()
  const result = parse(png, file)
  checkTree(result.fields, file.length)
  checkRegions(result.regions, file.length)
  assert.deepEqual(result.warnings, [])

  const signature = result.fields[0]
  assert.deepEqual(signature.children.map(f => [f.offset, f.length, f.value]), [
    [0, 1, '0x89'], [1, 3, 'PNG'], [4, 2, 'CR LF'], [6, 1, '0x1A'], [7, 1, 'LF']
  ])
  assert.ok(signature.children.every(f => f.description && f.kind === 'magic'))

  assert.deepEqual(result.fields.slice(1).map(f => f.name), [
    'IHDR chunk', 'tEXt chunk', 'iTXt chunk', 'zTXt chunk', 'pHYs chunk', 'tIME chunk', 'IDAT chunk', 'IEND chunk'
  ])
  const ihdr = result.fields[1]
  assert.deepEqual(ihdr.children.map(f => f.name), ['Length', 'Chunk type', 'Data', 'CRC'])
  assert.equal(ihdr.children[1].value, 'IHDR (critical, public, unsafe to copy)')
  assert.deepEqual(ihdr.children[2].children.map(f => `${f.name}=${f.value}`), [
    'Width=2 px', 'Height=2 px', 'Bit depth=8', 'Colour type=2 (Truecolor (RGB))',
    'Compression method=0 (deflate)', 'Filter method=0 (adaptive)', 'Interlace method=0 (None)'
  ])
  const crcs = findAll(result.fields, f => f.name === 'CRC')
  assert.equal(crcs.length, 8)
  assert.ok(crcs.every(f => f.value.endsWith('(valid)') && f.kind === 'checksum'))
  assert.equal(find(result.fields, 'IEND chunk').children[2].value, '0xAE426082 (valid)')

  assert.equal(result.fields[2].value, 'Title: Hex dance')
  assert.equal(result.fields[3].value, 'Comment: ünïcode')
  assert.equal(result.fields[5].value, '2835 × 2835 px per metre (72 dpi)')
  assert.equal(result.fields[6].value, '2024-02-29 12:30:45 UTC')
  assert.equal(result.fields[3].children[1].value, 'iTXt (ancillary, public, safe to copy)')
})

test('PNG: marks invalid CRCs and trailing data', () => {
  const file = buildFullPNG({ badCrc: true, trailing: 'appended' })
  const result = parse(png, file)
  checkTree(result.fields, file.length)
  const iend = find(result.fields, 'IEND chunk')
  assert.match(iend.children[2].value, /^0xAE426083 \(invalid, computed 0xAE426082\)$/)
  assert.equal(iend.value, 'CRC mismatch')
  const trailing = result.fields.at(-1)
  assert.deepEqual([trailing.name, trailing.length], ['Trailing data', 8])
  assert.deepEqual(result.warnings, ['1 chunk has a CRC mismatch (IEND)', '8 bytes of data after the IEND chunk'])
})

test('PNG: every truncated prefix gives a valid tree', () => {
  checkPrefixes(png, buildFullPNG({ trailing: 'xy' }))
})

test('PNG: thousands of chunks are capped and stay linear', () => {
  const file = buildFullPNG({ idatChunks: 30000 })
  const start = performance.now()
  const result = parse(png, file)
  assert.ok(performance.now() - start < 2000)
  const count = checkTree(result.fields, file.length)
  assert.ok(count < 15000, `${count} fields`)
  assert.match(result.fields.at(-1).name, /more not shown/)
  assert.ok(JSON.stringify(result).length < 5e6)
  assert.deepEqual(result.warnings, [])
})

test('JPEG: segments as marker, length and payload with decoded headers', () => {
  const file = buildFullJPEG({ trailing: 'extra' })
  const result = parse(jpeg, file)
  checkTree(result.fields, file.length)
  checkRegions(result.regions, file.length)
  assert.deepEqual(result.fields.map(f => f.name), [
    'SOI', 'APP0 JFIF', 'APP1 Exif', 'COM', 'DQT', 'DHT', 'SOF0', 'DRI', 'SOS', 'Entropy-coded data', 'EOI', 'Trailing data'
  ])
  assert.equal(result.fields[0].kind, 'magic')
  const app0 = result.fields[1]
  assert.deepEqual(app0.children.map(f => f.name), ['Marker', 'Length', 'Payload'])
  assert.deepEqual(app0.children[2].children.map(f => `${f.name}=${f.value}`), [
    'Identifier=JFIF.', 'Version=1.02', 'Density units=dots per inch', 'X density=72', 'Y density=72',
    'Thumbnail width=0', 'Thumbnail height=0'
  ])
  const exif = result.fields[2].children[2]
  assert.equal(find(exif.children, 'TIFF byte order').value, 'MM (big-endian)')
  assert.equal(find(exif.children, 'TIFF magic').value, '42')
  assert.equal(result.fields[3].value, 'made by hand')
  assert.equal(result.fields[4].value, '2 tables')
  assert.deepEqual(result.fields[4].children[2].children.map(f => f.value), ['8-bit values', '16-bit values'])
  assert.equal(result.fields[5].value, '1 table')
  const sof = result.fields[6]
  assert.equal(sof.children[0].name, 'Fill bytes')
  assert.equal(sof.value, '32 × 16, Baseline DCT')
  assert.equal(result.fields[7].value, 'every 4 MCUs')
  // The scan keeps the stuffed FF 00 and the RST markers inside it
  assert.equal(result.fields[9].length, 10)
  assert.equal(result.fields[11].length, 5)
  assert.ok(result.warnings.includes('5 bytes of trailing data after the end-of-image marker'))
})

test('JPEG: progressive files have several scans', () => {
  const result = parse(jpeg, buildFullJPEG({ progressive: true }))
  assert.equal(result.fields.filter(f => f.name === 'Entropy-coded data').length, 2)
  assert.ok(result.summary.some(entry => entry.label === 'Scans' && entry.value === '2'))
  assert.deepEqual(result.warnings, [])
})

test('JPEG: every truncated prefix gives a valid tree', () => {
  checkPrefixes(jpeg, buildFullJPEG({ trailing: 'xy', progressive: true }))
})

test('JPEG: huge scan data and many segments stay linear and capped', () => {
  const scan = new Uint8Array(20 * 1024 * 1024).fill(0xFF)
  for (let i = 1; i < scan.length; i += 2) scan[i] = 0
  const file = concat([buildFullJPEG().subarray(0, -2), scan, [0xFF, 0xD9]])
  let start = performance.now()
  let result = parse(jpeg, file)
  assert.ok(performance.now() - start < 3000)
  checkTree(result.fields, file.length)

  const comments = []
  for (let i = 0; i < 20000; i++) comments.push([0xFF, 0xFE, 0, 3, 0x41])
  const many = concat([[0xFF, 0xD8], ...comments, [0xFF, 0xD9]])
  start = performance.now()
  result = parse(jpeg, many)
  assert.ok(performance.now() - start < 2000)
  assert.ok(checkTree(result.fields, many.length) < 12000)
})

test('GIF: header, screen descriptor, colour tables, extensions, frames, trailer', () => {
  const file = buildFullGIF({ trailing: 'zz' })
  const result = parse(gif, file)
  checkTree(result.fields, file.length)
  checkRegions(result.regions, file.length)
  assert.deepEqual(result.fields.map(f => f.name), [
    'Header', 'Logical screen descriptor', 'Global colour table', 'Application extension', 'Comment extension',
    'Graphic control extension', 'Frame 1', 'Graphic control extension', 'Frame 2', 'Trailer', 'Trailing data'
  ])
  const lsd = result.fields[1]
  assert.equal(find(lsd.children, 'Packed fields').value, 'global colour table, 4 colours, 8-bit colour resolution')
  assert.equal(result.fields[2].length, 12)
  assert.equal(result.fields[3].value, 'loops forever')
  assert.equal(result.fields[5].value, 'delay 0.1 s')
  assert.equal(find(result.fields[5].children, 'Packed fields').value, 'disposal: restore to background, transparent colour')
  assert.deepEqual(result.fields[8].children.map(f => f.name), ['Image descriptor', 'Local colour table', 'LZW minimum code size', 'Image data'])
  assert.equal(find(result.fields[6].children, 'Image data').value, '2 sub-blocks, 303 bytes')
  const lines = result.summary.map(entry => `${entry.label}: ${entry.value}`)
  assert.ok(lines.includes('Frames: 2'))
  assert.ok(lines.includes('Animation: loops forever'))
  assert.deepEqual(result.warnings, ['2 bytes of data after the GIF trailer'])
})

test('GIF: every truncated prefix gives a valid tree', () => {
  checkPrefixes(gif, buildFullGIF({ trailing: 'x' }))
})

test('GIF: many frames are capped and linear', () => {
  const file = buildFullGIF({ frames: 20000, localTable: false })
  const start = performance.now()
  const result = parse(gif, file)
  assert.ok(performance.now() - start < 3000)
  assert.ok(checkTree(result.fields, file.length) < 20000)
  assert.ok(result.summary.some(entry => entry.label === 'Frames' && entry.value === '20000'))
})

test('ZIP: local headers, central directory and end record field by field', () => {
  const file = buildFullZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/' }, { name: 'dir/b.bin', data: [1, 2, 3] }], { comment: 'hi' })
  const result = parse(zip, file)
  checkTree(result.fields, file.length)
  checkRegions(result.regions, file.length)
  assert.deepEqual(result.fields.map(f => f.name), [
    'Local file: a.txt', 'Local file: dir/', 'Local file: dir/b.bin', 'Central directory', 'End of central directory'
  ])
  const header = result.fields[0].children[0]
  assert.deepEqual(header.children.map(f => f.name), [
    'Signature', 'Version needed', 'General purpose flags', 'Compression method', 'Last modified time',
    'Last modified date', 'CRC-32', 'Compressed size', 'Uncompressed size', 'File name length',
    'Extra field length', 'File name'
  ])
  assert.equal(find(header.children, 'Last modified date').value, '2024-01-01')
  assert.equal(find(header.children, 'Last modified time').value, '12:00:00')
  assert.equal(find(header.children, 'CRC-32').value, '0x3610A686')
  assert.equal(result.fields[0].children[1].value, '5 bytes, stored')
  const entry = result.fields[3].children[0]
  assert.equal(entry.name, 'a.txt')
  assert.equal(find(entry.children, 'Version made by').value, '3.0, Unix')
  assert.equal(find(entry.children, 'External attributes').value, '0x81A40000 (Unix mode 0100644)')
  const end = result.fields[4]
  assert.equal(find(end.children, 'Archive comment').value, 'hi')
  assert.equal(end.value, '3 entries')
  assert.equal(result.fields[0].kind, 'magic')
  assert.deepEqual(result.warnings, [])
})

test('ZIP: data descriptors, ZIP64 records, prefix and trailing data', () => {
  const prefix = new TextEncoder().encode('#!/bin/sh\nexit 0\n')
  const file = buildFullZip([{ name: 'x', data: 'abc' }], { prefix, dataDescriptor: true, zip64: true, trailing: 'junk' })
  const result = parse(zip, file)
  checkTree(result.fields, file.length)
  checkRegions(result.regions, file.length)
  assert.deepEqual(result.fields.map(f => f.name), [
    'Data before the archive', 'Local file: x', 'Central directory', 'ZIP64 end of central directory',
    'ZIP64 end of central directory locator', 'End of central directory', 'Data after the end record'
  ])
  assert.equal(result.fields[0].length, prefix.length)
  const descriptor = find(result.fields[1].children, 'Data descriptor')
  assert.deepEqual(descriptor.children.map(f => f.name), ['Signature', 'CRC-32', 'Compressed size', 'Uncompressed size'])
  assert.equal(descriptor.length, 16)
  assert.equal(find(result.fields[3].children, 'Total entries').value, '1')
  assert.ok(result.warnings.some(w => w.includes('before the first local header')))
  assert.ok(result.warnings.some(w => w.includes('after the end of central directory')))
})

test('ZIP: every truncated prefix gives a valid tree', () => {
  checkPrefixes(zip, buildFullZip([{ name: 'a.txt', data: 'hello' }, { name: 'b', data: 'xyz' }], { comment: 'c', dataDescriptor: true }))
  checkPrefixes(zip, buildFullZip([{ name: 'a.txt', data: 'hello' }], { zip64: true }))
})

test('ZIP: overlapping entries are reported, not drawn over each other', () => {
  const file = buildFullZip([{ name: 'a', data: 'hello' }, { name: 'b', data: 'world' }])
  // Point the second central entry at the first local header
  const view = new DataView(file.buffer)
  const cdOffset = view.getUint32(file.length - 6, true)
  const second = cdOffset + 46 + 1
  view.setUint32(second + 42, 0, true)
  const result = parse(zip, file)
  checkTree(result.fields, file.length)
  assert.ok(result.warnings.some(w => w.includes('overlaps')))
})

test('ZIP: large archives are capped and linear', () => {
  const entries = []
  for (let i = 0; i < 20000; i++) entries.push({ name: `f${i}`, data: 'x' })
  const file = buildFullZip(entries)
  const start = performance.now()
  const result = parse(zip, file)
  assert.ok(performance.now() - start < 3000)
  const count = checkTree(result.fields, file.length)
  assert.ok(count < 60000, `${count} fields`)
  assert.equal(result.entries.length, 20000)
  assert.match(result.fields[1000].name, /19,000 more not shown/)
  assert.ok(JSON.stringify(result).length < 15e6)
})

test('ZIP: recognises containers from their entries', () => {
  const name = (...names) => identifyContainer(names.map(n => ({ name: n })))?.[0] ?? null
  assert.equal(name('[Content_Types].xml', 'word/document.xml'), 'Word document (DOCX)')
  assert.equal(name('[Content_Types].xml', 'xl/workbook.xml'), 'Excel workbook (XLSX)')
  assert.equal(name('[Content_Types].xml', 'ppt/presentation.xml'), 'PowerPoint presentation (PPTX)')
  assert.equal(name('META-INF/MANIFEST.MF', 'a/B.class'), 'Java archive (JAR)')
  assert.equal(name('META-INF/MANIFEST.MF', 'WEB-INF/web.xml'), 'Web application archive (WAR)')
  assert.equal(name('AndroidManifest.xml', 'classes.dex', 'META-INF/MANIFEST.MF'), 'Android package (APK)')
  assert.equal(name('Payload/', 'Payload/App.app/Info.plist'), 'iOS app archive (IPA)')
  assert.equal(name('pkg/__init__.py', 'pkg-1.0.dist-info/WHEEL'), 'Python wheel')
  assert.equal(name('[Content_Types].xml', 'Pkg.nuspec', 'lib/net8.0/Pkg.dll'), 'NuGet package')
  assert.equal(name('manifest.json', 'META-INF/mozilla.rsa'), 'Firefox add-on (XPI)')
  assert.equal(identifyContainer([{ name: 'manifest.json' }], { fileName: 'ext.xpi' })[0], 'Firefox add-on (XPI)')
  assert.equal(name('manifest.json'), null)
  assert.equal(name('readme.txt'), null)

  const epub = buildFullZip([{ name: 'mimetype', data: 'application/epub+zip' }, { name: 'OEBPS/content.opf', data: '<x/>' }])
  const result = analyzeBytes(epub, { fileName: 'book.epub' })
  assert.equal(result.formatName, 'EPUB e-book')
  assert.match(result.summary[0].value, /^An EPUB e-book/)
  const odt = buildFullZip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' }])
  assert.equal(analyzeBytes(odt).formatName, 'OpenDocument text (ODT)')
  assert.equal(analyzeBytes(buildFullZip([{ name: 'a.txt', data: 'a' }])).formatName, 'ZIP Archive')
})

test('ZIP: reads Chrome extensions (a CRX header before the archive)', () => {
  const inner = buildFullZip([{ name: 'manifest.json', data: '{}' }])
  const header = new Uint8Array(12 + 5)
  header.set(new TextEncoder().encode('Cr24'))
  new DataView(header.buffer).setUint32(4, 3, true)
  new DataView(header.buffer).setUint32(8, 5, true)
  const file = concat([header, inner])
  const result = analyzeBytes(file)
  assert.equal(result.formatId, 'zip')
  assert.equal(result.formatName, 'Chrome extension (CRX)')
  checkTree(result.fields, file.length)
  assert.deepEqual(result.fields.map(f => f.name), ['CRX header', 'Local file: manifest.json', 'Central directory', 'End of central directory'])
  assert.equal(result.fields[1].offset, 17)
  assert.equal(result.entries[0].path, 'manifest.json')
  checkPrefixes(zip, file)
})

test('PDF: header, objects with streams, xref with verified offsets, trailer, startxref', () => {
  const file = buildFullPDF()
  const result = parse(pdf, file)
  checkTree(result.fields, file.length)
  checkRegions(result.regions, file.length)
  assert.deepEqual(result.fields.map(f => f.name), [
    'Header', 'Binary marker', 'Object 1 0', 'Object 2 0', 'Object 3 0', 'Object 4 0', 'Object 5 0',
    'Cross-reference table', 'Trailer', 'startxref', 'End-of-file marker'
  ])
  assert.equal(result.fields[2].value, '/Catalog')
  const stream = result.fields[5]
  assert.deepEqual(stream.children.map(f => f.name), ['Object header', 'Dictionary', 'stream keyword', 'Stream data', 'endstream keyword', 'endobj keyword'])
  // The stream contains the word "endobj"; its /Length keeps the object whole
  assert.equal(find(stream.children, 'Stream data').length, 21)
  assert.equal(result.fields[6].children[1].value, '(A string object)')
  const xref = result.fields[7]
  const entries = xref.children[1].children
  assert.equal(entries.length, 7)
  assert.ok(entries.slice(2).every(entry => entry.value.endsWith('(verified)')))
  assert.equal(entries[1].value, 'free, generation 65535')
  assert.equal(result.fields[8].value, 'root 1 0 R, size 6')
  assert.match(result.fields[9].children[1].value, /points to a cross-reference table$/)
})

test('PDF: every truncated prefix gives a valid tree', () => {
  checkPrefixes(pdf, buildFullPDF())
})

test('PDF: large files map the scanned windows and mark the gap', () => {
  const head = buildFullPDF()
  const filler = new Uint8Array(3 * 1024 * 1024).fill(0x20)
  const file = concat([head, filler, buildFullPDF().subarray(9)])
  const result = parse(pdf, file)
  checkTree(result.fields, file.length)
  checkRegions(result.regions, file.length)
  const gap = result.fields.find(f => f.name === 'Not scanned')
  assert.ok(gap && gap.length > 1024 * 1024)
  assert.equal(result.fields.filter(f => f.name === 'Cross-reference table').length, 2)
})

test('PDF: many objects stay capped', () => {
  const body = '%PDF-1.4\n' + '1 0 obj << /A 1 >> endobj\n'.repeat(40000)
  const file = new TextEncoder().encode(body)
  const start = performance.now()
  const result = parse(pdf, file)
  assert.ok(performance.now() - start < 3000)
  assert.ok(checkTree(result.fields, file.length) < 10000)
})

test('Java class: constant pool, members and attributes', () => {
  const file = buildFullClass()
  const result = parse(javaClass, file)
  checkTree(result.fields, file.length)
  checkRegions(result.regions, file.length)
  assert.deepEqual(result.fields.map(f => f.name), [
    'magic', 'minor_version', 'major_version', 'constant_pool_count', 'constant_pool', 'access_flags',
    'this_class', 'super_class', 'interfaces_count', 'fields_count', 'fields', 'methods_count', 'methods', 'attributes'
  ])
  const pool = result.fields[4]
  assert.equal(pool.children.length, 12)
  assert.equal(pool.children[0].value, '"Demo"')
  assert.equal(pool.children[11].name, '#12 Long')
  assert.equal(pool.children[11].value, '-2')
  assert.equal(result.fields[5].value, '0x21 (public super)')
  assert.equal(result.fields[6].value, '#2 Demo')
  assert.equal(result.fields[10].children[0].name, 'count')
  assert.equal(result.fields[12].children[0].value, '()V')
  const lines = result.summary.map(entry => `${entry.label}: ${entry.value}`)
  assert.ok(lines.includes('Class: Demo'))
  assert.ok(lines.includes('Superclass: java.lang.Object'))
  assert.ok(lines.includes('Members: 1 field, 1 method'))
  assert.ok(lines.includes('Source File: Demo.java'))
  assert.deepEqual(result.warnings, [])
})

test('Java class: every truncated prefix gives a valid tree', () => {
  const file = buildFullClass()
  for (let length = 8; length <= file.length; length++) {
    const result = parse(javaClass, file.subarray(0, length))
    checkTree(result.fields, length, null, `[${length}]`)
    if (length < file.length) assert.deepEqual(result.warnings, ['File is truncated'], `length ${length}`)
  }
})

test('Java class: a huge constant pool is capped', () => {
  const file = buildFullClass({ extraConstants: 60000 })
  const start = performance.now()
  const result = parse(javaClass, file)
  assert.ok(performance.now() - start < 2000)
  assert.ok(checkTree(result.fields, file.length) < 5000)
  assert.deepEqual(result.warnings, [])
})

// What the panels rely on in an Analysis, whatever the format: every array is
// there, every field has a string name and an integer range inside the file
// with a positive length, values are strings, regions lie inside the file in
// offset order. Empty regions, overlapping siblings or a child reaching past
// its parent are not part of it: the Anatomy bar falls back to the fields,
// and the field index and the anatomy segments cope with any order. Each
// parser's own tree rules are checked by its tests above with checkTree.
function checkContract(analysis, size) {
  for (const key of ['formatId', 'formatName', 'category']) assert.equal(typeof analysis[key], 'string', key)
  for (const key of ['summary', 'fields', 'regions', 'symbols', 'entries', 'warnings']) assert.ok(Array.isArray(analysis[key]), key)
  const visit = (fields) => {
    let count = 0
    for (const f of fields) {
      assert.equal(typeof f.name, 'string')
      assert.ok(Number.isInteger(f.offset) && Number.isInteger(f.length) && f.length > 0, `${f.name}: integer range`)
      assert.ok(f.offset >= 0 && f.offset + f.length <= size, `${f.name}: inside the file`)
      if (f.value !== undefined) assert.equal(typeof f.value, 'string', `${f.name}: value is a string`)
      count++
      if (f.children !== undefined) count += visit(f.children)
    }
    return count
  }
  const fieldCount = visit(analysis.fields)
  checkRegions(analysis.regions, size)
  return fieldCount
}

const countFields = (fields = []) => fields.reduce((n, f) => n + 1 + countFields(f.children), 0)

test('analysis results of every format pass through analyzeBytes unchanged in shape', () => {
  const cases = [
    [png, buildFullPNG()], [jpeg, buildFullJPEG()], [gif, buildFullGIF()],
    [zip, buildFullZip([{ name: 'a', data: 'b' }])], [pdf, buildFullPDF()], [javaClass, buildFullClass()]
  ]
  for (const [format, file] of cases) {
    const analysis = analyzeBytes(file)
    assert.equal(analysis.formatId, format.id)
    const kept = checkContract(analysis, file.length)
    // Well-formed output is passed on whole: analyzeBytes only drops what it must
    const parsed = parse(format, file)
    assert.equal(kept, countFields(parsed.fields), `${format.id}: no field dropped`)
    assert.equal(analysis.regions.length, (parsed.regions || []).length, `${format.id}: no region dropped`)
  }
  // A lone PNG chunk after the signature still forms a tree
  const odd = concat([PNG_SIGNATURE, pngChunk('IHDR', new Uint8Array(13))])
  checkTree(analyzeBytes(odd).fields, odd.length)
})
