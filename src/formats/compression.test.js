import { test } from 'node:test'
import assert from 'node:assert/strict'
import { walkDeflate } from './deflate.js'
import gzip from './gzip.js'
import xz from './xz.js'
import bzip2 from './bzip2.js'
import zstd from './zstd.js'
import sevenZip from './sevenZip.js'
import rar from './rar.js'
import * as F from './__fixtures__/moreFormats.js'

const facts = (format, bytes) => Object.fromEntries(format.parse(bytes, {}).summary.map(entry => [entry.label, entry.value]))

test('deflate walker finds the end and size of fixed, dynamic and stored streams', () => {
  assert.deepEqual(walkDeflate(F.DEFLATE_FIXED, 0), { status: 'ok', end: 10, size: 23, blocks: 1 })
  assert.deepEqual(walkDeflate(F.DEFLATE_DYNAMIC, 0), { status: 'ok', end: F.DEFLATE_DYNAMIC.length, size: 150, blocks: 1 })
  const stored = F.deflateStored(F.noise(70000), 30000)
  assert.deepEqual(walkDeflate(stored, 0), { status: 'ok', end: stored.length, size: 70000, blocks: 3 })
  assert.equal(walkDeflate(F.DEFLATE_DYNAMIC.subarray(0, 60), 0).status, 'truncated')
  assert.equal(walkDeflate(Uint8Array.of(0x07), 0).status, 'error')
  assert.equal(walkDeflate(stored, 0, 1000).status, 'limit')
})

test('gzip: header fields, trailer and verified size', () => {
  const bytes = F.gzipMember({ name: 'hello.txt', comment: 'note', headerCrc: true, crc: 0xAABBCCDD })
  const f = facts(gzip, bytes)
  assert.equal(f['Original Name'], 'hello.txt')
  assert.equal(f.Comment, 'note')
  assert.equal(f.Modified, '2023-11-14 22:13:20 UTC')
  assert.equal(f['Operating System'], 'Unix')
  assert.equal(f['Header CRC'], 'Present, valid')
  assert.equal(f['Uncompressed Size'], '23 Bytes (23 bytes)')
  assert.equal(f['CRC-32'], '0xAABBCCDD')
  assert.deepEqual(gzip.parse(bytes, {}).warnings, [])
})

test('gzip: finds every member, flags size mismatches and trailing data', () => {
  const two = F.bytesOf(F.gzipMember(), F.gzipMember({ deflate: F.DEFLATE_DYNAMIC, size: 999 }), F.zeros(5), 0x41)
  const result = gzip.parse(two, {})
  const f = Object.fromEntries(result.summary.map(entry => [entry.label, entry.value]))
  assert.equal(f.Members, '2')
  assert.deepEqual(result.fields.map(field => field.name), ['Member 1', 'Member 2'])
  assert.ok(result.warnings.includes('Trailer says 999 bytes uncompressed but the data expands to 150'))
  assert.ok(result.warnings.includes('6 bytes of trailing data after the last gzip member'))
  assert.equal(facts(gzip, F.gzipMember({ extra: F.bytesOf('BC', F.u16le(2), F.u16le(99)) }))['Extra Field'], 'BGZF (blocked gzip)')
})

test('xz: index gives sizes and block count; CRCs are checked', () => {
  const data = F.noise(70000, 3)
  const bytes = F.buildXz(data)
  const f = facts(xz, bytes)
  assert.equal(f['Uncompressed Size'], '68.36 KB (70,000 bytes)')
  assert.equal(f['Integrity Check'], 'CRC32')
  assert.equal(f.Filters, 'LZMA2 (dictionary 8 MB)')
  assert.equal(f.Blocks, '1')
  assert.deepEqual(xz.parse(bytes, {}).warnings, [])
  const broken = bytes.slice()
  broken[bytes.length - 8] ^= 1
  assert.ok(xz.parse(broken, {}).warnings.length > 0)
  assert.ok(xz.parse(bytes.subarray(0, 100), {}).warnings[0].includes('No valid stream footer'))
  assert.equal(facts(xz, F.bytesOf(bytes, F.buildXz(), F.zeros(8))).Streams, '2')
})

test('bzip2: finds blocks at any bit offset and the combined CRC', () => {
  const bytes = F.buildBzip2({ blocks: 3, level: 5, combinedCrc: 0x01020304 })
  const result = bzip2.parse(bytes, {})
  const f = Object.fromEntries(result.summary.map(entry => [entry.label, entry.value]))
  assert.equal(f.Blocks, '3')
  assert.equal(f['Block Size'], '500 kB (level 5)')
  assert.equal(f['Combined CRC'], '0x01020304')
  assert.deepEqual(result.fields.map(field => field.name), ['Stream header', 'Block 1', 'Block 2', 'Block 3', 'End of stream'])
  assert.match(result.fields[2].description, /bit 5 of the byte/)
  assert.ok(bzip2.parse(bytes.subarray(0, 30), {}).warnings.includes('No end-of-stream marker found (truncated?)'))
})

test('zstd: walks frames and blocks', () => {
  const f = facts(zstd, F.buildZstd(F.noise(2500), { checksum: true, contentSize: true }))
  assert.equal(f.Frames, '1')
  assert.equal(f['Content Size'], '2.44 KB (2,500 bytes)')
  assert.equal(f.Blocks, '3')
  assert.equal(f['Content Checksum'], 'Yes (XXH64)')
  assert.equal(facts(zstd, F.buildZstd(undefined, { skippable: true })).Frames, '1 (+1 skippable)')
  const two = F.bytesOf(F.buildZstd(), F.buildZstd(F.ascii('second')))
  assert.equal(facts(zstd, two)['Content Size'], '25 Bytes (25 bytes)')
})

test('7z: signature header, CRCs and a plain header file list', () => {
  const result = sevenZip.parse(F.build7z({ names: ['a.txt', 'dir', 'b.bin'] }), {})
  const f = Object.fromEntries(result.summary.map(entry => [entry.label, entry]))
  assert.equal(f['Format Version'].value, '0.4')
  assert.equal(f.Header.value, 'Plain (not compressed)')
  assert.equal(f.Entries.value, '3')
  assert.deepEqual(f.Entries.details, ['a.txt', 'dir', 'b.bin'])
  assert.equal(f.Directories.value, '1')
  assert.deepEqual(result.warnings, [])
  assert.equal(facts(sevenZip, F.build7z({ encodedHeader: true })).Header, 'Compressed (LZMA2)')
  const corrupt = F.build7z()
  corrupt[12] ^= 0xFF
  assert.ok(sevenZip.parse(corrupt, {}).warnings.includes('Start header CRC does not match'))
})

test('RAR: lists entries from RAR 5 and RAR 4 headers', () => {
  const five = rar.parse(F.buildRar5([{ name: 'a.txt', data: F.ascii('12345') }, { name: 'secret.bin', data: F.ascii('xx'), encrypted: true }, { name: 'd', dir: true }], { solid: true }), {})
  assert.deepEqual(five.entries, [
    { path: 'a.txt', isDirectory: false, size: 5, compressedSize: 5, method: 'normal', encrypted: false },
    { path: 'secret.bin', isDirectory: false, size: 2, compressedSize: 2, method: 'normal', encrypted: true },
    { path: 'd', isDirectory: true, size: 0, compressedSize: 0, method: 'stored', encrypted: false }
  ])
  const f5 = Object.fromEntries(five.summary.map(entry => [entry.label, entry.value]))
  assert.equal(f5['RAR Version'], '5.0')
  assert.equal(f5.Solid, 'Yes')
  assert.equal(f5['Encrypted Files'], '1')
  assert.deepEqual(five.warnings, [])

  const four = rar.parse(F.buildRar4(), {})
  assert.deepEqual(four.entries.map(e => [e.path, e.isDirectory, e.size, e.method]), [['readme.txt', false, 8, 'stored'], ['sub', true, 0, 'stored']])
  assert.deepEqual(four.warnings, [])
  assert.ok(rar.parse(F.buildRar5(undefined, { end: false }), {}).warnings.includes('No end-of-archive block (truncated, or more volumes follow)'))
})
