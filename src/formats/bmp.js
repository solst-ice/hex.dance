import { ByteReader, field, fitted, formatNumber, fourcc, hex32, plural } from './reader.js'
import { formatBytes, item } from './shared.js'

const DIB_VERSIONS = {
  12: 'BITMAPCOREHEADER (OS/2 1.x)',
  16: 'OS/2 2.x header (short)',
  40: 'BITMAPINFOHEADER',
  52: 'BITMAPV2INFOHEADER',
  56: 'BITMAPV3INFOHEADER',
  64: 'OS/2 2.x header',
  108: 'BITMAPV4HEADER',
  124: 'BITMAPV5HEADER'
}

const COMPRESSION = {
  0: 'None (BI_RGB)', 1: 'RLE 8-bit (BI_RLE8)', 2: 'RLE 4-bit (BI_RLE4)', 3: 'Bit fields (BI_BITFIELDS)',
  4: 'JPEG (BI_JPEG)', 5: 'PNG (BI_PNG)', 6: 'Alpha bit fields (BI_ALPHABITFIELDS)', 11: 'CMYK', 12: 'CMYK RLE 8-bit', 13: 'CMYK RLE 4-bit'
}

const COLOR_SPACES = { 0: 'Calibrated RGB', 0x73524742: 'sRGB', 0x57696E20: 'Windows default', 0x4C494E4B: 'Linked ICC profile', 0x4D424544: 'Embedded ICC profile' }

/**
 * Reads a DIB header (the part of a BMP after the 14-byte file header, also
 * used for images inside ICO files). Returns null when too short.
 */
export function readDib(r, offset, { inIcon = false } = {}) {
  if (!r.has(offset, 4)) return null
  const size = r.u32(offset)
  const info = { size, version: DIB_VERSIONS[size] || `unknown (${size} bytes)`, fields: [] }
  const f = info.fields
  f.push(field('Header size', offset, 4, `${size} (${info.version})`, 'Identifies the DIB header version', 'size'))
  if (size === 12) {
    if (!r.has(offset, 12)) return info
    info.width = r.u16(offset + 4)
    info.height = r.i16(offset + 6)
    info.planes = r.u16(offset + 8)
    info.bpp = r.u16(offset + 10)
    info.compression = 0
    f.push(field('Width', offset + 4, 2, `${info.width}px`, 'Image width'))
    f.push(field('Height', offset + 6, 2, `${info.height}px`, 'Image height'))
    f.push(field('Planes', offset + 8, 2, info.planes, 'Always 1'))
    f.push(field('Bits per pixel', offset + 10, 2, info.bpp, 'Colour depth'))
    return info
  }
  if (size < 16 || !r.has(offset, 16)) return info
  info.width = r.i32(offset + 4)
  info.height = r.i32(offset + 8)
  info.planes = r.u16(offset + 12)
  info.bpp = r.u16(offset + 14)
  const heightNote = inIcon ? 'Twice the image height (colour plus mask rows)' : info.height < 0 ? 'Negative: rows stored top-down' : 'Positive: rows stored bottom-up'
  f.push(field('Width', offset + 4, 4, `${info.width}px`, 'Image width'))
  f.push(field('Height', offset + 8, 4, `${info.height}px`, heightNote))
  f.push(field('Planes', offset + 12, 2, info.planes, 'Always 1'))
  f.push(field('Bits per pixel', offset + 14, 2, info.bpp, 'Colour depth'))
  if (size < 40 || !r.has(offset, 40)) return info
  info.compression = r.u32(offset + 16)
  info.imageSize = r.u32(offset + 20)
  info.xppm = r.i32(offset + 24)
  info.yppm = r.i32(offset + 28)
  info.colorsUsed = r.u32(offset + 32)
  info.colorsImportant = r.u32(offset + 36)
  f.push(field('Compression', offset + 16, 4, COMPRESSION[info.compression] || `Unknown (${info.compression})`, 'How pixels are stored'))
  f.push(field('Image size', offset + 20, 4, formatNumber(info.imageSize), 'Bytes of pixel data; may be 0 for uncompressed images', 'size'))
  f.push(field('Horizontal resolution', offset + 24, 4, `${info.xppm} px/m (${Math.round(info.xppm * 0.0254)} DPI)`, 'Pixels per metre'))
  f.push(field('Vertical resolution', offset + 28, 4, `${info.yppm} px/m (${Math.round(info.yppm * 0.0254)} DPI)`, 'Pixels per metre'))
  f.push(field('Colours used', offset + 32, 4, info.colorsUsed || 'all', 'Palette entries; 0 means 2^bpp', 'count'))
  f.push(field('Important colours', offset + 36, 4, info.colorsImportant || 'all', 'Usually ignored', 'count'))
  if (size >= 52 && r.has(offset, 52)) {
    const masks = ['Red mask', 'Green mask', 'Blue mask', 'Alpha mask']
    for (let i = 0; i < (size >= 56 ? 4 : 3); i++) {
      f.push(field(masks[i], offset + 40 + i * 4, 4, hex32(r.u32(offset + 40 + i * 4)), 'Bits holding this channel', 'flags'))
    }
    info.alphaMask = size >= 56 ? r.u32(offset + 52) : 0
  }
  if (size >= 108 && r.has(offset, 108)) {
    const cs = r.u32(offset + 56)
    info.colorSpace = COLOR_SPACES[cs] || fourcc(r.bytes, offset + 56)
    f.push(field('Colour space', offset + 56, 4, info.colorSpace, 'LCS colour space type'))
    f.push(field('Endpoints', offset + 60, 36, undefined, 'CIE XYZ endpoints for calibrated RGB', 'data'))
    f.push(field('Gamma', offset + 96, 12, undefined, 'Red, green and blue gamma', 'data'))
  }
  if (size >= 124 && r.has(offset, 124)) {
    const intent = r.u32(offset + 108)
    const intents = { 1: 'Business (saturation)', 2: 'Graphics (relative colorimetric)', 4: 'Images (perceptual)', 8: 'Absolute colorimetric' }
    f.push(field('Rendering intent', offset + 108, 4, intents[intent] || intent, 'Gamut mapping intent'))
    info.profileOffset = r.u32(offset + 112)
    info.profileSize = r.u32(offset + 116)
    f.push(field('Profile offset', offset + 112, 4, formatNumber(info.profileOffset), 'From the start of this header', 'offset'))
    f.push(field('Profile size', offset + 116, 4, formatNumber(info.profileSize), 'ICC profile bytes', 'size'))
    f.push(field('Reserved', offset + 120, 4, undefined, 'Zero', 'padding'))
  }
  return info
}

export function paletteEntries(info) {
  if (!info || info.bpp > 8) return info && info.colorsUsed ? info.colorsUsed : 0
  return info.colorsUsed || (1 << info.bpp)
}

const VALID_DIB_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124])

function parseBMP(bytes) {
  const r = new ByteReader(bytes, true)
  const summary = []
  const warnings = []
  const regions = []
  const fields = []
  if (!r.has(0, 14)) {
    fields.push(field('Signature', 0, Math.min(2, bytes.length), 'BM', 'Windows bitmap signature', 'magic'))
    warnings.push('File is truncated inside the file header')
    return { summary, fields, warnings }
  }
  const declaredSize = r.u32(2)
  const pixelOffset = r.u32(10)
  fields.push(field('File header', 0, 14, undefined, 'BITMAPFILEHEADER', 'header', [
    field('Signature', 0, 2, 'BM', 'Windows bitmap signature', 'magic'),
    field('File size', 2, 4, formatNumber(declaredSize), 'Whole file, as recorded', 'size'),
    field('Reserved', 6, 4, undefined, 'Application-specific, usually zero', 'padding'),
    field('Pixel data offset', 10, 4, formatNumber(pixelOffset), 'Where the pixel array starts', 'offset')
  ]))
  regions.push({ name: 'File header', offset: 0, length: 14, kind: 'header' })
  const dib = readDib(r, 14)
  if (!dib || !r.has(14, dib.size)) {
    if (dib) fields.push(field('DIB header', 14, bytes.length - 14, dib.version, 'Bitmap information header', 'header', dib.fields))
    warnings.push('File is truncated inside the DIB header')
    if (dib && dib.width !== undefined) summary.push(item('Width', `${dib.width}px`), item('Height', `${Math.abs(dib.height)}px`))
    return { summary, fields, regions, warnings }
  }
  fields.push(field('DIB header', 14, dib.size, dib.version, 'Bitmap information header', 'header', dib.fields))
  regions.push({ name: 'DIB header', offset: 14, length: dib.size, kind: 'header' })

  let pos = 14 + dib.size
  // A 40-byte header with bit fields keeps its masks after the header
  if (dib.size === 40 && (dib.compression === 3 || dib.compression === 6)) {
    const count = dib.compression === 6 ? 4 : 3
    if (r.has(pos, count * 4)) {
      fields.push(field('Bit masks', pos, count * 4, undefined, 'Red, green, blue (and alpha) masks', 'flags'))
      pos += count * 4
    }
  }
  const paletteCount = paletteEntries(dib)
  const entrySize = dib.size === 12 ? 3 : 4
  if (paletteCount > 0 && pos < pixelOffset) {
    const length = Math.min(paletteCount * entrySize, pixelOffset - pos, bytes.length - pos)
    if (length > 0) {
      fields.push(field('Colour table', pos, length, `${plural(Math.floor(length / entrySize), 'colour')}`, `Palette, ${entrySize} bytes per entry (blue, green, red${entrySize === 4 ? ', reserved' : ''})`, 'table'))
      regions.push({ name: 'Colour table', offset: pos, length, kind: 'table' })
      pos += length
    }
  }
  if (pos < pixelOffset && pixelOffset <= bytes.length) {
    fields.push(field('Gap', pos, pixelOffset - pos, undefined, 'Unused bytes before the pixel data', 'padding'))
  }

  const width = dib.width
  const height = Math.abs(dib.height)
  const rowSize = Math.floor((dib.bpp * Math.abs(width) + 31) / 32) * 4
  const computed = dib.compression === 0 || dib.compression === 3 || dib.compression === 6 || dib.compression === undefined ? rowSize * height : 0
  const pixelLength = dib.imageSize || computed
  let pixelEnd = pixelOffset
  if (pixelOffset >= bytes.length) {
    warnings.push(`Pixel data offset ${formatNumber(pixelOffset)} is past the end of the file`)
  } else {
    const available = bytes.length - pixelOffset
    const length = pixelLength ? Math.min(pixelLength, available) : available
    fields.push(field('Pixel data', pixelOffset, length, formatBytes(pixelLength || length), dib.height < 0 ? 'Rows top-down' : 'Rows bottom-up, each padded to 4 bytes', 'data'))
    regions.push({ name: 'Pixel data', offset: pixelOffset, length, kind: 'data' })
    pixelEnd = pixelOffset + length
    if (pixelLength > available) warnings.push(`Pixel data is truncated: ${formatNumber(available)} of ${formatNumber(pixelLength)} bytes present`)
  }
  if (dib.profileSize && (dib.profileOffset + 14 + dib.profileSize) <= bytes.length && dib.profileOffset + 14 >= pixelEnd) {
    const start = 14 + dib.profileOffset
    fields.push(field('ICC profile', start, dib.profileSize, formatBytes(dib.profileSize), 'Embedded colour profile', 'data'))
    regions.push({ name: 'ICC profile', offset: start, length: dib.profileSize, kind: 'metadata' })
    pixelEnd = start + dib.profileSize
  }
  if (pixelLength && pixelEnd < bytes.length && pixelEnd >= pixelOffset) {
    warnings.push(`${plural(bytes.length - pixelEnd, 'byte')} of trailing data after the pixel data`)
    regions.push({ name: 'Trailing data', offset: pixelEnd, length: bytes.length - pixelEnd, kind: 'other' })
  }
  if (declaredSize !== bytes.length && declaredSize !== 0) warnings.push(`File size field says ${formatNumber(declaredSize)} bytes but the file has ${formatNumber(bytes.length)}`)

  summary.push(item('Width', `${width}px`))
  summary.push(item('Height', `${height}px`))
  summary.push(item('Bits per Pixel', dib.bpp))
  summary.push(item('Compression', COMPRESSION[dib.compression || 0] || `Unknown (${dib.compression})`))
  summary.push(item('Header', dib.version))
  if (dib.size >= 40) summary.push(item('Orientation', dib.height < 0 ? 'Top-down' : 'Bottom-up'))
  if (paletteCount > 0 && dib.bpp <= 8) summary.push(item('Palette', plural(paletteCount, 'colour')))
  if (dib.xppm > 0) summary.push(item('Resolution', `${Math.round(dib.xppm * 0.0254)} × ${Math.round(dib.yppm * 0.0254)} DPI`))
  if (dib.alphaMask) summary.push(item('Alpha Channel', 'Yes'))
  if (dib.colorSpace) summary.push(item('Colour Space', dib.colorSpace))
  return { summary, fields, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'bmp',
  name: 'BMP Image',
  category: 'image',
  // "BM" alone is too weak; the DIB header size must be a known one
  detect: bytes => bytes.length >= 18 && bytes[0] === 0x42 && bytes[1] === 0x4D &&
    VALID_DIB_SIZES.has(bytes[14] | (bytes[15] << 8) | (bytes[16] << 16) | (bytes[17] << 24)),
  parse: fitted(parseBMP)
}
