import { ByteReader, capFields, crc32, field, fitted, formatNumber, hex32, plural, readULEB } from './reader.js'
import { formatBytes, item } from './shared.js'

const MAGIC = [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]
const CHECKS = { 0: 'None', 1: 'CRC32', 4: 'CRC64', 10: 'SHA-256' }
const CHECK_SIZES = { 0: 0, 1: 4, 4: 8, 10: 32 }
const FILTERS = { 0x21: 'LZMA2', 0x03: 'Delta', 0x04: 'BCJ x86', 0x05: 'BCJ PowerPC', 0x06: 'BCJ IA-64', 0x07: 'BCJ ARM', 0x08: 'BCJ ARM-Thumb', 0x09: 'BCJ SPARC', 0x0A: 'BCJ ARM64', 0x0B: 'BCJ RISC-V' }
const MAX_RECORDS = 100000
const MAX_STREAMS = 64

const isMagic = (bytes, offset) => MAGIC.every((byte, i) => bytes[offset + i] === byte)

// Reads one stream whose footer ends at `end`; returns null if it is not a valid xz stream
function readStreamBackwards(r, end, warnings) {
  const { bytes } = r
  const footer = end - 12
  if (footer < 12 || bytes[end - 2] !== 0x59 || bytes[end - 1] !== 0x5A) return null
  const backward = (r.u32(footer + 4) + 1) * 4
  const footerFlags = r.u8(footer + 9)
  const footerCrcOk = crc32(bytes, footer + 4, footer + 10) === r.u32(footer)
  const indexStart = footer - backward
  if (indexStart < 12 || r.u8(indexStart) !== 0) return null
  // Index: indicator, record count, records (unpadded size, uncompressed size), padding, CRC32
  let pos = indexStart + 1
  const count = readULEB(bytes, pos, footer, 9)
  if (!count) return null
  pos = count.next
  const records = []
  let blocksSize = 0
  let uncompressed = 0
  for (let i = 0; i < count.value && i < MAX_RECORDS; i++) {
    const unpadded = readULEB(bytes, pos, footer, 9)
    if (!unpadded) return null
    const size = readULEB(bytes, unpadded.next, footer, 9)
    if (!size) return null
    pos = size.next
    records.push({ unpadded: unpadded.value, size: size.value })
    blocksSize += Math.ceil(unpadded.value / 4) * 4
    uncompressed += size.value
  }
  const indexCrcAt = footer - 4
  const indexCrcOk = crc32(bytes, indexStart, indexCrcAt) === r.u32(indexCrcAt)
  const start = indexStart - blocksSize - 12
  if (start < 0 || !isMagic(bytes, start)) return null
  const headerFlags = r.u8(start + 7)
  if (headerFlags !== footerFlags) warnings.push('Stream header and footer flags differ')
  if (!footerCrcOk) warnings.push('Stream footer CRC32 does not match')
  if (!indexCrcOk) warnings.push('Index CRC32 does not match')
  return { start, end, indexStart, footer, records, count: count.value, uncompressed, check: headerFlags & 0x0F, indexCrcOk, footerCrcOk }
}

function blockHeader(r, offset, end) {
  const sizeByte = r.u8(offset)
  if (sizeByte === 0) return null
  const size = (sizeByte + 1) * 4
  if (offset + size > end) return null
  const flags = r.u8(offset + 1)
  const filterCount = (flags & 3) + 1
  let pos = offset + 2
  const read = () => {
    const v = readULEB(r.bytes, pos, offset + size - 4, 9)
    if (v) pos = v.next
    return v ? v.value : null
  }
  const compressed = flags & 0x40 ? read() : null
  const uncompressed = flags & 0x80 ? read() : null
  const filters = []
  for (let i = 0; i < filterCount; i++) {
    const id = read()
    const propsSize = read()
    if (id === null || propsSize === null) break
    let detail = ''
    if (id === 0x21 && propsSize === 1) {
      const bits = r.u8(pos)
      const dict = bits > 40 ? NaN : (2 | (bits & 1)) * 2 ** (Math.floor(bits / 2) + 11)
      detail = ` (dictionary ${formatBytes(bits === 40 ? 0xFFFFFFFF : dict)})`
    }
    pos += propsSize
    filters.push(`${FILTERS[id] || `filter 0x${(id || 0).toString(16)}`}${detail}`)
  }
  const crcOk = crc32(r.bytes, offset, offset + size - 4) === r.u32(offset + size - 4)
  return { size, filters, compressed, uncompressed, crcOk }
}

function parseXZ(bytes) {
  const r = new ByteReader(bytes, true)
  const warnings = []
  const regions = []
  const summary = []
  const flags = r.u8(7)
  const check = flags & 0x0F
  const headerCrcOk = bytes.length >= 12 && crc32(bytes, 6, 8) === r.u32(8)
  const headerField = field('Stream header', 0, Math.min(12, bytes.length), undefined, 'xz stream header', 'header', [
    field('Magic', 0, 6, 'FD 37 7A 58 5A 00', 'xz signature', 'magic'),
    field('Stream flags', 6, 2, `check: ${CHECKS[check] || `unknown (${check})`}`, 'Integrity check type', 'flags'),
    field('CRC32', 8, 4, `${hex32(r.u32(8))}${bytes.length >= 12 ? (headerCrcOk ? ' (valid)' : ' (mismatch)') : ''}`, 'Of the stream flags', 'checksum')
  ])
  if (bytes.length < 12) {
    warnings.push('File is truncated inside the stream header')
    return { summary, fields: [headerField], warnings }
  }
  if (!headerCrcOk) warnings.push('Stream header CRC32 does not match')

  // Streams are read from the end; zero padding may sit between and after them
  const streams = []
  let end = bytes.length
  while (end > 0 && streams.length < MAX_STREAMS) {
    let padded = end
    while (padded > 0 && bytes[padded - 1] === 0 && end - padded < 1024 * 1024) padded--
    padded = end - Math.floor((end - padded) / 4) * 4
    const stream = readStreamBackwards(r, padded, warnings)
    if (!stream) break
    stream.padding = end - padded
    streams.unshift(stream)
    end = stream.start
  }

  const fields = []
  if (!streams.length || streams[0].start !== 0) {
    fields.push(headerField)
    const firstBlock = blockHeader(r, 12, bytes.length)
    if (firstBlock) fields.push(field('Block 1 header', 12, firstBlock.size, firstBlock.filters.join(' + '), 'Block header', 'header'))
    warnings.push(streams.length ? 'Data before the first complete stream could not be read' : 'No valid stream footer and index at the end of the file (truncated?)')
    summary.push(item('Integrity Check', CHECKS[check] || `Unknown (${check})`))
    if (firstBlock) summary.push(item('Filters', firstBlock.filters.join(' + ')))
    return { summary, fields, regions, warnings }
  }

  let totalUncompressed = 0
  let totalBlocks = 0
  const filterSet = new Set()
  const streamFields = streams.map((stream, index) => {
    const children = index === 0 ? [headerField] : [field('Stream header', stream.start, 12, undefined, 'xz stream header', 'header')]
    let pos = stream.start + 12
    const blockFields = []
    stream.records.forEach((record, i) => {
      const padded = Math.ceil(record.unpadded / 4) * 4
      if (i < 64) {
        const header = blockHeader(r, pos, stream.indexStart)
        if (header) {
          header.filters.forEach(name => filterSet.add(name))
          if (!header.crcOk) warnings.push(`Block ${i + 1} header CRC32 does not match`)
        }
        const checkSize = CHECK_SIZES[stream.check] || 0
        const blockChildren = header ? [field('Block header', pos, header.size, header.filters.join(' + '), 'Size, flags and filter chain', 'header')] : []
        if (header && record.unpadded - header.size - checkSize > 0) blockChildren.push(field('Compressed data', pos + header.size, record.unpadded - header.size - checkSize, formatBytes(record.unpadded - header.size - checkSize), 'Filtered data', 'data'))
        if (checkSize && padded >= checkSize) blockChildren.push(field('Check', pos + padded - checkSize, checkSize, CHECKS[stream.check], 'Of the uncompressed data', 'checksum'))
        blockFields.push(field(`Block ${i + 1}`, pos, padded, `${formatBytes(record.unpadded)} → ${formatBytes(record.size)}`, 'Compressed block', 'header', blockChildren))
      } else {
        blockFields.push({ name: '', offset: pos, length: padded })
      }
      pos += padded
    })
    children.push(...capFields(blockFields, 64, 'more blocks'))
    children.push(field('Index', stream.indexStart, stream.footer - stream.indexStart, plural(stream.count, 'record'), 'Sizes of every block, for random access', 'table', [
      field('Indicator', stream.indexStart, 1, '0x00', 'Marks the index', 'magic'),
      field('CRC32', stream.footer - 4, 4, stream.indexCrcOk ? 'valid' : 'mismatch', 'Of the index', 'checksum')
    ]))
    children.push(field('Stream footer', stream.footer, 12, undefined, 'Backward size, flags and "YZ"', 'header', [
      field('CRC32', stream.footer, 4, stream.footerCrcOk ? 'valid' : 'mismatch', 'Of backward size and flags', 'checksum'),
      field('Backward size', stream.footer + 4, 4, formatNumber(stream.footer - stream.indexStart), 'Index size, stored as size/4 - 1', 'size'),
      field('Stream flags', stream.footer + 8, 2, CHECKS[stream.check], 'Copy of the header flags', 'flags'),
      field('Footer magic', stream.footer + 10, 2, 'YZ', 'End of stream', 'magic')
    ]))
    if (stream.padding) children.push(field('Stream padding', stream.end - stream.padding, stream.padding, formatBytes(stream.padding), 'Zero bytes after the stream', 'padding'))
    totalUncompressed += stream.uncompressed
    totalBlocks += stream.count
    regions.push({ name: 'Blocks', offset: stream.start, length: stream.indexStart - stream.start, kind: 'data' })
    regions.push({ name: 'Index and footer', offset: stream.indexStart, length: stream.end - stream.indexStart, kind: 'metadata' })
    return { field: field(`Stream ${index + 1}`, stream.start, stream.end - stream.start, formatBytes(stream.uncompressed), 'xz stream', 'header', children), children }
  })
  const fields2 = streams.length === 1 ? streamFields[0].children : streamFields.map(entry => entry.field)

  summary.push(item('Uncompressed Size', `${formatBytes(totalUncompressed)} (${formatNumber(totalUncompressed)} bytes)`, ['From the stream index']))
  if (totalUncompressed > 0) summary.push(item('Compression Ratio', `${((bytes.length / totalUncompressed) * 100).toFixed(1)}%`))
  const checks = [...new Set(streams.map(stream => CHECKS[stream.check] || `Unknown (${stream.check})`))]
  summary.push(item('Integrity Check', checks.join(', ')))
  if (filterSet.size) summary.push(item('Filters', [...filterSet].join(', ')))
  summary.push(item('Blocks', formatNumber(totalBlocks)))
  if (streams.length > 1) summary.push(item('Streams', formatNumber(streams.length)))
  return { summary, fields: fields2, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'xz',
  name: 'xz Compressed Data',
  category: 'compressed',
  detect: bytes => bytes.length >= 6 && isMagic(bytes, 0),
  parse: fitted(parseXZ)
}
