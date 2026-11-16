import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBytes } from '../analysis/analyze.js'
import * as F from './__fixtures__/moreFormats.js'

// Summary as { label: value }; grouped items are keyed 'Group/Label'
function facts(bytes) {
  const analysis = analyzeBytes(bytes)
  const out = { formatId: analysis.formatId, formatName: analysis.formatName, warnings: analysis.warnings }
  for (const entry of analysis.summary) out[entry.group ? `${entry.group}/${entry.label}` : entry.label] = entry.value
  return out
}

test('tar: lists entries for the Archive panel in every variant', () => {
  const analysis = analyzeBytes(F.buildTar())
  assert.equal(analysis.category, 'archive')
  assert.deepEqual(analysis.entries.map(e => [e.path, e.isDirectory, e.size, e.method]), [['dir/', true, 0, 'stored'], ['dir/a.txt', false, 10, 'stored'], ['link', false, 0, 'symlink']])
  const f = facts(F.buildTar())
  assert.equal(f.Format, 'POSIX ustar')
  assert.equal(f['Total Files'], '1')
  assert.equal(f.Links, '1')
  for (const [format, name] of [['gnu', 'GNU tar'], ['pax', 'POSIX pax']]) {
    const long = 'd/'.repeat(70) + 'file.txt'
    const result = analyzeBytes(F.buildTar([{ name: long, data: 'x' }], { format }))
    assert.equal(result.entries[0].path, long, format)
    assert.equal(facts(F.buildTar([{ name: long, data: 'x' }], { format })).Format, name)
  }
  assert.ok(facts(F.buildTar(undefined, { end: false })).warnings.includes('No end-of-archive marker; the archive may be truncated'))
  const header = analyzeBytes(F.buildTar()).fields[1].children[0]
  assert.deepEqual(header.children.slice(0, 8).map(f => f.name), ['Name', 'Mode', 'Owner ID', 'Group ID', 'Size', 'Modified', 'Checksum', 'Type'])
})

test('BMP: header versions, orientation and palette', () => {
  const f = facts(F.buildBMP({ width: 7, height: 5, bpp: 8, headerSize: 124, topDown: true }))
  assert.equal(f.Width, '7px')
  assert.equal(f.Height, '5px')
  assert.equal(f.Header, 'BITMAPV5HEADER')
  assert.equal(f.Orientation, 'Top-down')
  assert.equal(f.Palette, '256 colours')
  assert.equal(f['Colour Space'], 'sRGB')
  assert.equal(facts(F.buildBMP({ headerSize: 12, bpp: 1 })).Header, 'BITMAPCOREHEADER (OS/2 1.x)')
  assert.ok(facts(F.buildBMP({ trailing: 9 })).warnings.includes('9 bytes of trailing data after the pixel data'))
})

test('ICO and CUR: one summary line per image', () => {
  const f = facts(F.buildICO())
  assert.equal(f.formatName, 'Windows Icon')
  assert.equal(f['Images/Image 1'], '16×16 BMP (32 bpp), 1.1 KB')
  assert.equal(f['Images/Image 2'], '32×32 PNG (32×32), 33 Bytes')
  const cursor = facts(F.buildICO([{ width: 32, height: 32 }], { cursor: true }))
  assert.equal(cursor.formatName, 'Windows Cursor')
  assert.match(cursor['Images/Image 1'], /hotspot 3,4/)
})

test('RIFF: WebP, WAV and AVI specifics', () => {
  const lossless = facts(F.buildWebP('VP8L', { width: 123, height: 45 }))
  assert.deepEqual([lossless.formatId, lossless.Width, lossless.Height, lossless.Compression, lossless.Alpha], ['webp', '123px', '45px', 'Lossless (VP8L)', 'Yes'])
  const lossy = facts(F.buildWebP('VP8', { width: 300, height: 200 }))
  assert.deepEqual([lossy.Width, lossy.Height, lossy.Compression], ['300px', '200px', 'Lossy (VP8)'])
  const animated = facts(F.buildWebP('VP8X', { width: 1000, height: 600 }))
  assert.deepEqual([animated.Width, animated.Container, animated.Features, animated.Frames, animated.Loops], ['1000px', 'Extended (VP8X)', 'alpha, animation', '2', 'Infinite'])

  const wav = facts(F.buildWAV({ channels: 1, rate: 22050, bits: 8, seconds: 2 }))
  assert.deepEqual([wav.formatId, wav.Encoding, wav.Channels, wav['Sample Rate'], wav.Duration, wav['Tags/Title']], ['wav', 'PCM', '1', '22,050 Hz', '2 s', 'Test tone'])

  const avi = facts(F.buildAVI({ frames: 50, usPerFrame: 40000 }))
  assert.deepEqual([avi.formatId, avi.Width, avi['Frame Rate'], avi.Duration, avi['Streams/Stream 0'], avi.Index], ['avi', '64px', '25 fps', '2 s', 'Video: MJPG 64×48', 'Yes (idx1)'])
  const other = facts(F.buildRIFF('CDXA', F.riffChunk('fmt ', F.zeros(16))))
  assert.deepEqual([other.formatId, other['Form Type']], ['riff', 'CDXA'])
})

test('TIFF: both byte orders, pages, EXIF and GPS', () => {
  const f = facts(F.buildTIFF({ exif: true, gps: true, width: 640, height: 480 }))
  assert.equal(f['Byte Order'], 'Little-endian (II)')
  assert.equal(f.Width, '640px')
  assert.equal(f.Height, '480px')
  assert.equal(f.Resolution, '300 × 300 DPI')
  assert.equal(f.Make, 'Maker')
  assert.equal(f.EXIF, 'Present (4 tags)')
  assert.equal(f['EXIF/Exposure'], '1/250 s')
  assert.equal(f['EXIF/Aperture'], 'f/2.8')
  assert.equal(f['EXIF/ISO'], '400')
  assert.equal(f['GPS/Coordinates'], '52.370139, -4.883333')
  assert.ok(f.warnings.includes('The image contains GPS coordinates'))
  const be = facts(F.buildTIFF({ little: false, pages: 3 }))
  assert.equal(be['Byte Order'], 'Big-endian (MM)')
  assert.equal(be.Images, '3')
  assert.equal(be['Images/Image 2'], '8×4, LZW')
  assert.equal(be.GPS, 'None')
})

test('ISO media: brands, duration, tracks and HEIF items', () => {
  const mp4 = facts(F.buildMP4())
  assert.equal(mp4.formatName, 'MP4 Video')
  assert.equal(mp4['Major Brand'], 'isom (ISO base media)')
  assert.equal(mp4.Duration, '2.5 s')
  assert.equal(mp4['Tracks/Track 1'], 'Video: avc1, 320×240, High, level 3.1, 2.48 s, 62 samples, eng')
  assert.equal(mp4['Tracks/Track 2'], 'Audio: mp4a, 8,000 Hz, 2 ch, 2.5 s, 20 samples, eng')
  assert.equal(mp4['Tags/Title'], 'Fixture clip')
  assert.equal(mp4['Fast Start'], 'Yes (metadata before media)')
  assert.equal(facts(F.buildMP4({ brand: 'M4A ', video: false })).formatName, 'MP4 Audio')
  assert.equal(facts(F.buildMP4({ fragmented: true })).Fragmented, 'Yes (1 fragment)')
  const heic = facts(F.buildMP4({ brand: 'heic', heif: true }))
  assert.deepEqual([heic.formatId, heic.formatName, heic['Primary Item'], heic['Image Size'], heic.EXIF], ['heif', 'HEIC Image', '#1 (hvc1)', '640×480', 'Present'])
  assert.equal(facts(F.buildMP4({ brand: 'avif', heif: true })).formatName, 'AVIF Image')
  const fields = analyzeBytes(F.buildMP4()).fields
  assert.deepEqual(fields.map(f => f.name), ['ftyp', 'moov', 'mdat'])
})

test('MP3: ID3v2 frames, frame header and duration', () => {
  const f = facts(F.buildMP3({ frames: 10 }))
  assert.equal(f.Audio, 'MPEG-1 Layer III')
  assert.equal(f.Bitrate, '128 kbit/s')
  assert.equal(f['Sample Rate'], '44,100 Hz')
  assert.equal(f.Frames, '10')
  assert.equal(f.Duration, '0.261 s')
  assert.equal(f['ID3 Tags'], 'v2.3')
  assert.equal(f['Tags/Title'], 'Fixture song')
  assert.equal(f['Tags/Artist'], 'Test artist')
  const bare = facts(F.buildMP3({ id3: false, id3v1: true }))
  assert.equal(bare['ID3 Tags'], 'v1')
  assert.equal(bare['Tags/Title'], 'Old title')
})

test('FLAC: STREAMINFO and Vorbis comments', () => {
  const f = facts(F.buildFLAC({ rate: 48000, channels: 1, bits: 24, samples: 96000 }))
  assert.deepEqual([f['Sample Rate'], f.Channels, f['Bits per Sample'], f['Total Samples'], f.Duration], ['48,000 Hz', '1', '24', '96,000', '2 s'])
  assert.equal(f['Tags/Title'], 'Fixture')
  assert.equal(f.Encoder, 'fixture')
  assert.deepEqual(f.warnings, [])
})

test('Ogg: codec identification, duration and CRC checks', () => {
  const opus = facts(F.buildOgg())
  assert.equal(opus.formatName, 'Ogg Opus Audio')
  assert.equal(opus['Streams/Stream 1'], 'Opus, 48,000 Hz, 2 ch, 2 s')
  assert.equal(opus['Tags/Title'], 'Ogg ok')
  assert.deepEqual(opus.warnings, [])
  const vorbis = facts(F.buildOgg({ codec: 'vorbis' }))
  assert.equal(vorbis['Streams/Stream 1'], 'Vorbis, 44,100 Hz, 1 ch, 2 s, 96 kbit/s nominal')
  const corrupt = F.buildOgg()
  corrupt[40] ^= 0xFF
  assert.ok(facts(corrupt).warnings.some(w => /CRC mismatch/.test(w)))
})
