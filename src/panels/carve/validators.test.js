import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync, gzipSync } from 'node:zlib'
import { VALIDATORS } from './validate/index.js'
import { memorySource } from './source.js'
import * as F from './testFixtures.js'

const utf8 = (text) => new TextEncoder().encode(text)

const { concat, noise, bytes } = F

/** Runs the validator for signature `id` on `file` placed at `at` inside padding. */
async function check(id, file, { at = 100, start = at, tail = 64 } = {}) {
  const data = concat(noise(at, 99), file, noise(tail, 98))
  return VALIDATORS[id]({ src: memorySource(data), start, size: data.length, expired: () => false })
}

// [signature id, fixture, expected type, expected confidence]
const CASES = [
  ['png', F.png(), 'png', 'high'],
  ['jpeg', F.jpeg(), 'jpeg', 'high'],
  ['gif', F.gif(), 'gif', 'high'],
  ['bmp', F.bmp(), 'bmp', 'high'],
  ['ico', F.ico(), 'ico', 'high'],
  ['tiff', F.tiff(), 'tiff', 'high'],
  ['pe', F.pe(), 'pe', 'high'],
  ['elf', F.elf(), 'elf', 'high'],
  ['macho', F.macho(), 'macho', 'high'],
  ['cafebabe', F.fatMacho(), 'macho', 'high'],
  ['cafebabe', F.javaClass(), 'java-class', 'high'],
  ['zip', F.zip([{ name: 'a.txt', data: 'hello' }, { name: 'b/c.bin', data: 'world!' }]), 'zip', 'high'],
  ['zip', F.zip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'again' }], { descriptor: true }), 'zip', 'high'],
  ['gzip', gzipSync(utf8('gzip payload '.repeat(100))), 'gzip', 'high'],
  ['zlib', deflateSync(utf8('zlib payload '.repeat(100))), 'zlib', 'high'],
  ['zlib', F.zlibStored(F.noise(300, 5)), 'zlib', 'high'],
  ['xz', F.xz(), 'xz', 'high'],
  ['zstd', F.zstd(), 'zstd', 'high'],
  ['7z', F.sevenZip(), '7z', 'high'],
  ['lz4', F.lz4(), 'lz4', 'high'],
  ['cab', F.cab(), 'cab', 'high'],
  ['ar', F.ar(), 'ar', 'high'],
  ['ar', F.ar(true), 'deb', 'high'],
  ['cpio', F.cpio(), 'cpio', 'high'],
  ['tar', F.tar([{ name: 'a.txt', data: new Uint8Array(700).fill(66) }, { name: 'b.txt', data: new Uint8Array(3).fill(67) }]), 'tar', 'high'],
  ['squashfs', F.squashfs(), 'squashfs', 'high'],
  ['ext', F.ext2(), 'ext', 'high'],
  ['bootsector', F.fat16(), 'fat', 'high'],
  ['bootsector', F.mbr(), 'mbr', 'medium'],
  ['iso9660', F.iso(), 'iso9660', 'high'],
  ['uimage', F.uimage(), 'uimage', 'high'],
  ['dtb', F.dtb(), 'dtb', 'high'],
  ['androidboot', F.androidBoot(), 'androidboot', 'medium'],
  ['dex', F.dex(), 'dex', 'high'],
  ['ole', F.ole(), 'ole', 'high'],
  ['pem', F.pem(), 'pem', 'high'],
  ['der', F.der(), 'der', 'high'],
  ['wasm', F.wasm(), 'wasm', 'high'],
  ['sqlite', F.sqlite(), 'sqlite', 'high'],
  ['ogg', F.ogg(), 'ogg', 'high'],
  ['riff', F.wav(), 'wav', 'high'],
  ['isobmff', F.mp4(), 'isobmff', 'high'],
  ['mp3', F.mp3(), 'mp3', 'high'],
  ['nes', F.nes(), 'nes', 'medium'],
  ['gameboy', F.gameboy(), 'gameboy', 'high'],
  ['font', F.font(), 'font', 'high'],
  ['pcap', F.pcap(), 'pcap', 'high'],
  ['pcapng', F.pcapng(), 'pcapng', 'high']
]

for (const [id, fixture, type, confidence] of CASES) {
  test(`${id}: confirms a ${type} and finds its exact end`, async () => {
    const file = new Uint8Array(fixture)
    const result = await check(id, file)
    assert.ok(result, 'validator rejected a valid file')
    assert.equal(result.type, type)
    assert.equal(result.confidence, confidence)
    assert.equal(result.start, 100)
    // Formats whose end is only estimated stop where their records stop, which here is the end of the fixture
    assert.equal(result.end, 100 + file.length, `end ${result.end} for a ${file.length}-byte file at 100`)
  })
}

test('validators whose end is not stored report it as unknown', async () => {
  const lzma = bytes(0x5D, 0, 0, 0x80, 0, ...new Array(8).fill(0xFF), 0, 0x12, 0x34)
  const l = await check('lzma', lzma)
  assert.equal(l.end, null)
  assert.equal(l.confidence, 'low')
  const b = await check('bzip2', bytes('BZh9', 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0, 0))
  assert.equal(b.end, null)
  assert.equal(b.confidence, 'medium')
  const f = await check('flac', F.flac())
  assert.equal(f.end, null)
  assert.equal(f.confidence, 'high')
  const p = await check('pdf', F.pdf())
  assert.equal(p.end, null)
  assert.equal(p.deferred, true)
})

test('a file cut short reports how much is missing', async () => {
  const png = F.png()
  const data = concat(noise(10, 1), png.subarray(0, png.length - 20))
  const result = await VALIDATORS.png({ src: memorySource(data), start: 10, size: data.length, expired: () => false })
  assert.equal(result.confidence, 'medium')
  assert.equal(result.end, data.length)
  const bmp = F.bmp(8, 8)
  const cut = concat(noise(10, 2), bmp.subarray(0, 100))
  const b = await VALIDATORS.bmp({ src: memorySource(cut), start: 10, size: cut.length, expired: () => false })
  assert.equal(b.end, cut.length)
  assert.equal(b.claimedEnd, 10 + bmp.length)
})

test('a ZIP end record leads back to the start of its archive', async () => {
  const zip = F.zip([{ name: 'x', data: 'abc' }])
  const data = concat(noise(50, 3), zip)
  const eocd = data.length - 22
  const result = await VALIDATORS['zip-end']({ src: memorySource(data), start: eocd, size: data.length, expired: () => false })
  assert.equal(result.type, 'zip')
  assert.equal(result.start, 50)
  assert.equal(result.end, data.length)
  assert.equal(result.confidence, 'high')
})

test('gzip members that follow one another are one file', async () => {
  const one = gzipSync(utf8('first'))
  const two = gzipSync(utf8('second'))
  const result = await check('gzip', concat(one, two))
  assert.equal(result.end, 100 + one.length + two.length)
  assert.deepEqual(result.skip, [100 + one.length])
})

test('a gzip or zlib stream with a bad checksum is rejected', async () => {
  const gz = new Uint8Array(gzipSync(utf8('payload '.repeat(50))))
  gz[gz.length - 6] ^= 1
  assert.equal(await check('gzip', gz), null)
  const z = new Uint8Array(deflateSync(utf8('payload '.repeat(50))))
  z[z.length - 1] ^= 1
  assert.equal(await check('zlib', z), null)
})

test('a tar walker skips the headers of later members', async () => {
  const t = F.tar([{ name: 'a', data: new Uint8Array(600) }, { name: 'b', data: new Uint8Array(10) }])
  const result = await check('tar', t, { at: 0 })
  assert.deepEqual(result.skip, [1536])
})

// Short signatures followed by random bytes: validation must reject nearly all of them
const SHORT = [
  ['pe', [0x4D, 0x5A]],
  ['bmp', [0x42, 0x4D]],
  ['zlib', [0x78, 0x9C]],
  ['gzip', [0x1F, 0x8B, 0x08]],
  ['jpeg', [0xFF, 0xD8, 0xFF]],
  ['der', [0x30, 0x82]],
  ['lzma', [0x5D, 0x00, 0x00]],
  ['mp3', [0x49, 0x44, 0x33]]
]

for (const [id, signature] of SHORT) {
  test(`${id}: rejects its signature followed by random bytes`, async () => {
    let accepted = 0
    for (let seed = 1; seed <= 300; seed++) {
      const tail = noise(70000, seed * 7919)
      const result = await check(id, concat(Uint8Array.from(signature), tail), { at: 16 })
      if (result) accepted++
    }
    assert.ok(accepted <= 1, `${accepted} of 300 random candidates accepted`)
  })
}

test('boot-sector signatures at 510 need a sane BPB or partition table', async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const sector = noise(512, seed)
    sector[510] = 0x55
    sector[511] = 0xAA
    assert.equal(await check('bootsector', sector, { at: 0 }), null)
  }
})

test('ext superblock magic alone is not enough', async () => {
  for (let seed = 1; seed <= 100; seed++) {
    const image = noise(4096, seed)
    image[0x438] = 0x53
    image[0x439] = 0xEF
    assert.equal(await check('ext', image, { at: 0 }), null)
  }
})
