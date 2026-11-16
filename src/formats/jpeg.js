import { dataView, item, startsWith } from './shared.js'
import { FieldList, clip, field, hexOffset, plural, printable } from './fieldTree.js'

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

const MARKER_NAMES = {
  0x01: ['TEM', 'Temporary marker for arithmetic coding'],
  0xC4: ['DHT', 'Define Huffman tables: the codes used by the entropy-coded data'],
  0xC8: ['JPG', 'Reserved for JPEG extensions'],
  0xCC: ['DAC', 'Define arithmetic coding conditioning'],
  0xD8: ['SOI', 'Start of image: every JPEG begins with FF D8'],
  0xD9: ['EOI', 'End of image'],
  0xDA: ['SOS', 'Start of scan: a short header, followed by entropy-coded image data'],
  0xDB: ['DQT', 'Define quantization tables: how coarsely each frequency is stored'],
  0xDC: ['DNL', 'Define number of lines'],
  0xDD: ['DRI', 'Define restart interval: RST markers appear every N blocks'],
  0xDE: ['DHP', 'Define hierarchical progression'],
  0xDF: ['EXP', 'Expand reference components'],
  0xFE: ['COM', 'Comment']
}

function markerInfo(marker) {
  if (JPEG_SOF_TYPES[marker]) return [`SOF${marker - 0xC0}`, `Start of frame (${JPEG_SOF_TYPES[marker]}): image size and components`]
  if (marker >= 0xD0 && marker <= 0xD7) return [`RST${marker - 0xD0}`, 'Restart marker: resets the decoder so damage stays local']
  if (marker >= 0xE0 && marker <= 0xEF) return [`APP${marker - 0xE0}`, 'Application segment: metadata, identified by a string at its start']
  if (marker >= 0xF0 && marker <= 0xFD) return [`JPG${marker - 0xF0}`, 'Reserved for JPEG extensions']
  return MARKER_NAMES[marker] || [`Marker ${hexOffset(marker)}`, 'Unknown marker']
}

// Markers that are not followed by a length field
function isStandaloneMarker(marker) {
  return marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)
}

const isAPP = marker => marker >= 0xE0 && marker <= 0xEF

const APP_IDENTIFIERS = [
  ['JFIF\0', 'JFIF', 'JFIF header: version, pixel density and an optional thumbnail'],
  ['JFXX\0', 'JFIF extension', 'JFIF extension: thumbnail'],
  ['Exif\0', 'Exif', 'Exif metadata: a TIFF structure with camera settings, date and orientation'],
  ['http://ns.adobe.com/xap/1.0/\0', 'XMP', 'XMP metadata as XML'],
  ['http://ns.adobe.com/xmp/extension/\0', 'Extended XMP', 'Continuation of XMP metadata too large for one segment'],
  ['ICC_PROFILE\0', 'ICC profile', 'Part of an ICC colour profile, possibly split over several segments'],
  ['Photoshop 3.0\0', 'Photoshop', 'Photoshop image resource blocks (often IPTC metadata)'],
  ['Adobe', 'Adobe', 'Adobe colour transform information'],
  ['MPF\0', 'MPF', 'Multi-picture format: an index of further images stored after this one'],
  ['Ducky', 'Ducky', 'Photoshop "Save for Web" quality setting']
]

function matchIdentifier(bytes, at, end) {
  for (const [text, name, description] of APP_IDENTIFIERS) {
    if (at + text.length > end) continue
    let ok = true
    for (let i = 0; i < text.length && ok; i++) ok = bytes[at + i] === text.charCodeAt(i)
    if (ok) return { length: text.length, name, description }
  }
  return null
}

function decodeAPP(view, bytes, at, end) {
  const children = []
  const id = matchIdentifier(bytes, at, end)
  if (!id) {
    children.push(field('Data', at, end - at, { value: printable(bytes, at, end - at, 24), kind: 'data' }))
    return { children }
  }
  children.push(field('Identifier', at, id.length, { value: printable(bytes, at, id.length, 40), kind: 'magic', description: `${id.description}. The identifier says which standard defined the segment` }))
  let p = at + id.length
  if (id.name === 'JFIF' && p + 9 <= end) {
    const units = ['none (aspect ratio only)', 'dots per inch', 'dots per cm'][bytes[p + 2]] || String(bytes[p + 2])
    children.push(
      field('Version', p, 2, { value: `${bytes[p]}.${String(bytes[p + 1]).padStart(2, '0')}`, kind: 'header' }),
      field('Density units', p + 2, 1, { value: units, kind: 'flags' }),
      field('X density', p + 3, 2, { value: view.getUint16(p + 3, false), kind: 'size' }),
      field('Y density', p + 5, 2, { value: view.getUint16(p + 5, false), kind: 'size' }),
      field('Thumbnail width', p + 7, 1, { value: bytes[p + 7], kind: 'size' }),
      field('Thumbnail height', p + 8, 1, { value: bytes[p + 8], kind: 'size' })
    )
    p += 9
    if (p < end) children.push(field('Thumbnail', p, end - p, { kind: 'data', description: 'Uncompressed RGB thumbnail pixels' }))
    return { children, value: id.name }
  }
  if (id.name === 'Exif') {
    // "Exif\0" is followed by a pad byte, then a TIFF header
    if (p < end) children.push(field('Padding', p, 1, { value: hexOffset(bytes[p]), kind: 'padding' }))
    p += 1
    if (p + 8 <= end) {
      const little = bytes[p] === 0x49 && bytes[p + 1] === 0x49
      const big = bytes[p] === 0x4D && bytes[p + 1] === 0x4D
      children.push(field('TIFF byte order', p, 2, {
        value: little ? 'II (little-endian)' : big ? 'MM (big-endian)' : printable(bytes, p, 2),
        kind: 'magic',
        description: 'Byte order of every number in the Exif block: II for Intel, MM for Motorola'
      }))
      if (little || big) {
        children.push(
          field('TIFF magic', p + 2, 2, { value: view.getUint16(p + 2, little), kind: 'magic', description: 'Always 42 in a TIFF header' }),
          field('First IFD offset', p + 4, 4, { value: hexOffset(view.getUint32(p + 4, little)), kind: 'offset', description: 'Where the first directory of tags starts, counted from the byte-order mark' })
        )
        if (p + 8 < end) children.push(field('TIFF data', p + 8, end - p - 8, { kind: 'data', description: 'Tag directories and their values' }))
      } else if (p + 2 < end) {
        children.push(field('Data', p + 2, end - p - 2, { kind: 'data' }))
      }
    } else if (p < end) {
      children.push(field('Data', p, end - p, { kind: 'data' }))
    }
    return { children, value: id.name }
  }
  if (id.name === 'ICC profile' && p + 2 <= end) {
    children.push(
      field('Chunk number', p, 1, { value: bytes[p], kind: 'count' }),
      field('Chunk count', p + 1, 1, { value: bytes[p + 1], kind: 'count' })
    )
    p += 2
  }
  if (p < end) {
    const isText = id.name === 'XMP'
    children.push(field(isText ? 'XML' : 'Data', p, end - p, { value: isText ? printable(bytes, p, end - p, 60) : undefined, kind: isText ? 'string' : 'data' }))
  }
  return { children, value: id.name }
}

function decodeDQT(bytes, at, end) {
  const children = []
  let p = at
  while (p < end && children.length < 16) {
    const precision = bytes[p] >> 4
    const id = bytes[p] & 0x0F
    const stop = Math.min(end, p + 1 + 64 * (precision ? 2 : 1))
    const kids = [field('Precision and ID', p, 1, { value: `${precision ? 16 : 8}-bit, table ${id}`, kind: 'flags', description: 'High nibble: 0 for 8-bit values, 1 for 16-bit; low nibble: table number' })]
    if (stop > p + 1) kids.push(field('Values', p + 1, stop - p - 1, { kind: 'data', description: '64 quantizers in zig-zag order, low frequencies first' }))
    children.push(field(`Table ${id}`, p, stop - p, { value: `${precision ? 16 : 8}-bit values`, kind: 'header', children: kids }))
    p = stop
  }
  if (p < end) children.push(field('Unparsed', p, end - p, { kind: 'data' }))
  return { children, value: plural(children.filter(child => child.name !== 'Unparsed').length, 'table') }
}

function decodeDHT(bytes, at, end) {
  const children = []
  let p = at
  while (p + 17 <= end && children.length < 16) {
    const tableClass = bytes[p] >> 4 ? 'AC' : 'DC'
    const id = bytes[p] & 0x0F
    let symbols = 0
    for (let i = 1; i <= 16; i++) symbols += bytes[p + i]
    const stop = Math.min(end, p + 17 + symbols)
    const kids = [
      field('Class and ID', p, 1, { value: `${tableClass} table ${id}`, kind: 'flags', description: 'High nibble: 0 for DC, 1 for AC coefficients; low nibble: table number' }),
      field('Code counts', p + 1, 16, { value: plural(symbols, 'symbol'), kind: 'count', description: 'How many codes there are of each length from 1 to 16 bits' })
    ]
    if (stop > p + 17) kids.push(field('Symbols', p + 17, stop - p - 17, { kind: 'data', description: 'The values the codes stand for, shortest codes first' }))
    children.push(field(`${tableClass} table ${id}`, p, stop - p, { kind: 'header', children: kids }))
    p = stop
  }
  const tables = children.length
  if (p < end) children.push(field('Unparsed', p, end - p, { kind: 'data' }))
  return { children, value: plural(tables, 'table') }
}

function decodeSOF(view, bytes, marker, at, end) {
  if (at + 6 > end) return {}
  const height = view.getUint16(at + 1, false)
  const width = view.getUint16(at + 3, false)
  const count = bytes[at + 5]
  const children = [
    field('Precision', at, 1, { value: `${bytes[at]} bits`, kind: 'header', description: 'Bits per sample' }),
    field('Height', at + 1, 2, { value: `${height} px`, kind: 'size', description: 'Number of lines; 0 means it is given later in a DNL segment' }),
    field('Width', at + 3, 2, { value: `${width} px`, kind: 'size' }),
    field('Components', at + 5, 1, { value: `${count}${JPEG_COMPONENTS[count] ? ` (${JPEG_COMPONENTS[count]})` : ''}`, kind: 'count' })
  ]
  let p = at + 6
  for (let i = 0; i < count && p + 3 <= end && i < 8; i++, p += 3) {
    children.push(field(`Component ${bytes[p]}`, p, 3, {
      value: `sampling ${bytes[p + 1] >> 4}×${bytes[p + 1] & 0x0F}, quantization table ${bytes[p + 2]}`,
      kind: 'header',
      description: 'Component ID, horizontal and vertical sampling factors, and the quantization table it uses'
    }))
  }
  if (p < end) children.push(field('Unparsed', p, end - p, { kind: 'data' }))
  return { children, value: `${width} × ${height}, ${JPEG_SOF_TYPES[marker]}` }
}

function decodeSOS(bytes, at, end) {
  const count = bytes[at]
  const children = [field('Components in scan', at, 1, { value: count, kind: 'count' })]
  let p = at + 1
  for (let i = 0; i < count && p + 2 <= end && i < 8; i++, p += 2) {
    children.push(field(`Component ${bytes[p]}`, p, 2, { value: `DC table ${bytes[p + 1] >> 4}, AC table ${bytes[p + 1] & 0x0F}`, kind: 'header' }))
  }
  if (p + 3 <= end) {
    children.push(
      field('Spectral start', p, 1, { value: bytes[p], kind: 'header', description: 'First DCT coefficient in this scan; progressive JPEGs spread coefficients over several scans' }),
      field('Spectral end', p + 1, 1, { value: bytes[p + 1], kind: 'header', description: 'Last DCT coefficient in this scan' }),
      field('Successive approximation', p + 2, 1, { value: `high ${bytes[p + 2] >> 4}, low ${bytes[p + 2] & 0x0F}`, kind: 'header', description: 'Bit positions refined by this scan' })
    )
    p += 3
  }
  if (p < end) children.push(field('Unparsed', p, end - p, { kind: 'data' }))
  return { children, value: plural(count, 'component') }
}

function decodePayload(view, bytes, marker, at, end) {
  if (isAPP(marker)) return decodeAPP(view, bytes, at, end)
  if (marker === 0xDB) return decodeDQT(bytes, at, end)
  if (marker === 0xC4) return decodeDHT(bytes, at, end)
  if (JPEG_SOF_TYPES[marker]) return decodeSOF(view, bytes, marker, at, end)
  if (marker === 0xDA) return decodeSOS(bytes, at, end)
  if (marker === 0xDD && end - at >= 2) return { value: `every ${view.getUint16(at, false)} MCUs` }
  if (marker === 0xFE) return { value: clip(new TextDecoder('latin1').decode(bytes.subarray(at, Math.min(end, at + 200)))) }
  return {}
}

// End of entropy-coded data: the first 0xFF that starts a real marker, that
// is, one not followed by a stuffed zero or a restart code
function scanEnd(bytes, start) {
  let p = start
  for (;;) {
    const ff = bytes.indexOf(0xFF, p)
    if (ff === -1 || ff + 1 >= bytes.length) return bytes.length
    let q = ff + 1
    while (q < bytes.length && bytes[q] === 0xFF) q++
    if (q >= bytes.length) return bytes.length
    const next = bytes[q]
    if (next === 0x00 || (next >= 0xD0 && next <= 0xD7)) {
      p = q + 1
      continue
    }
    return ff
  }
}

function parseJPEG(bytes) {
  const view = dataView(bytes)
  const summary = []
  const warnings = []
  const segments = new FieldList(2000, 'segments')
  const regions = []
  let frameFound = false
  let invalidAt = -1
  let badLength = false
  let eoiAt = -1
  let truncated = false
  let scans = 0
  let offset = 0

  const addRegion = (name, start, length, kind) => {
    const last = regions[regions.length - 1]
    if (last && last.name === name && last.offset + last.length === start) last.length += length
    else if (regions.length < 500) regions.push({ name, offset: start, length, kind })
  }

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xFF) {
      invalidAt = offset
      break
    }
    const start = offset
    while (offset < bytes.length && bytes[offset] === 0xFF) offset++
    if (offset >= bytes.length) {
      truncated = true
      segments.push(field('Fill bytes', start, offset - start, { kind: 'padding', description: '0xFF padding before a marker that never comes' }))
      break
    }
    const marker = bytes[offset]
    const markerAt = offset - 1
    offset++
    const [name, description] = markerInfo(marker)
    const isSOI = start === 0 && marker === 0xD8
    const children = []
    if (markerAt > start) children.push(field('Fill bytes', start, markerAt - start, { kind: 'padding', description: 'Optional 0xFF bytes allowed before any marker' }))
    children.push(field('Marker', markerAt, 2, {
      value: `FF ${marker.toString(16).toUpperCase().padStart(2, '0')} (${name})`,
      kind: isSOI ? 'magic' : 'header',
      description: 'Every marker is 0xFF followed by a code byte'
    }))

    if (isStandaloneMarker(marker)) {
      segments.push(field(name, start, offset - start, {
        kind: isSOI ? 'magic' : 'header',
        value: `FF ${marker.toString(16).toUpperCase()}`,
        description,
        children: children.length > 1 ? children : undefined
      }))
      addRegion(marker === 0xD8 || marker === 0xD9 ? name : 'Markers', start, offset - start, 'header')
      if (marker === 0xD9) {
        eoiAt = offset
        break
      }
      continue
    }

    if (offset + 2 > bytes.length) {
      truncated = true
      segments.push(field(name, start, bytes.length - start, { kind: 'header', description, children }))
      break
    }
    const length = view.getUint16(offset, false)
    if (length < 2) {
      warnings.push(`Invalid segment length at offset ${hexOffset(offset)}`)
      badLength = true
      children.push(field('Length', offset, 2, { value: length, kind: 'size', description: 'Invalid: a length counts itself, so it is at least 2' }))
      segments.push(field(name, start, offset + 2 - start, { kind: 'header', description, children }))
      offset += 2
      if (offset < bytes.length) invalidAt = offset
      break
    }
    const payloadStart = offset + 2
    const segmentEnd = offset + length
    const end = Math.min(segmentEnd, bytes.length)
    if (segmentEnd > bytes.length) truncated = true

    let value
    if (!segments.full) {
      children.push(field('Length', offset, 2, { value: `${length} bytes`, kind: 'size', description: 'Counts itself and the payload, not the marker' }))
      if (end > payloadStart) {
        const decoded = decodePayload(view, bytes, marker, payloadStart, end)
        value = decoded.value
        children.push(field('Payload', payloadStart, end - payloadStart, { value: decoded.value, kind: isAPP(marker) ? 'data' : 'header', children: decoded.children }))
      }
    }

    if (JPEG_SOF_TYPES[marker] && !frameFound && offset + 8 <= bytes.length) {
      frameFound = true
      const precision = bytes[offset + 2]
      const height = view.getUint16(offset + 3, false)
      const width = view.getUint16(offset + 5, false)
      const components = bytes[offset + 7]
      summary.push(item('Width', `${width}px`))
      summary.push(item('Height', `${height}px`))
      summary.push(item('Precision', `${precision} bits`))
      summary.push(item('Components', `${components}${JPEG_COMPONENTS[components] ? ` (${JPEG_COMPONENTS[components]})` : ''}`))
      summary.push(item('Encoding', JPEG_SOF_TYPES[marker]))
    }

    segments.push(field(value && isAPP(marker) ? `${name} ${value}` : name, start, end - start, { kind: 'header', description, value, children }))
    addRegion(isAPP(marker) ? 'Metadata' : 'Tables and headers', start, end - start, isAPP(marker) ? 'metadata' : 'table')
    offset = end
    if (segmentEnd > bytes.length) break

    if (marker === 0xDA) {
      scans++
      const stop = scanEnd(bytes, offset)
      if (stop > offset) {
        segments.push(field('Entropy-coded data', offset, stop - offset, {
          kind: 'data',
          value: `scan ${scans}, ${plural(stop - offset, 'byte')}`,
          description: 'Huffman- or arithmetic-coded image data; every 0xFF inside is followed by a stuffed 0x00 so it cannot be mistaken for a marker'
        }))
        addRegion('Image data', offset, stop - offset, 'data')
      }
      if (stop >= bytes.length) truncated = true
      offset = stop
    }
  }

  const fields = segments.toArray()
  if (invalidAt >= 0) {
    if (!badLength) warnings.push(`Invalid marker at offset ${hexOffset(invalidAt)}`)
    fields.push(field('Unparsed data', invalidAt, bytes.length - invalidAt, { kind: 'data', description: 'Expected a marker (0xFF) here, so the rest of the file is not interpreted' }))
    addRegion('Unparsed data', invalidAt, bytes.length - invalidAt, 'other')
  }
  if (eoiAt !== -1 && eoiAt < bytes.length) {
    fields.push(field('Trailing data', eoiAt, bytes.length - eoiAt, {
      kind: 'data',
      value: printable(bytes, eoiAt, Math.min(16, bytes.length - eoiAt)),
      description: 'Bytes after the end-of-image marker are ignored by decoders. Some cameras store extra images or video here; it can also hide appended data'
    }))
    addRegion('Trailing data', eoiAt, bytes.length - eoiAt, 'other')
    warnings.push(`${plural(bytes.length - eoiAt, 'byte')} of trailing data after the end-of-image marker`)
  }

  if (invalidAt === -1 && !badLength) {
    if (!frameFound) warnings.push(truncated || eoiAt === -1 ? 'File is truncated before the frame header' : 'No frame header found')
    else if (eoiAt === -1) warnings.push('No end-of-image marker: the file may be truncated')
  }
  if (frameFound && scans > 1) summary.push(item('Scans', scans))
  return { summary, fields, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'jpeg',
  name: 'JPEG Image',
  category: 'image',
  detect: bytes => startsWith(bytes, [0xFF, 0xD8]),
  parse: parseJPEG
}
