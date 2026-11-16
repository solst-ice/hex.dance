// Fixtures for the structure (field tree) tests: small but complete files
// with valid checksums, built in code.

import { crc32 } from '../../lib/crc32.js'

const encoder = new TextEncoder()

export function concat(parts) {
  const arrays = parts.map(part => (part instanceof Uint8Array ? part : Uint8Array.from(part)))
  const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of arrays) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const text = value => encoder.encode(value)

function be(size, value) {
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  if (size === 1) out[0] = value
  else if (size === 2) view.setUint16(0, value, false)
  else view.setUint32(0, value, false)
  return out
}

function le(size, value) {
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  if (size === 2) view.setUint16(0, value, true)
  else if (size === 4) view.setUint32(0, value, true)
  else view.setBigUint64(0, BigInt(value), true)
  return out
}

export function pngChunk(type, data, { badCrc = false } = {}) {
  const body = concat([text(type), data])
  const crc = crc32(body, 0, body.length) ^ (badCrc ? 1 : 0)
  return concat([be(4, data.length), body, be(4, crc >>> 0)])
}

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

/** A 2×2 RGB PNG with text chunks, valid CRCs and optional trailing bytes */
export function buildFullPNG({ trailing = null, badCrc = false, idatChunks = 1 } = {}) {
  const ihdr = concat([be(4, 2), be(4, 2), [8, 2, 0, 0, 0]])
  // zlib stream of two stored scanlines (filter byte + 6 bytes each)
  const raw = [0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]
  const zlib = concat([[0x78, 0x01, 0x01, raw.length, 0, raw.length ^ 0xFF, 0xFF], raw, [0, 0, 0, 0]])
  const parts = [
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', concat([text('Title'), [0], text('Hex dance')])),
    pngChunk('iTXt', concat([text('Comment'), [0, 0, 0], text('en'), [0], text('Kommentar'), [0], text('ünïcode')])),
    pngChunk('zTXt', concat([text('Author'), [0, 0], [0x78, 0x9C, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]])),
    pngChunk('pHYs', concat([be(4, 2835), be(4, 2835), [1]])),
    pngChunk('tIME', concat([be(2, 2024), [2, 29, 12, 30, 45]]))
  ]
  for (let i = 0; i < idatChunks; i++) parts.push(pngChunk('IDAT', i === 0 ? zlib : new Uint8Array(0)))
  parts.push(pngChunk('IEND', new Uint8Array(0), { badCrc }))
  if (trailing) parts.push(text(trailing))
  return concat(parts)
}

function jpegSegment(marker, payload) {
  return concat([[0xFF, marker], be(2, payload.length + 2), payload])
}

/** JPEG with JFIF, Exif, COM, DQT, DHT, SOF0, DRI, SOS, scan data with stuffed bytes and restart markers, EOI and trailing data */
export function buildFullJPEG({ trailing = null, progressive = false } = {}) {
  const exif = concat([text('Exif'), [0, 0], text('MM'), be(2, 42), be(4, 8), [0, 0]])
  const counts = new Array(16).fill(0)
  counts[0] = 2
  const scan = (body) => concat([
    jpegSegment(0xDA, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]),
    body
  ])
  return concat([
    [0xFF, 0xD8],
    jpegSegment(0xE0, concat([text('JFIF'), [0, 1, 2, 1], be(2, 72), be(2, 72), [0, 0]])),
    jpegSegment(0xE1, exif),
    jpegSegment(0xFE, text('made by hand')),
    jpegSegment(0xDB, concat([[0x00], new Array(64).fill(2), [0x11], new Array(128).fill(1)])),
    jpegSegment(0xC4, concat([[0x00], counts, [5, 6]])),
    [0xFF, 0xFF],
    jpegSegment(progressive ? 0xC2 : 0xC0, [8, 0, 16, 0, 32, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    jpegSegment(0xDD, be(2, 4)),
    scan(Uint8Array.from([0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0xFF, 0xD1, 0x78])),
    progressive ? scan(Uint8Array.from([0x9A, 0xFF, 0x00])) : new Uint8Array(0),
    [0xFF, 0xD9],
    trailing ? text(trailing) : new Uint8Array(0)
  ])
}

function subBlocks(data) {
  const parts = []
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255)
    parts.push([chunk.length], chunk)
  }
  parts.push([0])
  return concat(parts)
}

/** Animated GIF89a: global colour table, NETSCAPE loop, comment, `frames` frames with graphic control, trailer */
export function buildFullGIF({ frames = 2, trailing = null, localTable = true } = {}) {
  const parts = [
    text('GIF89a'), le(2, 4), le(2, 4), [0xF1, 0, 0],
    new Array(12).fill(0x80),
    [0x21, 0xFF, 11], text('NETSCAPE2.0'), [3, 1], le(2, 0), [0],
    [0x21, 0xFE], subBlocks(text('hello from the comment block'))
  ]
  for (let i = 0; i < frames; i++) {
    parts.push([0x21, 0xF9, 4, 0x09], le(2, 10), [1, 0])
    const local = localTable && i === 1
    parts.push([0x2C], le(2, 0), le(2, 0), le(2, 4), le(2, 4), [local ? 0x80 : 0x00])
    if (local) parts.push(new Array(6).fill(0x40))
    parts.push([2], subBlocks(Uint8Array.from(new Array(300).fill(0x44))))
  }
  parts.push([0x3B])
  if (trailing) parts.push(text(trailing))
  return concat(parts)
}

/**
 * ZIP with stored entries and real CRCs. Options: prefix (bytes before the
 * archive), dataDescriptor, comment, zip64 end records, trailing bytes.
 */
export function buildFullZip(entries, { prefix = null, dataDescriptor = false, comment = '', zip64 = false, trailing = null } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = text(entry.name)
    const data = typeof entry.data === 'string' ? text(entry.data) : Uint8Array.from(entry.data || [])
    const crc = crc32(data, 0, data.length)
    const flags = dataDescriptor ? 0x0008 : 0
    const extra = entry.extra || new Uint8Array(0)
    const local = concat([
      le(4, 0x04034b50), le(2, 20), le(2, flags), le(2, 0), le(2, 0x6000), le(2, 0x5821),
      le(4, dataDescriptor ? 0 : crc), le(4, dataDescriptor ? 0 : data.length), le(4, dataDescriptor ? 0 : data.length),
      le(2, name.length), le(2, extra.length), name, extra, data,
      dataDescriptor ? concat([le(4, 0x08074b50), le(4, crc), le(4, data.length), le(4, data.length)]) : new Uint8Array(0)
    ])
    centrals.push(concat([
      le(4, 0x02014b50), le(2, 0x031E), le(2, 20), le(2, flags), le(2, 0), le(2, 0x6000), le(2, 0x5821),
      le(4, crc), le(4, data.length), le(4, data.length), le(2, name.length), le(2, 0), le(2, 0),
      le(2, 0), le(2, 0), le(4, (0o100644 << 16) >>> 0), le(4, offset), name
    ]))
    locals.push(local)
    offset += local.length
  }
  const central = concat(centrals)
  const commentBytes = text(comment)
  const parts = [prefix || new Uint8Array(0), ...locals, central]
  if (zip64) {
    const zip64Offset = offset + central.length
    parts.push(concat([
      le(4, 0x06064b50), le(8, 44), le(2, 45), le(2, 45), le(4, 0), le(4, 0),
      le(8, entries.length), le(8, entries.length), le(8, central.length), le(8, offset)
    ]))
    parts.push(concat([le(4, 0x07064b50), le(4, 0), le(8, zip64Offset), le(4, 1)]))
  }
  parts.push(concat([
    le(4, 0x06054b50), le(2, 0), le(2, 0), le(2, entries.length), le(2, entries.length),
    le(4, central.length), le(4, offset), le(2, commentBytes.length), commentBytes
  ]))
  if (trailing) parts.push(text(trailing))
  return concat(parts)
}

/** PDF with a stream object, an xref table whose offsets are correct, trailer and startxref */
export function buildFullPDF({ binaryMarker = true } = {}) {
  let body = '%PDF-1.4\n' + (binaryMarker ? '%\xE2\xE3\xCF\xD3\n' : '')
  const offsets = []
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    '<< /Length 21 >>\nstream\nBT (endobj) Tj ET q Q\nendstream',
    '(A string object)'
  ]
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefAt = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Uint8Array.from(body, ch => ch.charCodeAt(0))
}

/** A class file with a few constants, one field, one method and a SourceFile attribute */
export function buildFullClass({ extraConstants = 0 } = {}) {
  const utf8 = value => concat([[1], be(2, text(value).length), text(value)])
  const pool = [
    utf8('Demo'), // 1
    [7, 0, 1], // 2 Class Demo
    utf8('java/lang/Object'), // 3
    [7, 0, 3], // 4
    utf8('count'), // 5
    utf8('I'), // 6
    utf8('run'), // 7
    utf8('()V'), // 8
    utf8('Code'), // 9
    utf8('SourceFile'), // 10
    utf8('Demo.java'), // 11
    concat([[5], be(4, 0xFFFFFFFF), be(4, 0xFFFFFFFE)]) // 12-13 Long -2
  ]
  for (let i = 0; i < extraConstants; i++) pool.push([3, 0, 0, (i >> 8) & 0xFF, i & 0xFF])
  const count = 14 + extraConstants
  const code = concat([be(2, 0), be(2, 1), be(4, 1), [0xB1], be(2, 0), be(2, 0)])
  return concat([
    be(4, 0xCAFEBABE), be(2, 0), be(2, 52), be(2, count), ...pool,
    be(2, 0x0021), be(2, 2), be(2, 4), be(2, 0),
    be(2, 1), be(2, 0x0002), be(2, 5), be(2, 6), be(2, 0),
    be(2, 1), be(2, 0x0001), be(2, 7), be(2, 8), be(2, 1), be(2, 9), be(4, code.length), code,
    be(2, 1), be(2, 10), be(4, 2), be(2, 11)
  ])
}
