import { ByteReader, capFields, field, fitted, formatNumber, hex32, plural } from './reader.js'
import { formatBytes, item } from './shared.js'

const MAGIC = 0xFD2FB528
const MAX_FRAMES = 10000
const MAX_BLOCKS = 1000000
const MAX_FRAME_FIELDS = 32
const MAX_BLOCK_FIELDS = 64
const BLOCK_TYPES = ['Raw', 'RLE', 'Compressed', 'Reserved']

const isSkippable = magic => (magic & 0xFFFFFFF0) === 0x184D2A50

function readFrame(r, start, ctx) {
  const { bytes } = r
  const descriptor = r.u8(start + 4)
  const fcsFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksumFlag = (descriptor >> 2) & 1
  const dictFlag = descriptor & 3
  if (descriptor & 0x08) ctx.warnings.add(`Reserved bit set in the frame header at offset ${start}`)
  let pos = start + 5
  const header = [
    field('Magic', start, 4, '28 B5 2F FD', 'Zstandard frame signature', 'magic'),
    field('Frame header descriptor', start + 4, 1, [`content size field ${[singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]} bytes`, singleSegment ? 'single segment' : null, checksumFlag ? 'checksum' : null, dictFlag ? 'dictionary ID' : null].filter(Boolean).join(', '), 'Which optional header fields follow', 'flags')
  ]
  let window = null
  if (!singleSegment) {
    const wd = r.u8(pos)
    const exponent = wd >> 3
    const base = 2 ** (10 + exponent)
    window = base + (base / 8) * (wd & 7)
    header.push(field('Window descriptor', pos, 1, formatBytes(window), 'Maximum back-reference distance', 'size'))
    pos++
  }
  const dictSize = [0, 1, 2, 4][dictFlag]
  let dictId = null
  if (dictSize) {
    dictId = dictSize === 1 ? r.u8(pos) : dictSize === 2 ? r.u16(pos) : r.u32(pos)
    header.push(field('Dictionary ID', pos, dictSize, dictId, 'Dictionary needed to decompress', 'data'))
    pos += dictSize
  }
  const fcsSize = [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]
  let contentSize = null
  if (fcsSize) {
    contentSize = fcsSize === 1 ? r.u8(pos) : fcsSize === 2 ? r.u16(pos) + 256 : fcsSize === 4 ? r.u32(pos) : r.u64(pos)
    header.push(field('Content size', pos, fcsSize, formatNumber(contentSize), 'Decompressed size of the frame', 'size'))
    pos += fcsSize
  }
  if (singleSegment && contentSize !== null) window = contentSize
  if (!r.has(start, pos - start)) return { truncated: true, end: bytes.length, header, contentSize, window, dictId, blocks: 0, fields: [] }

  const blockFields = []
  let blocks = 0
  let last = false
  let truncated = false
  let hidden = 0
  let hiddenEnd = pos
  const headerEnd = pos
  while (!last) {
    if (!r.has(pos, 3)) {
      truncated = true
      break
    }
    if (ctx.blocks >= MAX_BLOCKS) {
      ctx.warnings.add(`Stopped after ${formatNumber(MAX_BLOCKS)} blocks`)
      truncated = true
      break
    }
    const value = r.u24(pos)
    last = (value & 1) === 1
    const type = (value >> 1) & 3
    const size = value >> 3
    const dataSize = type === 1 ? 1 : size
    if (type === 3) {
      ctx.warnings.add(`Reserved block type at offset ${pos}`)
      truncated = true
      break
    }
    const end = Math.min(pos + 3 + dataSize, bytes.length)
    blocks++
    ctx.blocks++
    if (blockFields.length < MAX_BLOCK_FIELDS) {
      const children = [field('Block header', pos, 3, `${BLOCK_TYPES[type]}, ${type === 1 ? `repeats ${formatNumber(size)} times` : formatBytes(size)}${last ? ', last' : ''}`, 'Last flag, type and size (24 bits)', 'header')]
      if (end > pos + 3) children.push(field(type === 1 ? 'Repeated byte' : 'Block data', pos + 3, end - pos - 3, undefined, type === 2 ? 'Literals and sequences' : type === 0 ? 'Stored bytes' : 'Byte to repeat', 'data'))
      blockFields.push(field(`Block ${blocks}`, pos, end - pos, BLOCK_TYPES[type], 'Zstandard block', 'header', children))
    } else {
      hidden++
      hiddenEnd = end
    }
    if (pos + 3 + dataSize > bytes.length) {
      truncated = true
      pos = bytes.length
      break
    }
    pos += 3 + dataSize
  }
  let checksum = null
  if (!truncated && checksumFlag) {
    if (r.has(pos, 4)) {
      checksum = r.u32(pos)
      blockFields.push(field('Content checksum', pos, 4, hex32(checksum), 'Low 32 bits of the XXH64 of the content', 'checksum'))
      pos += 4
    } else {
      truncated = true
      pos = bytes.length
    }
  }
  const fields = [field('Frame header', start, headerEnd - start, undefined, 'Magic and frame parameters', 'header', header), ...capFields(blockFields, MAX_BLOCK_FIELDS + 1, 'more blocks', hidden, hiddenEnd)]
  return { truncated, end: pos, header, contentSize, window, dictId, blocks, checksum, fields }
}

function parseZstd(bytes) {
  const r = new ByteReader(bytes, true)
  const warnings = new Set()
  const regions = []
  const summary = []
  const ctx = { warnings, blocks: 0 }
  const frames = []
  let skippable = 0
  let pos = 0
  while (pos + 4 <= bytes.length && frames.length < MAX_FRAMES) {
    const magic = r.u32(pos)
    if (magic === MAGIC) {
      const frame = readFrame(r, pos, ctx)
      frames.push({ start: pos, ...frame })
      regions.push({ name: 'Frame', offset: pos, length: Math.min(frame.end, bytes.length) - pos, kind: 'data' })
      if (frame.truncated) {
        warnings.add(`Frame at offset ${pos} is truncated`)
        pos = bytes.length
        break
      }
      pos = frame.end
    } else if (isSkippable(magic)) {
      const size = r.u32(pos + 4)
      const end = Math.min(pos + 8 + size, bytes.length)
      skippable++
      frames.push({ start: pos, end, skippable: true, fields: [
        field('Magic', pos, 4, hex32(magic), 'Skippable frame signature', 'magic'),
        field('Frame size', pos + 4, 4, formatNumber(size), 'Bytes of user data', 'size'),
        ...(end > pos + 8 ? [field('User data', pos + 8, end - pos - 8, formatBytes(size), 'Ignored by decoders', 'data')] : [])
      ] })
      regions.push({ name: 'Skippable frame', offset: pos, length: end - pos, kind: 'metadata' })
      const cut = pos + 8 + size > bytes.length
      if (cut) warnings.add('Skippable frame is truncated')
      pos = end
      if (cut) break
    } else {
      break
    }
  }
  if (pos < bytes.length) {
    warnings.add(`${plural(bytes.length - pos, 'byte')} of data after the last frame`)
    regions.push({ name: 'Trailing data', offset: pos, length: bytes.length - pos, kind: 'other' })
  }

  let dataIndex = 0
  const frameFields = frames.map(frame => field(frame.skippable ? 'Skippable frame' : `Frame ${++dataIndex}`, frame.start, Math.min(frame.end, bytes.length) - frame.start,
    frame.skippable ? undefined : frame.contentSize !== null ? formatBytes(frame.contentSize) : plural(frame.blocks, 'block'), frame.skippable ? 'User data frame' : 'Zstandard frame', 'header', frame.fields))
  const fields = frames.length === 1 ? frameFields[0].children || [] : capFields(frameFields, MAX_FRAME_FIELDS, 'more frames')

  const data = frames.filter(frame => !frame.skippable)
  const known = data.every(frame => frame.contentSize !== null)
  const total = data.reduce((sum, frame) => sum + (frame.contentSize || 0), 0)
  const first = data[0]
  summary.push(item('Frames', formatNumber(data.length) + (skippable ? ` (+${skippable} skippable)` : '')))
  if (data.length) {
    summary.push(item('Content Size', known ? `${formatBytes(total)} (${formatNumber(total)} bytes)` : 'Not recorded in every frame header'))
    if (known && total > 0) summary.push(item('Compression Ratio', `${((bytes.length / total) * 100).toFixed(1)}%`))
    if (first.window) summary.push(item('Window Size', formatBytes(first.window)))
    summary.push(item('Blocks', formatNumber(ctx.blocks)))
    summary.push(item('Content Checksum', first.checksum !== null && first.checksum !== undefined ? 'Yes (XXH64)' : 'No'))
    if (first.dictId) summary.push(item('Dictionary ID', first.dictId))
  }
  return { summary, fields, regions, warnings: [...warnings] }
}

function isFrame(bytes, offset) {
  return offset + 5 <= bytes.length && bytes[offset] === 0x28 && bytes[offset + 1] === 0xB5 && bytes[offset + 2] === 0x2F && bytes[offset + 3] === 0xFD
}

// A skippable frame alone is too weak a signal; a real frame must follow it
function detectZstd(bytes) {
  if (isFrame(bytes, 0)) return true
  if (bytes.length < 8 || bytes[0] < 0x50 || bytes[0] > 0x5F || bytes[1] !== 0x2A || bytes[2] !== 0x4D || bytes[3] !== 0x18) return false
  const size = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0
  return isFrame(bytes, 8 + size)
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'zstd',
  name: 'Zstandard Compressed Data',
  category: 'compressed',
  detect: detectZstd,
  parse: fitted(parseZstd)
}
