const PNG_COLOR_TYPES = {
  0: 'Grayscale',
  2: 'Truecolor (RGB)',
  3: 'Indexed (palette)',
  4: 'Grayscale with alpha',
  6: 'Truecolor with alpha (RGBA)'
}

const PNG_INTERLACE = { 0: 'None', 1: 'Adam7' }

function ascii(bytes, start, length) {
  let out = ''
  for (let i = start; i < start + length && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i])
  }
  return out
}

export function parsePNG(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const metadata = new Set()

  // Signature (8) + chunk length (4) + chunk type (4) + IHDR data (13)
  if (bytes.length < 16) {
    metadata.add('Warning: File is truncated before the first chunk')
    return metadata
  }

  const chunkLength = view.getUint32(8, false)
  const chunkType = ascii(bytes, 12, 4)
  if (chunkType !== 'IHDR') {
    metadata.add(`Warning: First chunk is "${chunkType.replace(/[^\x20-\x7E]/g, '?')}", expected IHDR`)
    return metadata
  }
  if (chunkLength !== 13) {
    metadata.add(`Warning: IHDR chunk has length ${chunkLength}, expected 13`)
  }
  if (bytes.length < 16 + 13) {
    if (bytes.length >= 24) {
      metadata.add(`Width: ${view.getUint32(16, false)}px`)
      metadata.add(`Height: ${view.getUint32(20, false)}px`)
    }
    metadata.add('Warning: File is truncated inside the IHDR chunk')
    return metadata
  }

  const colorType = bytes[25]
  const interlace = bytes[28]
  metadata.add(`Width: ${view.getUint32(16, false)}px`)
  metadata.add(`Height: ${view.getUint32(20, false)}px`)
  metadata.add(`Bit Depth: ${bytes[24]}`)
  metadata.add(`Color Type: ${PNG_COLOR_TYPES[colorType] || `Unknown (${colorType})`}`)
  metadata.add(`Interlace: ${PNG_INTERLACE[interlace] || `Unknown (${interlace})`}`)
  return metadata
}

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

export function parseJPEG(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const metadata = new Set()
  let offset = 2 // Skip SOI
  let truncated = true

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xFF) {
      metadata.add(`Warning: Invalid marker at offset 0x${offset.toString(16).toUpperCase()}`)
      return metadata
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
      metadata.add(`Warning: Invalid segment length at offset 0x${offset.toString(16).toUpperCase()}`)
      return metadata
    }

    if (JPEG_SOF_TYPES[marker]) {
      if (offset + 8 > bytes.length) break
      const precision = bytes[offset + 2]
      const height = view.getUint16(offset + 3, false)
      const width = view.getUint16(offset + 5, false)
      const components = bytes[offset + 7]
      metadata.add(`Width: ${width}px`)
      metadata.add(`Height: ${height}px`)
      metadata.add(`Precision: ${precision} bits`)
      metadata.add(`Components: ${components}${JPEG_COMPONENTS[components] ? ` (${JPEG_COMPONENTS[components]})` : ''}`)
      metadata.add(`Encoding: ${JPEG_SOF_TYPES[marker]}`)
      return metadata
    }

    offset += length
  }

  metadata.add(truncated
    ? 'Warning: File is truncated before the frame header'
    : 'Warning: No frame header found')
  return metadata
}

export function parseGIF(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const metadata = new Set()

  if (bytes.length >= 6) {
    metadata.add(`Version: ${ascii(bytes, 0, 6).replace(/[^\x20-\x7E]/g, '?')}`)
  }
  if (bytes.length < 10) {
    metadata.add('Warning: File is truncated before the logical screen descriptor')
    return metadata
  }
  metadata.add(`Width: ${view.getUint16(6, true)}px`)
  metadata.add(`Height: ${view.getUint16(8, true)}px`)
  if (bytes.length < 13) {
    metadata.add('Warning: File is truncated inside the logical screen descriptor')
    return metadata
  }

  const flags = bytes[10]
  metadata.add(`Global Color Table: ${flags & 0x80 ? `Yes (${2 << (flags & 7)} colors)` : 'No'}`)
  metadata.add(`Color Resolution: ${((flags >> 4) & 7) + 1} bits`)
  if (flags & 0x80) metadata.add(`Background Color Index: ${bytes[11]}`)
  return metadata
}
