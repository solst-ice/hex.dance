import { ByteReader, field, fitted, formatDate, formatNumber, latin1, plural, printable, utf16 } from './reader.js'
import { formatBytes, item } from './shared.js'

const MAX_KEYS = 40
// Seconds between 1970-01-01 and 2001-01-01 (Core Data reference date)
const APPLE_EPOCH = 978307200

function readSized(r, offset, size) {
  let value = 0
  for (let i = 0; i < size; i++) value = value * 256 + r.u8(offset + i)
  return value
}

function parseBplist(bytes) {
  const r = new ByteReader(bytes, false)
  const warnings = []
  const regions = []
  const summary = []
  const version = latin1(bytes, 6, 2)
  const fields = [field('Header', 0, Math.min(8, bytes.length), `bplist${printable(version)}`, 'Binary property list signature and version', 'magic')]
  if (bytes.length < 40) {
    warnings.push('File is too short for a trailer')
    return { summary, fields, warnings }
  }
  const t = bytes.length - 32
  const offsetSize = r.u8(t + 6)
  const refSize = r.u8(t + 7)
  const count = r.u64(t + 8)
  const top = r.u64(t + 16)
  const tableOffset = r.u64(t + 24)
  const trailer = field('Trailer', t, 32, `${plural(count, 'object')}`, 'Sizes and locations needed to read the objects', 'header', [
    field('Unused', t, 5, undefined, 'Zero', 'padding'),
    field('Sort version', t + 5, 1, r.u8(t + 5), 'Unused'),
    field('Offset size', t + 6, 1, offsetSize, 'Bytes per offset table entry', 'size'),
    field('Object reference size', t + 7, 1, refSize, 'Bytes per object reference', 'size'),
    field('Object count', t + 8, 8, formatNumber(count), 'Objects in the file', 'count'),
    field('Top object', t + 16, 8, top, 'Index of the root object'),
    field('Offset table offset', t + 24, 8, formatNumber(tableOffset), 'Where the offset table starts', 'offset')
  ])
  const valid = offsetSize >= 1 && offsetSize <= 8 && refSize >= 1 && refSize <= 8 && count > 0 && top < count && tableOffset >= 8 && tableOffset + count * offsetSize <= t
  if (!valid) {
    warnings.push('The trailer is invalid; the file may be truncated')
    fields.push(trailer)
    return { formatName: 'Binary Property List', summary, fields, regions, warnings }
  }
  fields.push(field('Objects', 8, tableOffset - 8, plural(count, 'object'), 'Encoded values', 'data'))
  fields.push(field('Offset table', tableOffset, count * offsetSize, plural(count, 'entry', 'entries'), 'File offset of each object', 'table'))
  fields.push(trailer)
  regions.push({ name: 'Header', offset: 0, length: 8, kind: 'header' }, { name: 'Objects', offset: 8, length: tableOffset - 8, kind: 'data' },
    { name: 'Offset table', offset: tableOffset, length: count * offsetSize, kind: 'table' }, { name: 'Trailer', offset: t, length: 32, kind: 'metadata' })

  const objectOffset = index => (index < count ? readSized(r, tableOffset + index * offsetSize, offsetSize) : -1)
  // Marker byte, plus the length that may follow in an int object
  const header = offset => {
    if (offset < 8 || offset >= tableOffset) return null
    const marker = r.u8(offset)
    let length = marker & 0x0F
    let start = offset + 1
    const type = marker >> 4
    if (length === 0x0F && type !== 0 && type !== 1 && type !== 2 && type !== 3) {
      const intMarker = r.u8(start)
      if (intMarker >> 4 !== 1) return null
      const size = 1 << (intMarker & 0x0F)
      length = readSized(r, start + 1, Math.min(size, 8))
      start += 1 + size
    }
    return { type, marker, length, start }
  }
  const describe = (index, depth) => {
    const h = header(objectOffset(index))
    if (!h) return { kind: 'invalid', text: 'invalid reference' }
    const { type, marker, length, start } = h
    if (marker === 0x00) return { kind: 'null', text: 'null' }
    if (marker === 0x08) return { kind: 'bool', text: 'false' }
    if (marker === 0x09) return { kind: 'bool', text: 'true' }
    if (type === 1) {
      const size = 1 << (marker & 0x0F)
      if (size === 16) return { kind: 'integer', text: 'integer (128-bit)' }
      return { kind: 'integer', text: String(size === 8 ? r.u64big(start) : readSized(r, start, size)) }
    }
    if (type === 2) {
      const size = 1 << (marker & 0x0F)
      const value = size === 4 ? r.view.getFloat32(start, false) : size === 8 && r.has(start, 8) ? r.view.getFloat64(start, false) : NaN
      return { kind: 'real', text: String(+value.toPrecision(10)) }
    }
    if (marker === 0x33 && r.has(start, 8)) return { kind: 'date', text: formatDate(new Date((r.view.getFloat64(start, false) + APPLE_EPOCH) * 1000)) }
    if (type === 4) return { kind: 'data', text: `data, ${formatBytes(length)}` }
    if (type === 5) return { kind: 'string', text: `"${printable(latin1(bytes, start, Math.min(length, 200)), 80)}"`, raw: latin1(bytes, start, Math.min(length, 200)) }
    if (type === 6) return { kind: 'string', text: `"${printable(utf16(bytes, start, Math.min(length, 200) * 2, false), 80)}"`, raw: utf16(bytes, start, Math.min(length, 200) * 2, false) }
    if (type === 7) return { kind: 'string', text: `"${printable(new TextDecoder().decode(bytes.subarray(start, start + Math.min(length, 200))), 80)}"` }
    if (type === 8) return { kind: 'uid', text: `UID ${readSized(r, start, (marker & 0x0F) + 1)}` }
    if (type === 0xA) return { kind: 'array', text: `array of ${plural(length, 'item')}`, length, start }
    if (type === 0xC) return { kind: 'set', text: `set of ${plural(length, 'item')}`, length, start }
    if (type === 0xD) {
      const result = { kind: 'dictionary', text: `dictionary of ${plural(length, 'key')}`, length, start, entries: [] }
      if (depth === 0) {
        for (let i = 0; i < Math.min(length, MAX_KEYS); i++) {
          const key = describe(readSized(r, start + i * refSize, refSize), 1)
          const value = describe(readSized(r, start + (length + i) * refSize, refSize), 1)
          result.entries.push([key.raw !== undefined ? printable(key.raw, 80) : key.text, value.text])
        }
      }
      return result
    }
    return { kind: 'unknown', text: `unknown marker 0x${marker.toString(16)}` }
  }
  const root = describe(top, 0)
  summary.push(item('Version', `bplist${printable(version)}`))
  summary.push(item('Objects', formatNumber(count)))
  summary.push(item('Root', root.text))
  summary.push(item('Offset Size', plural(offsetSize, 'byte')))
  summary.push(item('Reference Size', plural(refSize, 'byte')))
  if (root.entries) {
    root.entries.forEach(([key, value]) => summary.push(item(key, value, null, 'Root keys')))
    if (root.length > MAX_KEYS) summary.push(item('…', `${formatNumber(root.length - MAX_KEYS)} more keys`, null, 'Root keys'))
    if (root.entries.some(([key]) => key === '$archiver')) summary.push(item('Encoding', 'NSKeyedArchiver archive'))
  }
  return { formatName: 'Binary Property List', summary, fields, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'bplist',
  name: 'Binary Property List',
  category: 'data',
  detect: bytes => bytes.length >= 8 && latin1(bytes, 0, 7) === 'bplist0',
  parse: fitted(parseBplist)
}
