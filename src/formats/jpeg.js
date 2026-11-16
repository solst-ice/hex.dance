import { dataView, item, startsWith } from './shared.js'

const JPEG_SOF_TYPES = {
  0xC0: 'Baseline DCT',
  0xC1: 'Extended sequential DCT',
  0xC2: 'Progressive DCT',
  0xC3: 'Lossless',
  0xC5: 'Differential sequential DCT',
  0xC6: 'Differential progressive DCT',
  0xC7: 'Differential lossless',
  0xC9: 'Extended sequential DCT, arithmetic',
  0xCA: 'Progressive DCT, arithmetic',
  0xCB: 'Lossless, arithmetic',
  0xCD: 'Differential sequential DCT, arithmetic',
  0xCE: 'Differential progressive DCT, arithmetic',
  0xCF: 'Differential lossless, arithmetic'
}

const JPEG_COMPONENTS = { 1: 'Grayscale', 3: 'YCbCr', 4: 'CMYK' }

// Markers that are not followed by a length field
function isStandaloneMarker(marker) {
  return marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)
}

function parseJPEG(bytes) {
  const view = dataView(bytes)
  const summary = []
  const warnings = []
  const fields = [{ name: 'SOI marker', offset: 0, length: 2, value: 'FF D8', kind: 'magic', description: 'Start of image' }]
  const result = () => ({ summary, fields, warnings })
  let offset = 2 // Skip SOI
  let truncated = true

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xFF) {
      warnings.push(`Invalid marker at offset 0x${offset.toString(16).toUpperCase()}`)
      return result()
    }
    // Any number of 0xFF fill bytes may precede a marker
    while (offset < bytes.length && bytes[offset] === 0xFF) offset++
    if (offset >= bytes.length) break
    const marker = bytes[offset]
    offset++

    if (isStandaloneMarker(marker)) continue
    if (marker === 0xD9 || marker === 0xDA) {
      // End of image, or start of scan without a preceding frame header
      truncated = false
      break
    }

    if (offset + 2 > bytes.length) break
    const length = view.getUint16(offset, false)
    if (length < 2) {
      warnings.push(`Invalid segment length at offset 0x${offset.toString(16).toUpperCase()}`)
      return result()
    }

    if (JPEG_SOF_TYPES[marker]) {
      if (offset + 8 > bytes.length) break
      const precision = bytes[offset + 2]
      const height = view.getUint16(offset + 3, false)
      const width = view.getUint16(offset + 5, false)
      const components = bytes[offset + 7]
      summary.push(item('Width', `${width}px`))
      summary.push(item('Height', `${height}px`))
      summary.push(item('Precision', `${precision} bits`))
      summary.push(item('Components', `${components}${JPEG_COMPONENTS[components] ? ` (${JPEG_COMPONENTS[components]})` : ''}`))
      summary.push(item('Encoding', JPEG_SOF_TYPES[marker]))
      return result()
    }

    offset += length
  }

  warnings.push(truncated ? 'File is truncated before the frame header' : 'No frame header found')
  return result()
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'jpeg',
  name: 'JPEG Image',
  category: 'image',
  detect: bytes => startsWith(bytes, [0xFF, 0xD8]),
  parse: parseJPEG
}
