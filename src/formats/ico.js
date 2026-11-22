import { readDib } from './bmp.js'
import { ByteReader, capFields, field, fitted, formatNumber, nonOverlapping, plural } from './reader.js'
import { formatBytes, item } from './shared.js'
import { pointAt } from './pointers.js'

const MAX_IMAGES = 256
const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

function isPng(bytes, offset) {
  return PNG_SIGNATURE.every((byte, i) => bytes[offset + i] === byte)
}

function parseICO(bytes) {
  const r = new ByteReader(bytes, true)
  const warnings = []
  const regions = []
  const summary = []
  const type = r.u16(2)
  const isCursor = type === 2
  const count = r.u16(4)
  const header = field('Header', 0, Math.min(6, bytes.length), undefined, 'ICONDIR', 'header', [
    field('Reserved', 0, 2, '0', 'Always zero', 'magic'),
    field('Type', 2, 2, isCursor ? '2 (cursor)' : '1 (icon)', 'Icon or cursor', 'magic'),
    field('Image count', 4, 2, count, 'Entries in the directory', 'count')
  ])
  const fields = [header]
  if (!r.has(0, 6)) {
    warnings.push('File is truncated inside the header')
    return { summary, fields, warnings }
  }
  regions.push({ name: 'Header', offset: 0, length: 6, kind: 'header' })

  const shown = Math.min(count, MAX_IMAGES)
  const directory = []
  const images = []
  const descriptions = []
  for (let i = 0; i < shown; i++) {
    const at = 6 + i * 16
    if (!r.has(at, 16)) {
      warnings.push(`Directory is truncated after ${plural(i, 'entry', 'entries')}`)
      break
    }
    const width = r.u8(at) || 256
    const height = r.u8(at + 1) || 256
    const colors = r.u8(at + 2)
    const a = r.u16(at + 4)
    const b = r.u16(at + 6)
    const size = r.u32(at + 8)
    const offset = r.u32(at + 12)
    directory.push(pointAt(field(`Entry ${i + 1}`, at, 16, `${width}×${height}`, 'ICONDIRENTRY', 'header', [
      field('Width', at, 1, `${width}px`, '0 means 256'),
      field('Height', at + 1, 1, `${height}px`, '0 means 256'),
      field('Palette size', at + 2, 1, colors || 'none', 'Colours in the palette, 0 if none', 'count'),
      field('Reserved', at + 3, 1, r.u8(at + 3), 'Should be 0', 'padding'),
      isCursor ? field('Hotspot X', at + 4, 2, a, 'Cursor click point') : field('Colour planes', at + 4, 2, a, '0 or 1'),
      isCursor ? field('Hotspot Y', at + 6, 2, b, 'Cursor click point') : field('Bits per pixel', at + 6, 2, b, 'Colour depth'),
      field('Image size', at + 8, 4, formatNumber(size), 'Bytes of image data', 'size'),
      pointAt(field('Image offset', at + 12, 4, formatNumber(offset), 'Where the image data starts', 'offset'), size ? offset : null, bytes.length)
    ]), size ? offset : null, bytes.length))

    let encoding = 'unknown'
    let detail = ''
    if (offset >= bytes.length) {
      warnings.push(`Image ${i + 1} starts past the end of the file`)
    } else {
      if (offset + size > bytes.length) warnings.push(`Image ${i + 1} is truncated`)
      const length = Math.min(size, bytes.length - offset)
      let children = []
      if (isPng(bytes, offset)) {
        encoding = 'PNG'
        if (r.has(offset, 24)) detail = `${r.u32(offset + 16, false)}×${r.u32(offset + 20, false)}`
        children = [field('PNG signature', offset, Math.min(8, length), undefined, 'Embedded PNG image', 'magic')]
      } else {
        const dib = readDib(r, offset, { inIcon: true })
        if (dib && dib.size >= 12 && dib.size <= length) {
          encoding = 'BMP'
          detail = `${dib.bpp} bpp`
          children = [field('DIB header', offset, dib.size, dib.version, 'Bitmap header; height covers colour and mask rows', 'header', dib.fields)]
        }
      }
      if (length > 0) images.push(field(`Image ${i + 1}`, offset, length, `${width}×${height} ${encoding}`, encoding === 'PNG' ? 'PNG-compressed image' : 'Bitmap image with AND mask', 'data', children))
    }
    const depth = !isCursor && b ? `, ${b} bpp` : ''
    descriptions.push(`${width}×${height} ${encoding}${detail ? ` (${detail})` : depth}${isCursor ? `, hotspot ${a},${b}` : ''}, ${formatBytes(size)}`)
  }
  if (directory.length) {
    const end = 6 + directory.length * 16
    fields.push(field('Directory', 6, end - 6, plural(directory.length, 'entry', 'entries'), 'One entry per image', 'table', directory))
    regions.push({ name: 'Directory', offset: 6, length: end - 6, kind: 'table' })
  }
  if (count > MAX_IMAGES) warnings.push(`Only the first ${MAX_IMAGES} of ${formatNumber(count)} images are listed`)
  const placed = nonOverlapping(images)
  if (placed.length < images.length) warnings.push('Some images overlap each other or the directory')
  fields.push(...capFields(placed.filter(image => image.offset >= 6 + directory.length * 16), 64, 'more images'))
  for (const image of placed) regions.push({ name: image.name, offset: image.offset, length: image.length, kind: 'data' })

  summary.push(item('Type', isCursor ? 'Cursor' : 'Icon'))
  summary.push(item('Images', formatNumber(count)))
  descriptions.forEach((text, index) => summary.push(item(`Image ${index + 1}`, text, null, 'Images')))
  return { formatName: isCursor ? 'Windows Cursor' : 'Windows Icon', summary, fields, regions, warnings }
}

// ICO has a weak 4-byte signature, so the first directory entry must also be plausible
function detectICO(bytes) {
  if (bytes.length < 22 || bytes[0] !== 0 || bytes[1] !== 0 || (bytes[2] !== 1 && bytes[2] !== 2) || bytes[3] !== 0) return false
  const count = bytes[4] | (bytes[5] << 8)
  if (count === 0) return false
  const reserved = bytes[9]
  const size = (bytes[14] | (bytes[15] << 8) | (bytes[16] << 16) | (bytes[17] << 24)) >>> 0
  const offset = (bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24)) >>> 0
  return (reserved === 0 || reserved === 0xFF) && size > 0 && offset >= 6 + 16 * count
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'ico',
  name: 'Windows Icon',
  category: 'image',
  detect: detectICO,
  parse: fitted(parseICO)
}
