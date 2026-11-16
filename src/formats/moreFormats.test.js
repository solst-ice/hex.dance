import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FORMATS, detectFormat } from './index.js'
import { analyzeBytes } from '../analysis/analyze.js'
import * as F from './__fixtures__/moreFormats.js'
import { buildZip, buildPNG, buildJPEG, buildGIF, buildPDF, SIMPLE_PDF, buildJavaClass, buildFatMachO } from './__fixtures__/fileFormats.js'
import { buildELF, buildPE, buildMachO, buildDosOnly } from './__fixtures__/executables.js'

// The original nine parsers may throw on truncated input (analyzeBytes turns
// that into a warning); the modules added later must not
const ORIGINAL = new Set(['png', 'jpeg', 'gif', 'pe', 'java-class', 'macho', 'zip', 'elf', 'pdf'])

const u8 = buffer => (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))

// Every fixture and the module that must claim it
const FIXTURES = [
  ['png', buildPNG()], ['jpeg', buildJPEG()], ['gif', buildGIF()], ['pdf', buildPDF(SIMPLE_PDF)], ['zip', buildZip([{ name: 'a', data: 'a' }])],
  ['java-class', buildJavaClass({ major: 52 })], ['macho', buildFatMachO(2)], ['macho', buildMachO()], ['elf', buildELF()], ['pe', buildPE()], ['pe', buildDosOnly()],
  ['text', F.buildText('Hello, world.\nSecond line\n')], ['text', F.buildText('{"a": [1, 2, 3]}\n', { bom: true })], ['text', F.buildUtf16('UTF-16 text\r\n', true)],
  ['text', F.buildUtf16('big endian\n', false)], ['text', F.buildText('café ☃ naïve\n')], ['text', F.buildText('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')],
  ['gzip', F.gzipMember({ name: 'hello.txt', comment: 'note', extra: F.bytesOf('BC', F.u16le(2), F.u16le(99)), headerCrc: true })],
  ['gzip', F.bytesOf(F.gzipMember({ deflate: F.DEFLATE_DYNAMIC, size: F.DEFLATE_DYNAMIC_SIZE }), F.gzipMember({ deflate: F.deflateStored(F.noise(300)), size: 300 }))],
  ['xz', F.buildXz()], ['bzip2', F.buildBzip2()], ['zstd', F.buildZstd()], ['zstd', F.buildZstd(F.noise(2500), { checksum: true, skippable: true, contentSize: false })],
  ['7z', F.build7z()], ['7z', F.build7z({ encodedHeader: true })], ['rar', F.buildRar5()], ['rar', F.buildRar4()],
  ['tar', F.buildTar()], ['tar', F.buildTar([{ name: 'n'.repeat(120), data: 'x' }], { format: 'gnu' })], ['tar', F.buildTar([{ name: 'p'.repeat(130), data: 'y' }], { format: 'pax', recordPadding: 1024 })],
  ['tar', F.buildTar([{ name: 'old.txt', data: 'v7' }], { format: 'v7' })],
  ['bmp', F.buildBMP()], ['bmp', F.buildBMP({ headerSize: 124, bpp: 8, topDown: true })], ['bmp', F.buildBMP({ headerSize: 12, bpp: 1 })],
  ['ico', F.buildICO()], ['ico', F.buildICO([{ width: 32, height: 32 }], { cursor: true })],
  ['webp', F.buildWebP('VP8L')], ['webp', F.buildWebP('VP8')], ['webp', F.buildWebP('VP8X')], ['wav', F.buildWAV()], ['avi', F.buildAVI()],
  ['riff', F.buildRIFF('CDXA', F.riffChunk('fmt ', F.zeros(16)))],
  ['tiff', F.buildTIFF({ exif: true, gps: true })], ['tiff', F.buildTIFF({ little: false, pages: 3 })],
  ['isobmff', F.buildMP4()], ['isobmff', F.buildMP4({ fragmented: true, audio: false })], ['isobmff', F.buildMP4({ brand: 'M4A ', video: false })],
  ['heif', F.buildMP4({ brand: 'heic', heif: true })], ['heif', F.buildMP4({ brand: 'avif', heif: true })],
  ['wasm', F.buildWasm()], ['sqlite', F.buildSQLite()], ['mp3', F.buildMP3()], ['mp3', F.buildMP3({ id3: false, id3v1: true })], ['flac', F.buildFLAC()],
  ['ogg', F.buildOgg()], ['ogg', F.buildOgg({ codec: 'vorbis' })], ['font', F.buildTTF()], ['font', F.buildWOFF()], ['font', F.buildWOFF2()],
  ['pcap', F.buildPcap()], ['pcap', F.buildPcap({ little: false, nano: true })], ['pcap', F.buildPcapng()], ['bplist', F.buildBplist()], ['der', F.buildCertificate()],
  ['nes', F.buildNES()], ['gameboy', F.buildGameBoy()], ['partition', F.buildMBR()], ['partition', F.buildGPT()], ['iso9660', F.buildISO()]
].map(([id, buffer]) => [id, u8(buffer)])

test('every fixture is claimed by the right module', () => {
  for (const [id, bytes] of FIXTURES) {
    assert.equal(detectFormat(bytes)?.id ?? 'unknown', id, `fixture for ${id} (${bytes.length} bytes)`)
  }
})

test('noise and empty buffers are claimed by no module', () => {
  for (const length of [0, 1, 2, 3, 7, 16, 100, 511, 512, 513, 4096, 40000, 70000]) {
    assert.equal(detectFormat(new Uint8Array(length))?.id ?? null, null, `${length} zero bytes`)
    for (let seed = 1; seed <= 40; seed++) {
      const bytes = F.noise(length, seed * 7919 + length)
      assert.equal(detectFormat(bytes)?.id ?? null, null, `${length} random bytes, seed ${seed}`)
    }
  }
  // Short text is too little evidence; the base tests rely on "A\n" staying unknown
  assert.equal(detectFormat(F.ascii('A\n'))?.id ?? null, null)
  assert.equal(detectFormat(F.ascii('AB'))?.id ?? null, null)
})

test('module ids are unique', () => {
  const ids = FORMATS.map(format => format.id)
  assert.equal(new Set(ids).size, ids.length)
})

// Fields lie inside the file, children inside their parent, siblings in order without overlap
function fieldProblems(fields, start, end, path = '') {
  const problems = []
  let previousEnd = start
  const sorted = [...fields].sort((a, b) => a.offset - b.offset)
  for (const field of sorted) {
    const here = `${path}/${field.name}`
    if (!Number.isSafeInteger(field.offset) || !Number.isSafeInteger(field.length) || field.length <= 0) problems.push(`${here}: bad range ${field.offset}+${field.length}`)
    if (field.offset < start || field.offset + field.length > end) problems.push(`${here}: ${field.offset}+${field.length} outside ${start}..${end}`)
    if (field.offset < previousEnd) problems.push(`${here}: overlaps its previous sibling (starts ${field.offset}, previous ends ${previousEnd})`)
    previousEnd = Math.max(previousEnd, field.offset + field.length)
    if (typeof field.name !== 'string' || !field.name) problems.push(`${here}: missing name`)
    if (field.children) problems.push(...fieldProblems(field.children, field.offset, field.offset + field.length, here))
  }
  return problems
}

function rawFields(bytes) {
  const format = detectFormat(bytes)
  return format ? format.parse(bytes, {}).fields || [] : []
}

test('fields of every fixture form a well-nested tree inside the file', () => {
  for (const [id, bytes] of FIXTURES) {
    const problems = fieldProblems(rawFields(bytes), 0, bytes.length)
    assert.deepEqual(problems, [], `${id}: ${problems.slice(0, 5).join('; ')}`)
  }
})

test('every new module reports its magic or header as a field', () => {
  for (const [id, bytes] of FIXTURES) {
    const analysis = analyzeBytes(bytes)
    assert.ok(analysis.fields.length > 0, `${id} has fields`)
    assert.ok(analysis.summary.length > 0, `${id} has a summary`)
    assert.deepEqual(analysis.warnings.filter(w => w.startsWith('Error')), [], id)
  }
})

// Prefix lengths to try: all of them for small files, a dense sample for larger ones
function prefixLengths(length) {
  if (length <= 1200) return Array.from({ length: length + 1 }, (_, i) => i)
  const set = new Set()
  for (let i = 0; i <= 600; i++) set.add(i)
  const step = Math.max(1, Math.floor(length / 400))
  for (let i = 0; i <= length; i += step) set.add(i)
  for (let i = Math.max(0, length - 300); i <= length; i++) set.add(i)
  return [...set]
}

test('truncated fixtures never throw and keep their fields inside the file', () => {
  for (const [id, bytes] of FIXTURES) {
    for (const length of prefixLengths(bytes.length)) {
      const prefix = bytes.subarray(0, length)
      const format = detectFormat(prefix)
      if (!format) continue
      if (ORIGINAL.has(format.id)) {
        assert.doesNotThrow(() => analyzeBytes(prefix), `${id} cut to ${length} bytes`)
        continue
      }
      let result
      assert.doesNotThrow(() => { result = format.parse(prefix, {}) }, `${id} cut to ${length} bytes (${format.id})`)
      const problems = fieldProblems(result.fields || [], 0, length)
      assert.deepEqual(problems, [], `${id} cut to ${length} bytes: ${problems.slice(0, 3).join('; ')}`)
    }
  }
})

test('corrupted fixtures never throw', () => {
  for (const [id, bytes] of FIXTURES) {
    for (let seed = 1; seed <= 12; seed++) {
      const copy = bytes.slice()
      const garbage = F.noise(16, seed)
      // Overwrite a few spots after the signature with random bytes
      for (let i = 0; i < 4; i++) {
        const at = 8 + ((garbage[i * 2] << 8 | garbage[i * 2 + 1]) % Math.max(1, copy.length - 8))
        copy.set(garbage.subarray(8, 12).subarray(0, Math.max(0, Math.min(4, copy.length - at))), at)
      }
      const format = detectFormat(copy)
      if (!format || ORIGINAL.has(format.id)) continue
      assert.doesNotThrow(() => {
        const result = format.parse(copy, {})
        assert.deepEqual(fieldProblems(result.fields || [], 0, copy.length), [])
      }, `${id} corrupted with seed ${seed}`)
    }
  }
})
