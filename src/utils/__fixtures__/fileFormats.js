// Builders for small in-memory files used by the format parser tests

const encoder = new TextEncoder()

export function toArrayBuffer(bytes) {
  const array = Uint8Array.from(bytes)
  return array.buffer
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
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

function be(size, value) {
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  if (size === 2) view.setUint16(0, value, false)
  else view.setUint32(0, value, false)
  return out
}

function nameBytes(name) {
  return typeof name === 'string' ? encoder.encode(name) : Uint8Array.from(name)
}

/**
 * Builds a stored (uncompressed) ZIP archive. Each entry is
 * { name, data?, utf8?, method?, flags?, extra? } where `name` is a string
 * (encoded as UTF-8) or raw bytes. CRCs are left as zero.
 */
export function buildZip(entries, { dataDescriptor = false, comment = '', zip64 = false } = {}) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = nameBytes(entry.name)
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : Uint8Array.from(entry.data || [])
    const extra = entry.extra || new Uint8Array(0)
    let flags = entry.flags || 0
    if (entry.utf8) flags |= 0x0800
    if (dataDescriptor) flags |= 0x0008
    const method = entry.method || 0
    const localSize = dataDescriptor ? 0 : data.length

    const local = concat([
      le(4, 0x04034b50), le(2, 20), le(2, flags), le(2, method), le(2, 0), le(2, 0),
      le(4, 0), le(4, localSize), le(4, localSize), le(2, name.length), le(2, 0),
      name, data,
      dataDescriptor ? concat([le(4, 0x08074b50), le(4, 0), le(4, data.length), le(4, data.length)]) : new Uint8Array(0)
    ])
    const centralSize = entry.centralSize === undefined ? data.length : entry.centralSize
    centrals.push(concat([
      le(4, 0x02014b50), le(2, 20), le(2, 20), le(2, flags), le(2, method), le(2, 0), le(2, 0),
      le(4, 0), le(4, centralSize), le(4, centralSize), le(2, name.length), le(2, extra.length), le(2, 0),
      le(2, 0), le(2, 0), le(4, 0), le(4, offset), name, extra
    ]))
    locals.push(local)
    offset += local.length
  }

  const central = concat(centrals)
  const commentBytes = encoder.encode(comment)
  const parts = [...locals, central]
  if (zip64) {
    const zip64Offset = offset + central.length
    parts.push(concat([
      le(4, 0x06064b50), le(8, 44), le(2, 45), le(2, 45), le(4, 0), le(4, 0),
      le(8, entries.length), le(8, entries.length), le(8, central.length), le(8, offset)
    ]))
    parts.push(concat([le(4, 0x07064b50), le(4, 0), le(8, zip64Offset), le(4, 1)]))
  }
  parts.push(concat([
    le(4, 0x06054b50), le(2, 0), le(2, 0),
    le(2, zip64 ? 0xFFFF : entries.length), le(2, zip64 ? 0xFFFF : entries.length),
    le(4, zip64 ? 0xFFFFFFFF : central.length), le(4, zip64 ? 0xFFFFFFFF : offset),
    le(2, commentBytes.length), commentBytes
  ]))
  return concat(parts).buffer
}

/** ZIP64 extended information extra field holding the given 64-bit values */
export function zip64Extra(...values) {
  return concat([le(2, 0x0001), le(2, values.length * 8), ...values.map(value => le(8, value))])
}

export function truncate(buffer, length) {
  return buffer.slice(0, length)
}

export function buildPNG({ width = 640, height = 480, bitDepth = 8, colorType = 6, interlace = 0, firstChunk = 'IHDR' } = {}) {
  const ihdr = concat([be(4, width), be(4, height), Uint8Array.from([bitDepth, colorType, 0, 0, interlace])])
  return concat([
    Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    be(4, 13), encoder.encode(firstChunk), ihdr, be(4, 0),
    be(4, 0), encoder.encode('IEND'), be(4, 0)
  ]).buffer
}

export function buildGIF({ version = '89a', width = 320, height = 200, flags = 0xF7, background = 3 } = {}) {
  return concat([
    encoder.encode('GIF' + version), le(2, width), le(2, height),
    Uint8Array.from([flags, background, 0])
  ]).buffer
}

function jpegSegment(marker, payload) {
  return concat([Uint8Array.from([0xFF, marker]), be(2, payload.length + 2), Uint8Array.from(payload)])
}

/**
 * Minimal JPEG: SOI, APP0, DQT, DHT (0xC4) and DAC (0xCC) segments before the
 * frame header, so a parser that treats any 0xFFCx as SOF reads them wrongly.
 */
export function buildJPEG({ width = 800, height = 600, sof = 0xC0, components = 3 } = {}) {
  const sofPayload = [8, (height >> 8) & 0xFF, height & 0xFF, (width >> 8) & 0xFF, width & 0xFF, components]
  for (let i = 0; i < components; i++) sofPayload.push(i + 1, 0x11, 0)
  return concat([
    Uint8Array.from([0xFF, 0xD8]),
    jpegSegment(0xE0, [...encoder.encode('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    jpegSegment(0xDB, [0, ...new Array(64).fill(1)]),
    jpegSegment(0xC4, [0x00, ...new Array(16).fill(0), 0x12, 0x34]),
    jpegSegment(0xCC, [0x00, 0x10]),
    Uint8Array.from([0xFF, 0xFF]), // fill bytes before the next marker
    jpegSegment(sof, sofPayload),
    jpegSegment(0xDA, [1, 1, 0, 0, 63, 0]),
    Uint8Array.from([0x00, 0x00, 0xFF, 0xD9])
  ]).buffer
}

export function buildPDF(body) {
  return encoder.encode(body).buffer
}

export const SIMPLE_PDF = `%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R >>
endobj
9 0 obj
<< /Type /Outlines /Count 12 /Title (Bookmark title) >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 3 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R >>
endobj
5 0 obj
<< /Type /Pages /Parent 2 0 R /Kids [6 0 R 7 0 R] /Count 2 >>
endobj
4 0 obj
<< /Title (Report \\(draft\\) \\101) /Author <FEFF00C9006D0069006C0065> /Producer (handmade) /CreationDate (D:20250101120000+02'00') >>
endobj
trailer
<< /Size 10 /Root 1 0 R /Info 4 0 R >>
%%EOF
`

/** Java class file header: magic, minor, major, then a stub constant pool count */
export function buildJavaClass({ major = 52, minor = 0 } = {}) {
  return concat([be(4, 0xCAFEBABE), be(2, minor), be(2, major), be(2, 1)]).buffer
}

/** Universal (fat) Mach-O header with the given architecture count */
export function buildFatMachO(archCount = 2) {
  const archs = []
  for (let i = 0; i < archCount; i++) archs.push(be(4, 0x01000007), be(4, 3), be(4, 0x1000 * (i + 1)), be(4, 0x100), be(4, 12))
  return concat([be(4, 0xCAFEBABE), be(4, archCount), ...archs]).buffer
}
