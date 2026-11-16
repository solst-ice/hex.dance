import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseMedia, mediaFromMime, mediaFromName, sniffBytes } from './sniff.js'
import { glitchCopy, pickOffsets, seededRandom, suggestSkip } from './glitch.js'

const bytesOf = (...parts) => Uint8Array.from(parts.flatMap(p => typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p))
const le32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]

test('sniffs image signatures', () => {
  assert.equal(sniffBytes(bytesOf([0x89], 'PNG\r\n\x1a\n', [0, 0]))?.mime, 'image/png')
  assert.equal(sniffBytes(bytesOf([0xff, 0xd8, 0xff, 0xe0]))?.mime, 'image/jpeg')
  assert.equal(sniffBytes(bytesOf('GIF89a', [1, 0]))?.mime, 'image/gif')
  assert.equal(sniffBytes(bytesOf('RIFF', le32(100), 'WEBPVP8 '))?.mime, 'image/webp')
  assert.equal(sniffBytes(bytesOf('RIFF', le32(100), 'WAVEfmt '))?.kind, 'audio')
  const bmp = bytesOf('BM', le32(1000), le32(0), le32(54), le32(40), le32(2), le32(2))
  assert.equal(sniffBytes(bmp)?.mime, 'image/bmp')
  assert.equal(sniffBytes(bytesOf('BM is just text here, nothing more to see')), null)
  const ico = bytesOf([0, 0, 1, 0, 1, 0], [16, 16, 0, 0, 1, 0, 32, 0], le32(100), le32(22))
  assert.equal(sniffBytes(ico)?.mime, 'image/x-icon')
  assert.equal(sniffBytes(bytesOf([0, 0, 1, 0, 1, 0], new Array(16).fill(7))), null)
  assert.equal(sniffBytes(bytesOf([0, 0, 0, 28], 'ftypavif', [0, 0, 0, 0], 'avifmif1'))?.mime, 'image/avif')
  assert.equal(sniffBytes(bytesOf('\xEF\xBB\xBF<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))?.mime, 'image/svg+xml')
  assert.equal(sniffBytes(bytesOf('<html><body>no</body></html>')), null)
})

test('sniffs audio and video signatures', () => {
  assert.equal(sniffBytes(bytesOf('ID3', [4, 0]))?.mime, 'audio/mpeg')
  assert.equal(sniffBytes(bytesOf([0xff, 0xfb, 0x90, 0x64]))?.mime, 'audio/mpeg')
  assert.equal(sniffBytes(bytesOf([0xff, 0xf1, 0x50, 0x80]))?.mime, 'audio/aac')
  assert.equal(sniffBytes(bytesOf('fLaC', [0]))?.mime, 'audio/flac')
  assert.equal(sniffBytes(bytesOf('OggS', [0, 2], 'xxxxOpusHead'))?.mime, 'audio/ogg')
  assert.equal(sniffBytes(bytesOf([0, 0, 0, 24], 'ftypisom', [0, 0, 2, 0], 'isomiso2'))?.mime, 'video/mp4')
  assert.equal(sniffBytes(bytesOf([0, 0, 0, 24], 'ftypM4A ', [0, 0, 2, 0], 'M4A isom'))?.mime, 'audio/mp4')
  assert.equal(sniffBytes(bytesOf([0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0], 'mif1heic')), null)
  assert.equal(sniffBytes(bytesOf([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], 'webm'))?.mime, 'video/webm')
})

test('does not mistake executables, text or tiny files for media', () => {
  assert.equal(sniffBytes(bytesOf([0x7f], 'ELF', [2, 1, 1, 0])), null)
  assert.equal(sniffBytes(bytesOf('MZ', [0x90, 0])), null)
  assert.equal(sniffBytes(bytesOf('hello world\n')), null)
  assert.equal(sniffBytes(bytesOf([0xff])), null)
  assert.equal(sniffBytes(new Uint8Array(0)), null)
})

test('falls back to MIME type and extension when the bytes are not known', () => {
  assert.equal(mediaFromMime('IMAGE/PNG; charset=binary')?.mime, 'image/png')
  assert.equal(mediaFromName('clip.MP4')?.mime, 'video/mp4')
  assert.equal(mediaFromName('notes.txt'), null)
  assert.equal(chooseMedia({ bytes: bytesOf('junk'), fileName: 'a.webp' })?.mime, 'image/webp')
  assert.equal(chooseMedia({ bytes: bytesOf([0xff, 0xd8, 0xff]), fileName: 'a.png' })?.mime, 'image/jpeg')
  assert.equal(chooseMedia({ bytes: bytesOf('junk'), formatId: 'bmp' })?.mime, 'image/bmp')
})

test('seeded picks are reproducible, distinct, sorted and after the header', () => {
  const a = pickOffsets(1000, 50, 100, 7)
  assert.deepEqual(a, pickOffsets(1000, 50, 100, 7))
  assert.notDeepEqual(a, pickOffsets(1000, 50, 100, 8))
  assert.equal(new Set(a).size, 50)
  assert.ok(a.every((v, i) => v >= 100 && v < 1000 && (i === 0 || a[i - 1] < v)))
  assert.deepEqual(pickOffsets(10, 50, 5, 1), [5, 6, 7, 8, 9])
  assert.deepEqual(pickOffsets(0, 5, 0, 1), [])
  const r = seededRandom(1)
  for (let i = 0; i < 100; i++) {
    const v = r()
    assert.ok(v >= 0 && v < 1)
  }
})

test('glitchCopy changes only the chosen bytes of a copy', () => {
  const original = new Uint8Array(64).fill(0x55)
  const { bytes, changes } = glitchCopy(original, [3, 10], 1)
  assert.ok(original.every(v => v === 0x55), 'the original is untouched')
  assert.equal(changes.length, 2)
  for (const { offset, from, to } of changes) {
    assert.equal(from, 0x55)
    assert.notEqual(to, from)
    assert.equal(bytes[offset], to)
  }
  assert.equal(bytes.filter(v => v !== 0x55).length, 2)
})

test('suggestSkip finds where compressed pixels start', () => {
  // JPEG: SOI, APP0 (len 4), SOS (len 6)
  const jpeg = bytesOf([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xda, 0, 6, 1, 2, 3, 4, 9, 9, 9, 9])
  assert.equal(suggestSkip(jpeg, 'image/jpeg'), 16)
  const png = bytesOf([0x89], 'PNG\r\n\x1a\n', [0, 0, 0, 1], 'IHDR', [0], [0, 0, 0, 0], [0, 0, 0, 4], 'IDAT', [0x78, 0x9c, 1, 2], [0, 0, 0, 0])
  assert.equal(suggestSkip(png, 'image/png'), 8 + 13 + 8 + 2)
  assert.equal(suggestSkip(new Uint8Array(80), 'image/webp'), 10)
  assert.equal(suggestSkip(new Uint8Array(1), 'image/png'), 0)
})
