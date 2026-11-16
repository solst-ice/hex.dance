import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseZIP, decodeEntryName, buildTree, renderTree } from './zip.js'
import { buildZip, zip64Extra, truncate } from './__fixtures__/fileFormats.js'

function tree(result) {
  return [...result.contents][0]
}

function meta(result) {
  return [...result.metadata]
}

const PACKAGE_ENTRIES = [
  { name: 'pkg_a/__init__.py', data: '' },
  { name: 'pkg_a/util.py', data: 'x'.repeat(200) },
  { name: 'pkg_b/__init__.py', data: '' },
  { name: 'pkg_b/util.py', data: 'x'.repeat(200) },
  { name: 'README.md', data: 'hello' },
  { name: 'docs/ünïcödé.txt', data: 'hello', utf8: true }
]

const PACKAGE_TREE = [
  '.',
  '├── docs/',
  '│   └── ünïcödé.txt (5 Bytes)',
  '├── pkg_a/',
  '│   ├── __init__.py (0 Bytes)',
  '│   └── util.py (200 Bytes)',
  '├── pkg_b/',
  '│   ├── __init__.py (0 Bytes)',
  '│   └── util.py (200 Bytes)',
  '└── README.md (5 Bytes)'
].join('\n')

test('lists every entry once, keeping duplicate basenames in different directories', () => {
  const result = parseZIP(buildZip(PACKAGE_ENTRIES))
  assert.equal(tree(result), PACKAGE_TREE)
  assert.ok(meta(result).includes('Total Files: 6'))
  assert.ok(meta(result).includes('Directories: 3'))
  assert.ok(meta(result).includes('Uncompressed Size: 410 Bytes'))
})

test('reads sizes from the central directory when data descriptors are used', () => {
  const result = parseZIP(buildZip([
    { name: 'a/one.txt', data: 'a'.repeat(4000) },
    { name: 'a/two.bin', data: 'b'.repeat(2000) },
    { name: 'b/three.txt', data: 'c'.repeat(600) }
  ], { dataDescriptor: true }))
  assert.equal(tree(result), [
    '.',
    '├── a/',
    '│   ├── one.txt (3.91 KB)',
    '│   └── two.bin (1.95 KB)',
    '└── b/',
    '    └── three.txt (600 Bytes)'
  ].join('\n'))
  assert.ok(meta(result).includes('Total Files: 3'))
})

test('shows explicit directory entries once with a trailing slash', () => {
  const result = parseZIP(buildZip([
    { name: 'src/' },
    { name: 'src/lib/' },
    { name: 'src/lib/a.js', data: 'a' },
    { name: 'empty/' }
  ]))
  assert.equal(tree(result), [
    '.',
    '├── empty/',
    '└── src/',
    '    └── lib/',
    '        └── a.js (1 Bytes)'
  ].join('\n'))
  assert.ok(meta(result).includes('Total Files: 1'))
  assert.ok(meta(result).includes('Directories: 3'))
})

test('reports compression method and encryption per file', () => {
  const result = parseZIP(buildZip([
    { name: 'packed.txt', data: 'abc', method: 8 },
    { name: 'secret.txt', data: 'abc', flags: 0x0001 }
  ]))
  assert.match(tree(result), /packed\.txt \(3 Bytes, deflated\)/)
  assert.match(tree(result), /secret\.txt \(3 Bytes, encrypted\)/)
  assert.ok(meta(result).includes('Encrypted Files: 1'))
  assert.ok(meta(result).includes('Compression: deflated, stored'))
})

test('decodes names: UTF-8 flag, unflagged UTF-8 and CP437 fallback', () => {
  const utf8 = new TextEncoder().encode('ünï.txt')
  assert.equal(decodeEntryName(utf8, 0x0800), 'ünï.txt')
  assert.equal(decodeEntryName(utf8, 0), 'ünï.txt')
  // "naïve" in CP437: ï is 0x8B
  assert.equal(decodeEntryName(Uint8Array.from([0x6E, 0x61, 0x8B, 0x76, 0x65]), 0), 'naïve')
  assert.equal(decodeEntryName(Uint8Array.from([0x80, 0xE1, 0xFF]), 0), 'Çß ')

  const result = parseZIP(buildZip([{ name: [0x63, 0x61, 0x66, 0x82, 0x2E, 0x74, 0x78, 0x74], data: 'x' }]))
  assert.match(tree(result), /café\.txt/)
})

test('replaces control characters so a name cannot add tree lines', () => {
  const result = parseZIP(buildZip([{ name: 'evil\nname.txt', data: 'x' }]))
  assert.equal(tree(result).split('\n').length, 2)
})

test('handles an archive with zero entries', () => {
  const result = parseZIP(buildZip([]))
  assert.equal(tree(result), '.')
  assert.ok(meta(result).includes('Total Files: 0'))
  assert.ok(!meta(result).some(item => item.startsWith('Warning')))
})

test('reads the archive comment and finds the EOCD behind it', () => {
  const result = parseZIP(buildZip([{ name: 'a.txt', data: 'a' }], { comment: 'PK\u0005\u0006 looks like a signature' }))
  assert.ok(meta(result).includes('Total Files: 1'))
  assert.ok(meta(result).some(item => item.startsWith('Comment: PK')))
})

test('recovers entries from local headers when the central directory is cut off', () => {
  const full = buildZip([
    { name: 'one.txt', data: 'a'.repeat(100) },
    { name: 'two.txt', data: 'b'.repeat(100) },
    { name: 'three.txt', data: 'c'.repeat(100) }
  ])
  const result = parseZIP(truncate(full, 300))
  assert.match(tree(result), /one\.txt \(100 Bytes\)/)
  assert.match(tree(result), /two\.txt \(100 Bytes\)/)
  assert.ok(meta(result).some(item => item.startsWith('Warning: End of central directory not found')))
})

test('stops at the first data-descriptor entry when recovering from local headers', () => {
  const full = buildZip([{ name: 'a.txt', data: 'abc' }, { name: 'b.txt', data: 'def' }], { dataDescriptor: true })
  const result = parseZIP(truncate(full, 60))
  assert.match(tree(result), /a\.txt \(size unknown\)/)
  assert.doesNotMatch(tree(result), /b\.txt/)
})

test('never throws on truncated or garbage input', () => {
  const full = buildZip(PACKAGE_ENTRIES, { comment: 'comment' })
  for (let length = 0; length <= full.byteLength; length++) {
    assert.doesNotThrow(() => parseZIP(truncate(full, length)), `length ${length}`)
  }
  const noise = new Uint8Array(4096)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24
  noise.set([0x50, 0x4B, 0x03, 0x04])
  assert.doesNotThrow(() => parseZIP(noise.buffer))
})

test('reads ZIP64 end of central directory and extra fields', () => {
  const result = parseZIP(buildZip([
    { name: 'big.bin', data: 'abcd', centralSize: 0xFFFFFFFF, extra: zip64Extra(5 * 1024 ** 3, 4 * 1024 ** 3) }
  ], { zip64: true }))
  assert.match(tree(result), /big\.bin \(5 GB\)/)
  assert.ok(meta(result).includes('ZIP64: Yes'))
  assert.ok(meta(result).includes('Total Files: 1'))
})

test('caps the rendered tree and reports the remainder', () => {
  const entries = []
  for (let i = 0; i < 30; i++) entries.push({ name: `dir/file${String(i).padStart(2, '0')}.txt`, size: 1, method: 0 })
  const lines = renderTree(buildTree(entries), 10).split('\n')
  assert.equal(lines.length, 12)
  assert.equal(lines[1], '└── dir/')
  assert.equal(lines.at(-1), '… and 21 more')
})

test('caps large archives while keeping the file count exact', () => {
  const entries = []
  for (let i = 0; i < 1500; i++) entries.push({ name: `f${i}.txt`, data: '' })
  const result = parseZIP(buildZip(entries))
  assert.ok(meta(result).includes('Total Files: 1500'))
  assert.equal(tree(result).split('\n').at(-1), '… and 500 more')
})
