import { ascii, dataView, item, startsWith } from './shared.js'

const SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

const PNG_COLOR_TYPES = {
  0: 'Grayscale',
  2: 'Truecolor (RGB)',
  3: 'Indexed (palette)',
  4: 'Grayscale with alpha',
  6: 'Truecolor with alpha (RGBA)'
}

const PNG_INTERLACE = { 0: 'None', 1: 'Adam7' }

function parsePNG(bytes) {
  const view = dataView(bytes)
  const summary = []
  const warnings = []
  const fields = [{
    name: 'Signature',
    offset: 0,
    length: Math.min(8, bytes.length),
    value: '\\x89PNG\\r\\n\\x1A\\n',
    kind: 'magic',
    description: 'PNG file signature'
  }]
  const result = () => ({ summary, fields, warnings })

  // Signature (8) + chunk length (4) + chunk type (4) + IHDR data (13)
  if (bytes.length < 16) {
    warnings.push('File is truncated before the first chunk')
    return result()
  }

  const chunkLength = view.getUint32(8, false)
  const chunkType = ascii(bytes, 12, 4)
  if (chunkType !== 'IHDR') {
    warnings.push(`First chunk is "${chunkType.replace(/[^\x20-\x7E]/g, '?')}", expected IHDR`)
    return result()
  }
  if (chunkLength !== 13) {
    warnings.push(`IHDR chunk has length ${chunkLength}, expected 13`)
  }
  if (bytes.length < 16 + 13) {
    if (bytes.length >= 24) {
      summary.push(item('Width', `${view.getUint32(16, false)}px`))
      summary.push(item('Height', `${view.getUint32(20, false)}px`))
    }
    warnings.push('File is truncated inside the IHDR chunk')
    return result()
  }

  const colorType = bytes[25]
  const interlace = bytes[28]
  summary.push(item('Width', `${view.getUint32(16, false)}px`))
  summary.push(item('Height', `${view.getUint32(20, false)}px`))
  summary.push(item('Bit Depth', bytes[24]))
  summary.push(item('Color Type', PNG_COLOR_TYPES[colorType] || `Unknown (${colorType})`))
  summary.push(item('Interlace', PNG_INTERLACE[interlace] || `Unknown (${interlace})`))
  return result()
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'png',
  name: 'PNG Image',
  category: 'image',
  detect: bytes => startsWith(bytes, SIGNATURE.slice(0, 4)),
  parse: parsePNG
}
