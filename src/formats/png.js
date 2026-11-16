import { ascii, dataView, item, startsWith } from './shared.js'
import { FieldList, clip, crc32, field, hexOffset, plural } from './fieldTree.js'

const SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

const PNG_COLOR_TYPES = {
  0: 'Grayscale',
  2: 'Truecolor (RGB)',
  3: 'Indexed (palette)',
  4: 'Grayscale with alpha',
  6: 'Truecolor with alpha (RGBA)'
}

const PNG_INTERLACE = { 0: 'None', 1: 'Adam7' }

// CRCs are verified for at most this many bytes, so huge files stay quick
const CRC_BUDGET = 64 * 1024 * 1024

const SIGNATURE_PARTS = [
  [0, 1, '0x89', 'High bit set: catches transfers over 7-bit channels that strip the top bit, and keeps text tools from treating the file as ASCII'],
  [1, 3, 'PNG', 'The format name in ASCII, so a person looking at the bytes can tell what the file is'],
  [4, 2, 'CR LF', 'A DOS line ending: turns into a lone LF if the file is converted to Unix line endings'],
  [6, 1, '0x1A', 'Ctrl-Z, end of file for MS-DOS: stops the "type" command from printing the binary data that follows'],
  [7, 1, 'LF', 'A Unix line ending: becomes CR LF if the file is converted to DOS line endings']
]

const CHUNK_DESCRIPTIONS = {
  IHDR: 'Image header: dimensions, bit depth and colour type. Always the first chunk',
  PLTE: 'Palette: the colours an indexed image refers to',
  IDAT: 'Image data: part of one zlib stream; all IDAT chunks together hold the filtered scanlines',
  IEND: 'Image end: marks the end of the PNG data stream',
  tRNS: 'Transparency: alpha for palette entries or one transparent colour',
  gAMA: 'Gamma of the image, times 100000',
  cHRM: 'Chromaticities of the primaries and white point',
  sRGB: 'The image uses the sRGB colour space',
  iCCP: 'Embedded ICC colour profile (compressed)',
  cICP: 'Coding-independent code points for the colour space',
  tEXt: 'Text: a keyword and Latin-1 text',
  zTXt: 'Compressed text: a keyword and deflate-compressed Latin-1 text',
  iTXt: 'International text: a keyword and UTF-8 text, optionally compressed',
  bKGD: 'Default background colour',
  pHYs: 'Physical pixel size or aspect ratio',
  sBIT: 'Number of significant bits in the original samples',
  sPLT: 'Suggested palette',
  hIST: 'Palette histogram',
  tIME: 'Time of the last modification',
  eXIf: 'Exif metadata',
  acTL: 'Animation control (APNG): number of frames and plays',
  fcTL: 'Frame control (APNG): size, position and timing of the next frame',
  fdAT: 'Frame data (APNG): image data of a frame after the first'
}

const RENDERING_INTENTS = { 0: 'Perceptual', 1: 'Relative colorimetric', 2: 'Saturation', 3: 'Absolute colorimetric' }

const latin1 = new TextDecoder('latin1')
const utf8 = new TextDecoder('utf-8')

// The case of each letter in a chunk type is a property bit
function chunkProperties(bytes, offset) {
  const lower = i => (bytes[offset + i] & 0x20) !== 0
  return [
    lower(0) ? 'ancillary' : 'critical',
    lower(1) ? 'private' : 'public',
    lower(3) ? 'safe to copy' : 'unsafe to copy'
  ].join(', ')
}

function indexOfZero(bytes, start, end) {
  const at = bytes.subarray(start, end).indexOf(0)
  return at === -1 ? -1 : start + at
}

function decodeText(type, bytes, start, end) {
  const children = []
  const nul = indexOfZero(bytes, start, Math.min(end, start + 80))
  if (nul === -1) return children
  if (nul > start) {
    const keyword = latin1.decode(bytes.subarray(start, nul))
    children.push(field('Keyword', start, nul - start, { value: clip(keyword), kind: 'string', description: 'What the text is about, for example Title, Author or Software' }))
  }
  children.push(field('Separator', nul, 1, { value: '0x00', kind: 'padding', description: 'Null byte ending the keyword' }))
  let at = nul + 1
  if (type === 'tEXt') {
    if (at < end) children.push(field('Text', at, end - at, { value: clip(latin1.decode(bytes.subarray(at, Math.min(end, at + 512)))), kind: 'string' }))
    return children
  }
  if (type === 'zTXt') {
    if (at < end) children.push(field('Compression method', at, 1, { value: bytes[at] === 0 ? '0 (deflate)' : bytes[at], kind: 'flags' }))
    if (at + 1 < end) children.push(field('Compressed text', at + 1, end - at - 1, { kind: 'data', description: 'zlib stream; not decompressed here' }))
    return children
  }
  // iTXt: compression flag, method, language tag\0, translated keyword\0, text
  if (at + 2 > end) return children
  const compressed = bytes[at] === 1
  children.push(field('Compression flag', at, 1, { value: compressed ? '1 (compressed)' : '0 (uncompressed)', kind: 'flags' }))
  children.push(field('Compression method', at + 1, 1, { value: bytes[at + 1], kind: 'flags' }))
  at += 2
  for (const name of ['Language tag', 'Translated keyword']) {
    const stop = indexOfZero(bytes, at, end)
    if (stop === -1) return children
    if (stop > at) children.push(field(name, at, stop - at, { value: clip(utf8.decode(bytes.subarray(at, stop))), kind: 'string' }))
    children.push(field('Separator', stop, 1, { value: '0x00', kind: 'padding' }))
    at = stop + 1
  }
  if (at < end) {
    children.push(compressed
      ? field('Compressed text', at, end - at, { kind: 'data', description: 'zlib stream; not decompressed here' })
      : field('Text', at, end - at, { value: clip(utf8.decode(bytes.subarray(at, Math.min(end, at + 512)))), kind: 'string' }))
  }
  return children
}

function textValue(children) {
  const keyword = children.find(child => child.name === 'Keyword')
  const text = children.find(child => child.name === 'Text')
  if (!keyword) return undefined
  return text ? clip(`${keyword.value}: ${text.value}`, 80) : keyword.value
}

function decodeIHDR(view, bytes, at) {
  const colorType = bytes[at + 9]
  const interlace = bytes[at + 12]
  return [
    field('Width', at, 4, { value: `${view.getUint32(at, false)} px`, kind: 'size', description: 'Image width in pixels, big-endian like every PNG integer' }),
    field('Height', at + 4, 4, { value: `${view.getUint32(at + 4, false)} px`, kind: 'size', description: 'Image height in pixels' }),
    field('Bit depth', at + 8, 1, { value: bytes[at + 8], kind: 'header', description: 'Bits per sample, or per palette index for indexed images' }),
    field('Colour type', at + 9, 1, { value: `${colorType} (${PNG_COLOR_TYPES[colorType] || 'unknown'})`, kind: 'flags', description: 'Bit 0: palette used, bit 1: colour, bit 2: alpha channel' }),
    field('Compression method', at + 10, 1, { value: bytes[at + 10] === 0 ? '0 (deflate)' : bytes[at + 10], kind: 'header', description: 'Only 0, zlib deflate, is defined' }),
    field('Filter method', at + 11, 1, { value: bytes[at + 11] === 0 ? '0 (adaptive)' : bytes[at + 11], kind: 'header', description: 'Only 0 is defined: each scanline starts with a filter-type byte' }),
    field('Interlace method', at + 12, 1, { value: `${interlace} (${PNG_INTERLACE[interlace] || 'unknown'})`, kind: 'header', description: 'Adam7 sends the image in seven passes so a rough version appears early' })
  ]
}

function decodeData(type, view, bytes, at, length) {
  if (type === 'IHDR' && length >= 13) return { children: decodeIHDR(view, bytes, at) }
  if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
    const children = decodeText(type, bytes, at, at + length)
    return { children, value: textValue(children) }
  }
  if (type === 'PLTE') return { value: plural(Math.floor(length / 3), 'colour') }
  if (type === 'gAMA' && length >= 4) return { value: `${view.getUint32(at, false) / 100000}` }
  if (type === 'sRGB' && length >= 1) return { value: RENDERING_INTENTS[bytes[at]] || String(bytes[at]) }
  if (type === 'pHYs' && length >= 9) {
    const x = view.getUint32(at, false)
    const y = view.getUint32(at + 4, false)
    return {
      value: bytes[at + 8] === 1 ? `${x} × ${y} px per metre (${Math.round(x * 0.0254)} dpi)` : `aspect ratio ${x}:${y}`,
      children: [
        field('Pixels per unit, X', at, 4, { value: x, kind: 'size' }),
        field('Pixels per unit, Y', at + 4, 4, { value: y, kind: 'size' }),
        field('Unit', at + 8, 1, { value: bytes[at + 8] === 1 ? '1 (metre)' : '0 (unknown)', kind: 'flags' })
      ]
    }
  }
  if (type === 'tIME' && length >= 7) {
    const pad = n => String(n).padStart(2, '0')
    return { value: `${view.getUint16(at, false)}-${pad(bytes[at + 2])}-${pad(bytes[at + 3])} ${pad(bytes[at + 4])}:${pad(bytes[at + 5])}:${pad(bytes[at + 6])} UTC` }
  }
  if (type === 'acTL' && length >= 8) {
    const plays = view.getUint32(at + 4, false)
    return { value: `${plural(view.getUint32(at, false), 'frame')}, ${plays === 0 ? 'loops forever' : plural(plays, 'play')}` }
  }
  if (type === 'IDAT' || type === 'fdAT') return { value: 'compressed image data' }
  return {}
}

function regionKind(type) {
  if (type === 'IDAT' || type === 'fdAT') return 'data'
  if (type === 'IHDR' || type === 'IEND') return 'header'
  return 'metadata'
}

function walkChunks(view, bytes) {
  const chunks = new FieldList(2000, 'chunks')
  const regions = []
  const warnings = []
  const badCrc = []
  let crcBudget = CRC_BUDGET
  let offset = 8
  let sawIEND = false
  let truncated = false
  let unverified = 0

  while (offset + 8 <= bytes.length && !sawIEND) {
    const length = view.getUint32(offset, false)
    const type = ascii(bytes, offset + 4, 4)
    const safeType = type.replace(/[^\x20-\x7E]/g, '?')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const complete = dataEnd + 4 <= bytes.length
    const end = Math.min(bytes.length, dataEnd + 4)
    if (!complete) truncated = true
    if (type === 'IEND' && complete) sawIEND = true

    let crcText
    let crcOk = null
    if (complete) {
      const stored = view.getUint32(dataEnd, false)
      if (crcBudget >= length) {
        crcBudget -= length
        const actual = crc32(bytes, offset + 4, dataEnd)
        crcOk = actual === stored
        crcText = crcOk ? `${hexOffset(stored)} (valid)` : `${hexOffset(stored)} (invalid, computed ${hexOffset(actual)})`
        if (!crcOk) badCrc.push(safeType)
      } else {
        unverified++
        crcText = `${hexOffset(stored)} (not verified)`
      }
    }

    const region = { name: `${safeType} chunk${type === 'IDAT' ? 's' : ''}`, offset, length: end - offset, kind: regionKind(type) }
    const last = regions[regions.length - 1]
    if (last && last.name === region.name && last.offset + last.length === offset) last.length += region.length
    else if (regions.length < 500) regions.push(region)

    if (chunks.full) {
      chunks.skip(offset, end - offset)
    } else {
      const children = [
        field('Length', offset, 4, { value: `${length.toLocaleString('en-US')} bytes`, kind: 'size', description: 'Size of the data part only: excludes the type and the CRC' }),
        field('Chunk type', offset + 4, 4, { value: `${safeType} (${chunkProperties(bytes, offset + 4)})`, kind: 'header', description: 'Four letters; the case of each letter is a property bit, and an upper-case first letter means critical' })
      ]
      const dataLength = Math.min(length, bytes.length - dataStart)
      let value
      if (dataLength > 0) {
        const decoded = complete ? decodeData(type, view, bytes, dataStart, length) : {}
        value = decoded.value
        children.push(field('Data', dataStart, dataLength, {
          value: decoded.value,
          kind: type === 'IDAT' || type === 'fdAT' ? 'data' : 'header',
          description: complete ? CHUNK_DESCRIPTIONS[type] || 'Chunk data' : 'Chunk data, cut off by the end of the file',
          children: decoded.children
        }))
      }
      if (complete) {
        children.push(field('CRC', dataEnd, 4, { value: crcText, kind: 'checksum', description: 'CRC-32 over the chunk type and data, not the length' }))
      }
      chunks.push(field(`${safeType} chunk`, offset, end - offset, {
        value: crcOk === false ? 'CRC mismatch' : value,
        kind: 'header',
        description: CHUNK_DESCRIPTIONS[type] || (bytes[offset + 4] & 0x20 ? 'Ancillary chunk: a decoder may skip it' : 'Critical chunk: a decoder must understand it'),
        children
      }))
    }
    if (!complete) break
    offset = end
  }

  if (badCrc.length) {
    const names = [...new Set(badCrc)].slice(0, 8).join(', ')
    warnings.push(`${plural(badCrc.length, 'chunk has', 'chunks have')} a CRC mismatch (${names})`)
  }
  if (unverified) warnings.push(`${plural(unverified, 'chunk CRC was', 'chunk CRCs were')} not verified to keep analysis fast`)
  if (truncated) warnings.push('File is truncated inside a chunk')
  else if (!sawIEND) warnings.push('No IEND chunk: the file may be truncated')

  const fields = chunks.toArray()
  if (sawIEND && offset < bytes.length) {
    fields.push(field('Trailing data', offset, bytes.length - offset, {
      kind: 'data',
      description: 'Bytes after IEND are ignored by decoders; they may be appended data or another file'
    }))
    regions.push({ name: 'Trailing data', offset, length: bytes.length - offset, kind: 'other' })
    warnings.push(`${plural(bytes.length - offset, 'byte')} of data after the IEND chunk`)
  }
  return { fields, regions, warnings }
}

function parsePNG(bytes) {
  const view = dataView(bytes)
  const summary = []
  const warnings = []
  const signatureLength = Math.min(8, bytes.length)
  const fields = signatureLength === 0 ? [] : [field('Signature', 0, signatureLength, {
    value: '\\x89PNG\\r\\n\\x1A\\n',
    kind: 'magic',
    description: 'Eight bytes chosen to identify PNG and to detect the usual ways a file gets damaged in transfer',
    children: SIGNATURE_PARTS
      .filter(([offset]) => offset < signatureLength)
      .map(([offset, length, value, description]) => field(
        length > 1 ? `Bytes ${offset}–${offset + length - 1}` : `Byte ${offset}`,
        offset,
        Math.min(length, signatureLength - offset),
        { value, description, kind: 'magic' }
      ))
  })]
  const regions = signatureLength === 0 ? [] : [{ name: 'Signature', offset: 0, length: signatureLength, kind: 'header' }]
  const result = () => ({ summary, fields, regions, warnings })

  // Signature (8) + chunk length (4) + chunk type (4) + IHDR data (13)
  if (bytes.length < 16) {
    warnings.push('File is truncated before the first chunk')
    return result()
  }

  const chunkLength = view.getUint32(8, false)
  const chunkType = ascii(bytes, 12, 4)
  const walked = walkChunks(view, bytes)
  fields.push(...walked.fields)
  regions.push(...walked.regions)

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
  warnings.push(...walked.warnings)
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
