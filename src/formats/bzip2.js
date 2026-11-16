import { capFields, field, fitted, formatNumber, hex32, nonOverlapping, plural } from './reader.js'
import { formatBytes, item } from './shared.js'

// Blocks are not byte-aligned; their 48-bit magic numbers are found by a
// bit-level scan of at most this many bytes.
const SCAN_LIMIT = 16 * 1024 * 1024
const MAX_BLOCKS = 100000
const BLOCK_MAGIC = [0x314159, 0x265359]
const EOS_MAGIC = [0x177245, 0x385090]

// Reads `count` (≤ 24) bits starting at bit position `bit`, most significant first
function bitsAt(bytes, bit, count) {
  let value = 0
  for (let i = 0; i < count; i++) {
    const position = bit + i
    const byte = bytes[position >> 3]
    value = (value << 1) | ((byte >> (7 - (position & 7))) & 1)
  }
  return value
}

function matches(bytes, bit, magic) {
  return bit + 48 <= bytes.length * 8 && bitsAt(bytes, bit, 24) === magic[0] && bitsAt(bytes, bit + 24, 24) === magic[1]
}

// For each byte value, the (shift, magic) pairs whose pattern would have that
// value as its second byte; one lookup per byte rules out most positions
let candidates = null
function candidateTable() {
  if (!candidates) {
    candidates = Array.from({ length: 256 }, () => [])
    for (const [m, magic] of [[0, BLOCK_MAGIC], [1, EOS_MAGIC]]) {
      for (let shift = 0; shift < 8; shift++) candidates[(magic[0] >> (8 + shift)) & 0xFF].push({ shift, m })
    }
  }
  return candidates
}

/** Bit offsets of block and end-of-stream markers */
function scan(bytes, start, limit) {
  const markers = []
  const table = candidateTable()
  const end = Math.min(bytes.length - 6, start + limit)
  for (let i = start; i < end && markers.length < MAX_BLOCKS; i++) {
    const list = table[bytes[i + 1]]
    if (list.length === 0) continue
    for (const { shift, m } of list) {
      const bit = i * 8 + shift
      if (matches(bytes, bit, m === 0 ? BLOCK_MAGIC : EOS_MAGIC)) markers.push({ bit, eos: m === 1 })
    }
  }
  return { markers, complete: end >= bytes.length - 6 }
}

function isStreamHeader(bytes, offset) {
  return bytes[offset] === 0x42 && bytes[offset + 1] === 0x5A && bytes[offset + 2] === 0x68 && bytes[offset + 3] >= 0x31 && bytes[offset + 3] <= 0x39
}

function parseBzip2(bytes) {
  const warnings = []
  const regions = []
  const summary = []
  const level = bytes[3] - 0x30
  const fields = [field('Stream header', 0, Math.min(4, bytes.length), `BZh${level}`, 'Signature and block size', 'header', [
    field('Magic', 0, 3, 'BZh', 'bzip2 signature (h = Huffman coding)', 'magic'),
    field('Block size', 3, 1, `${level} (${level * 100} kB)`, 'Uncompressed block size in units of 100 kB', 'size')
  ])]
  regions.push({ name: 'Stream header', offset: 0, length: Math.min(4, bytes.length), kind: 'header' })
  const { markers, complete } = scan(bytes, 4, SCAN_LIMIT)
  const blocks = markers.filter(marker => !marker.eos)
  const ends = markers.filter(marker => marker.eos)
  let streams = 1
  for (const eos of ends) {
    const next = Math.ceil((eos.bit + 80) / 8)
    if (isStreamHeader(bytes, next)) streams++
  }

  const items = []
  markers.forEach((marker, index) => {
    const startByte = marker.bit >> 3
    const nextMarker = markers[index + 1]
    let endByte = nextMarker ? nextMarker.bit >> 3 : complete ? bytes.length : Math.min(bytes.length, 4 + SCAN_LIMIT)
    if (marker.eos) endByte = Math.min(bytes.length, Math.ceil((marker.bit + 80) / 8))
    if (endByte <= startByte) return
    const crc = marker.bit + 80 <= bytes.length * 8 ? ((bitsAt(bytes, marker.bit + 48, 16) * 0x10000) + bitsAt(bytes, marker.bit + 64, 16)) >>> 0 : null
    const aligned = (marker.bit & 7) === 0 ? 'byte-aligned' : `bit ${marker.bit & 7} of the byte`
    if (marker.eos) {
      items.push(field('End of stream', startByte, endByte - startByte, crc === null ? 'truncated' : `combined CRC ${hex32(crc)}`, `End-of-stream magic 0x177245385090 (${aligned}) and combined CRC`, 'header'))
    } else {
      items.push(field(`Block ${items.filter(entry => entry.name.startsWith('Block')).length + 1}`, startByte, endByte - startByte, crc === null ? undefined : `CRC ${hex32(crc)}`, `Block magic 0x314159265359 (${aligned}), block CRC and Huffman-coded data`, 'data'))
    }
    // A new stream header follows an end-of-stream marker in concatenated files
    if (marker.eos && isStreamHeader(bytes, endByte)) {
      items.push(field('Stream header', endByte, 4, `BZh${bytes[endByte + 3] - 0x30}`, 'Next concatenated stream', 'header'))
    }
  })
  fields.push(...capFields(nonOverlapping(items), 100, 'more blocks'))
  if (blocks.length) regions.push({ name: 'Blocks', offset: 4, length: Math.max(1, (ends.length ? ends[ends.length - 1].bit >> 3 : bytes.length) - 4), kind: 'data' })

  const lastEos = ends[ends.length - 1]
  if (complete && !lastEos) warnings.push('No end-of-stream marker found (truncated?)')
  if (lastEos) {
    const end = Math.ceil((lastEos.bit + 80) / 8)
    if (end < bytes.length) {
      warnings.push(`${plural(bytes.length - end, 'byte')} of trailing data after the end of the stream`)
      regions.push({ name: 'Trailing data', offset: end, length: bytes.length - end, kind: 'other' })
    }
    if (end > bytes.length) warnings.push('The end-of-stream marker is truncated')
  }
  if (!complete) warnings.push(`Only the first ${formatBytes(SCAN_LIMIT)} were scanned for blocks`)

  summary.push(item('Block Size', `${level * 100} kB (level ${level})`))
  summary.push(item('Blocks', complete ? formatNumber(blocks.length) : `${formatNumber(blocks.length)}+`))
  summary.push(item('Maximum Uncompressed Size', `≈ ${formatBytes(blocks.length * level * 100000)}`, ['Each block holds at most the block size; bzip2 does not record the exact total']))
  if (streams > 1) summary.push(item('Streams', `${streams} (concatenated, e.g. from pbzip2)`))
  if (lastEos && lastEos.bit + 80 <= bytes.length * 8) summary.push(item('Combined CRC', hex32(((bitsAt(bytes, lastEos.bit + 48, 16) * 0x10000) + bitsAt(bytes, lastEos.bit + 64, 16)) >>> 0)))
  return { summary, fields, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'bzip2',
  name: 'bzip2 Compressed Data',
  category: 'compressed',
  detect: bytes => bytes.length >= 10 && isStreamHeader(bytes, 0) && (matches(bytes, 32, BLOCK_MAGIC) || matches(bytes, 32, EOS_MAGIC)),
  parse: fitted(parseBzip2)
}
