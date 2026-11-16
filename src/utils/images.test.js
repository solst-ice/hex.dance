import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePNG, parseJPEG, parseGIF } from './images.js'
import { buildPNG, buildJPEG, buildGIF, truncate } from './__fixtures__/fileFormats.js'

const list = set => [...set]

test('PNG: reads IHDR with readable colour type', () => {
  assert.deepEqual(list(parsePNG(buildPNG({ width: 300, height: 150, bitDepth: 16, colorType: 2, interlace: 1 }))), [
    'Width: 300px',
    'Height: 150px',
    'Bit Depth: 16',
    'Color Type: Truecolor (RGB)',
    'Interlace: Adam7'
  ])
  assert.ok(list(parsePNG(buildPNG({ colorType: 3 }))).includes('Color Type: Indexed (palette)'))
})

test('PNG: rejects a first chunk that is not IHDR', () => {
  const result = list(parsePNG(buildPNG({ firstChunk: 'tEXt' })))
  assert.deepEqual(result, ['Warning: First chunk is "tEXt", expected IHDR'])
})

test('PNG: truncated files give partial metadata without throwing', () => {
  const png = buildPNG({ width: 10, height: 20 })
  for (let length = 0; length <= png.byteLength; length++) {
    assert.doesNotThrow(() => parsePNG(truncate(png, length)))
  }
  assert.deepEqual(list(parsePNG(truncate(png, 26))), ['Width: 10px', 'Height: 20px', 'Warning: File is truncated inside the IHDR chunk'])
  assert.deepEqual(list(parsePNG(truncate(png, 8))), ['Warning: File is truncated before the first chunk'])
})

test('JPEG: skips DHT and DAC segments and finds the real frame header', () => {
  assert.deepEqual(list(parseJPEG(buildJPEG({ width: 800, height: 600 }))), [
    'Width: 800px',
    'Height: 600px',
    'Precision: 8 bits',
    'Components: 3 (YCbCr)',
    'Encoding: Baseline DCT'
  ])
})

test('JPEG: identifies progressive and grayscale frames', () => {
  const result = list(parseJPEG(buildJPEG({ width: 17, height: 9, sof: 0xC2, components: 1 })))
  assert.ok(result.includes('Width: 17px'))
  assert.ok(result.includes('Components: 1 (Grayscale)'))
  assert.ok(result.includes('Encoding: Progressive DCT'))
})

test('JPEG: truncated files never throw or read past the end', () => {
  const jpeg = buildJPEG()
  for (let length = 0; length <= jpeg.byteLength; length++) {
    assert.doesNotThrow(() => parseJPEG(truncate(jpeg, length)), `length ${length}`)
  }
  assert.deepEqual(list(parseJPEG(truncate(jpeg, 40))), ['Warning: File is truncated before the frame header'])
})

test('JPEG: reports garbage where a marker is expected', () => {
  const bytes = new Uint8Array([0xFF, 0xD8, 0x12, 0x34, 0x56, 0x78])
  assert.deepEqual(list(parseJPEG(bytes.buffer)), ['Warning: Invalid marker at offset 0x2'])
})

test('GIF: reads version, dimensions and colour table', () => {
  assert.deepEqual(list(parseGIF(buildGIF({ version: '87a', width: 320, height: 200 }))), [
    'Version: GIF87a',
    'Width: 320px',
    'Height: 200px',
    'Global Color Table: Yes (256 colors)',
    'Color Resolution: 8 bits',
    'Background Color Index: 3'
  ])
})

test('GIF: truncated header degrades to partial metadata', () => {
  const gif = buildGIF()
  for (let length = 0; length <= gif.byteLength; length++) {
    assert.doesNotThrow(() => parseGIF(truncate(gif, length)))
  }
  assert.deepEqual(list(parseGIF(truncate(gif, 8))), ['Version: GIF89a', 'Warning: File is truncated before the logical screen descriptor'])
})
