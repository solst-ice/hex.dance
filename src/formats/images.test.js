import { test } from 'node:test'
import assert from 'node:assert/strict'
import png from './png.js'
import jpeg from './jpeg.js'
import gif from './gif.js'
import { buildPNG, buildJPEG, buildGIF, truncate } from './__fixtures__/fileFormats.js'

// Summary items as 'Label: value' lines followed by 'Warning: ...' lines
function lines(format, buffer) {
  const result = format.parse(new Uint8Array(buffer), {})
  return [
    ...result.summary.map(entry => `${entry.label}: ${entry.value}`),
    ...result.warnings.map(warning => `Warning: ${warning}`)
  ]
}

test('PNG: reads IHDR with readable colour type', () => {
  assert.deepEqual(lines(png, buildPNG({ width: 300, height: 150, bitDepth: 16, colorType: 2, interlace: 1 })), [
    'Width: 300px',
    'Height: 150px',
    'Bit Depth: 16',
    'Color Type: Truecolor (RGB)',
    'Interlace: Adam7'
  ])
  assert.ok(lines(png, buildPNG({ colorType: 3 })).includes('Color Type: Indexed (palette)'))
})

test('PNG: marks the signature', () => {
  const result = png.parse(new Uint8Array(buildPNG()), {})
  assert.deepEqual(result.fields.map(f => [f.name, f.offset, f.length, f.kind]), [['Signature', 0, 8, 'magic']])
})

test('PNG: rejects a first chunk that is not IHDR', () => {
  assert.deepEqual(lines(png, buildPNG({ firstChunk: 'tEXt' })), ['Warning: First chunk is "tEXt", expected IHDR'])
})

test('PNG: truncated files give partial metadata without throwing', () => {
  const file = buildPNG({ width: 10, height: 20 })
  for (let length = 0; length <= file.byteLength; length++) {
    assert.doesNotThrow(() => lines(png, truncate(file, length)))
  }
  assert.deepEqual(lines(png, truncate(file, 26)), ['Width: 10px', 'Height: 20px', 'Warning: File is truncated inside the IHDR chunk'])
  assert.deepEqual(lines(png, truncate(file, 8)), ['Warning: File is truncated before the first chunk'])
})

test('JPEG: skips DHT and DAC segments and finds the real frame header', () => {
  assert.deepEqual(lines(jpeg, buildJPEG({ width: 800, height: 600 })), [
    'Width: 800px',
    'Height: 600px',
    'Precision: 8 bits',
    'Components: 3 (YCbCr)',
    'Encoding: Baseline DCT'
  ])
})

test('JPEG: identifies progressive and grayscale frames', () => {
  const result = lines(jpeg, buildJPEG({ width: 17, height: 9, sof: 0xC2, components: 1 }))
  assert.ok(result.includes('Width: 17px'))
  assert.ok(result.includes('Components: 1 (Grayscale)'))
  assert.ok(result.includes('Encoding: Progressive DCT'))
})

test('JPEG: truncated files never throw or read past the end', () => {
  const file = buildJPEG()
  for (let length = 0; length <= file.byteLength; length++) {
    assert.doesNotThrow(() => lines(jpeg, truncate(file, length)), `length ${length}`)
  }
  assert.deepEqual(lines(jpeg, truncate(file, 40)), ['Warning: File is truncated before the frame header'])
})

test('JPEG: reports garbage where a marker is expected', () => {
  const bytes = new Uint8Array([0xFF, 0xD8, 0x12, 0x34, 0x56, 0x78])
  assert.deepEqual(lines(jpeg, bytes.buffer), ['Warning: Invalid marker at offset 0x2'])
})

test('GIF: reads version, dimensions and colour table', () => {
  assert.deepEqual(lines(gif, buildGIF({ version: '87a', width: 320, height: 200 })), [
    'Version: GIF87a',
    'Width: 320px',
    'Height: 200px',
    'Global Color Table: Yes (256 colors)',
    'Color Resolution: 8 bits',
    'Background Color Index: 3'
  ])
})

test('GIF: truncated header degrades to partial metadata', () => {
  const file = buildGIF()
  for (let length = 0; length <= file.byteLength; length++) {
    assert.doesNotThrow(() => lines(gif, truncate(file, length)))
  }
  assert.deepEqual(lines(gif, truncate(file, 8)), ['Version: GIF89a', 'Warning: File is truncated before the logical screen descriptor'])
})
