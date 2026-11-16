import { ByteReader, capFields, field, fitted, formatDuration, formatNumber, latin1, plural, printable, utf8 } from './reader.js'
import { formatBytes, hexBytes, item } from './shared.js'

const MAX_BLOCKS = 1000
const MAX_COMMENTS = 64

const BLOCK_TYPES = ['STREAMINFO', 'PADDING', 'APPLICATION', 'SEEKTABLE', 'VORBIS_COMMENT', 'CUESHEET', 'PICTURE']
const BLOCK_DESCRIPTIONS = ['Stream parameters', 'Reserved space', 'Application data', 'Seek points', 'Tags', 'CD table of contents', 'Embedded picture']
const PICTURE_TYPES = ['Other', 'File icon', 'Other file icon', 'Front cover', 'Back cover', 'Leaflet', 'Media', 'Lead artist', 'Artist', 'Conductor', 'Band', 'Composer', 'Lyricist', 'Recording location', 'During recording', 'During performance', 'Screen capture', 'Fish', 'Illustration', 'Band logo', 'Publisher logo']

const COMMENT_LABELS = { TITLE: 'Title', ARTIST: 'Artist', ALBUM: 'Album', DATE: 'Date', TRACKNUMBER: 'Track', GENRE: 'Genre', ALBUMARTIST: 'Album artist', COMPOSER: 'Composer', COMMENT: 'Comment', DESCRIPTION: 'Description' }

/**
 * Vorbis comment block (also used by Ogg Vorbis and Opus): little-endian
 * length-prefixed vendor string and KEY=value list.
 */
export function readVorbisComments(r, start, end) {
  const result = { vendor: '', comments: [], count: 0, fields: [] }
  if (!r.has(start, 4)) return result
  const vendorLength = r.u32(start, true)
  if (start + 4 + vendorLength > end) return result
  result.vendor = printable(utf8(r.bytes, start + 4, Math.min(vendorLength, 512)), 120)
  result.fields.push(field('Vendor', start, 4 + vendorLength, result.vendor, 'Encoder that wrote the stream', 'string'))
  let pos = start + 4 + vendorLength
  if (pos + 4 > end) return result
  result.count = r.u32(pos, true)
  result.fields.push(field('Comment count', pos, 4, formatNumber(result.count), 'Number of KEY=value entries', 'count'))
  pos += 4
  for (let i = 0; i < result.count && i < 10000 && pos + 4 <= end; i++) {
    const length = r.u32(pos, true)
    if (pos + 4 + length > end) break
    const text = utf8(r.bytes, pos + 4, Math.min(length, 1024))
    if (result.comments.length < MAX_COMMENTS) {
      const eq = text.indexOf('=')
      result.comments.push([eq > 0 ? text.slice(0, eq).toUpperCase() : text, eq > 0 ? printable(text.slice(eq + 1), 120) : ''])
      result.fields.push(field(printable(eq > 0 ? text.slice(0, eq) : `Comment ${i + 1}`, 40), pos, 4 + length, eq > 0 ? printable(text.slice(eq + 1), 80) : printable(text, 80), 'Length-prefixed KEY=value', 'string'))
    }
    pos += 4 + length
  }
  return result
}

export function commentSummary(comments) {
  return comments.filter(([key]) => COMMENT_LABELS[key]).slice(0, 24).map(([key, value]) => item(COMMENT_LABELS[key], value, null, 'Tags'))
}

function syncsafe(bytes, offset) {
  return ((bytes[offset] & 0x7F) << 21) | ((bytes[offset + 1] & 0x7F) << 14) | ((bytes[offset + 2] & 0x7F) << 7) | (bytes[offset + 3] & 0x7F)
}

// FLAC may follow an ID3v2 tag some taggers add
function flacStart(bytes) {
  if (latin1(bytes, 0, 4) === 'fLaC') return 0
  if (bytes.length >= 14 && latin1(bytes, 0, 3) === 'ID3' && ((bytes[6] | bytes[7] | bytes[8] | bytes[9]) & 0x80) === 0) {
    const start = 10 + syncsafe(bytes, 6) + (bytes[5] & 0x10 ? 10 : 0)
    if (latin1(bytes, start, 4) === 'fLaC') return start
  }
  return -1
}

function parseFLAC(bytes) {
  const r = new ByteReader(bytes, false)
  const warnings = []
  const regions = []
  const summary = []
  const fields = []
  const start = flacStart(bytes)
  if (start > 0) {
    fields.push(field('ID3v2 tag', 0, start, formatBytes(start), 'Non-standard ID3 tag before the FLAC stream', 'header'))
    regions.push({ name: 'ID3v2 tag', offset: 0, length: start, kind: 'metadata' })
    warnings.push('An ID3v2 tag precedes the FLAC stream; not all players accept this')
  }
  fields.push(field('Signature', start, Math.min(4, bytes.length - start), 'fLaC', 'FLAC stream marker', 'magic'))
  let pos = start + 4
  let info = null
  let comments = null
  const pictures = []
  const blockFields = []
  let blocks = 0
  let last = false
  let seekPoints = 0
  let padding = 0
  while (!last && pos + 4 <= bytes.length && blocks < MAX_BLOCKS) {
    const header = r.u8(pos)
    last = (header & 0x80) !== 0
    const type = header & 0x7F
    const length = r.u24(pos + 1)
    const dataStart = pos + 4
    const dataEnd = Math.min(dataStart + length, bytes.length)
    if (dataStart + length > bytes.length) warnings.push(`${BLOCK_TYPES[type] || `Block type ${type}`} metadata block is truncated`)
    if (type === 127) {
      warnings.push(`Invalid metadata block type 127 at offset ${pos}`)
      break
    }
    blocks++
    const name = BLOCK_TYPES[type] || `Reserved type ${type}`
    const children = [field('Block header', pos, 4, `${name}, ${formatNumber(length)} bytes${last ? ', last' : ''}`, 'Last-block flag, type and length', 'header')]
    let value
    if (type === 0 && dataEnd - dataStart >= 34) {
      const s = dataStart
      const sampleRate = r.u24(s + 10) >> 4
      const channels = ((r.u8(s + 12) >> 1) & 7) + 1
      const bits = (((r.u8(s + 12) & 1) << 4) | (r.u8(s + 13) >> 4)) + 1
      const totalSamples = (r.u8(s + 13) & 0x0F) * 0x100000000 + r.u32(s + 14)
      info = { minBlock: r.u16(s), maxBlock: r.u16(s + 2), minFrame: r.u24(s + 4), maxFrame: r.u24(s + 7), sampleRate, channels, bits, totalSamples, md5: hexBytes(bytes, s + 18, 16).toLowerCase() }
      value = `${formatNumber(sampleRate)} Hz, ${channels} ch, ${bits}-bit`
      children.push(
        field('Block size', s, 4, `${info.minBlock}–${info.maxBlock} samples`, 'Minimum and maximum block size'),
        field('Frame size', s + 4, 6, `${formatNumber(info.minFrame)}–${formatNumber(info.maxFrame)} bytes`, 'Minimum and maximum frame size, 0 if unknown'),
        field('Sample rate, channels, bits, samples', s + 10, 8, `${formatNumber(sampleRate)} Hz, ${channels} ch, ${bits}-bit, ${formatNumber(totalSamples)} samples`, '20, 3, 5 and 36 bits packed'),
        field('MD5', s + 18, 16, /^0+$/.test(info.md5) ? 'not set' : info.md5, 'Of the decoded audio', 'checksum'))
    } else if (type === 4) {
      comments = readVorbisComments(new ByteReader(bytes, true), dataStart, dataEnd)
      value = plural(comments.count, 'comment')
      children.push(...capFields(comments.fields, 66, 'more comments'))
    } else if (type === 6 && dataEnd - dataStart >= 32) {
      let p = dataStart
      const pictureType = r.u32(p)
      const mimeLength = r.u32(p + 4)
      const mime = printable(latin1(bytes, p + 8, Math.min(mimeLength, 64)))
      p += 8 + mimeLength
      const descLength = r.u32(p)
      p += 4 + descLength
      const width = r.u32(p)
      const height = r.u32(p + 4)
      const dataLength = r.u32(p + 16)
      pictures.push(`${PICTURE_TYPES[pictureType] || 'Picture'}: ${mime}, ${width}×${height}, ${formatBytes(dataLength)}`)
      value = `${PICTURE_TYPES[pictureType] || 'Picture'}, ${mime}`
      if (p + 20 < dataEnd && dataLength > 0) children.push(field('Picture data', p + 20, Math.min(dataLength, dataEnd - p - 20), formatBytes(dataLength), mime, 'data'))
    } else if (type === 3) {
      seekPoints = Math.floor(length / 18)
      value = plural(seekPoints, 'seek point')
    } else if (type === 1) {
      padding += length
      value = formatBytes(length)
    } else if (type === 2 && length >= 4) {
      value = `application ${printable(latin1(bytes, dataStart, 4))}`
    }
    if (dataEnd > dataStart && children.length === 1) children.push(field('Data', dataStart, dataEnd - dataStart, formatBytes(length), BLOCK_DESCRIPTIONS[type] || 'Block data', 'data'))
    blockFields.push(field(name, pos, dataEnd - pos, value, BLOCK_DESCRIPTIONS[type] || 'Reserved metadata block', 'header', children))
    regions.push({ name, offset: pos, length: dataEnd - pos, kind: type === 1 ? 'padding' : 'metadata' })
    pos = dataStart + length
  }
  fields.push(...capFields(blockFields, 100, 'more blocks'))
  if (!last) warnings.push('Metadata ends without a last-block flag (truncated?)')
  if (blockFields.length && blockFields[0].name !== 'STREAMINFO') warnings.push('The first metadata block is not STREAMINFO')

  if (pos < bytes.length) {
    const frameSync = r.u16(pos) >> 1 === 0x7FFC
    fields.push(field('Audio frames', pos, bytes.length - pos, formatBytes(bytes.length - pos), frameSync ? 'Compressed audio, starting with a frame sync code' : 'Compressed audio', 'data',
      frameSync ? [field('First frame header', pos, Math.min(4, bytes.length - pos), r.u8(pos + 1) & 1 ? 'variable block size' : 'fixed block size', 'Sync code 0xFFF8 or 0xFFF9 and coding parameters', 'header')] : []))
    regions.push({ name: 'Audio frames', offset: pos, length: bytes.length - pos, kind: 'data' })
    if (!frameSync) warnings.push(`No frame sync code where the audio should start (offset ${pos})`)
  }

  if (info) {
    summary.push(item('Sample Rate', `${formatNumber(info.sampleRate)} Hz`))
    summary.push(item('Channels', info.channels))
    summary.push(item('Bits per Sample', info.bits))
    summary.push(item('Total Samples', info.totalSamples ? formatNumber(info.totalSamples) : 'Unknown'))
    if (info.totalSamples && info.sampleRate) summary.push(item('Duration', formatDuration(info.totalSamples / info.sampleRate)))
    if (info.totalSamples && info.sampleRate && pos < bytes.length) {
      const seconds = info.totalSamples / info.sampleRate
      summary.push(item('Average Bitrate', `${Math.round((bytes.length - pos) * 8 / seconds / 1000)} kbit/s`))
      const raw = info.totalSamples * info.channels * info.bits / 8
      if (raw > 0) summary.push(item('Compression', `${(((bytes.length - pos) / raw) * 100).toFixed(1)}% of uncompressed PCM`))
    }
    summary.push(item('Block Size', info.minBlock === info.maxBlock ? `${info.minBlock} samples` : `${info.minBlock}–${info.maxBlock} samples`))
    summary.push(item('Audio MD5', /^0+$/.test(info.md5) ? 'Not set' : info.md5))
  } else {
    warnings.push('No STREAMINFO block found')
  }
  summary.push(item('Metadata Blocks', formatNumber(blocks)))
  if (seekPoints) summary.push(item('Seek Points', formatNumber(seekPoints)))
  if (padding) summary.push(item('Padding', formatBytes(padding)))
  if (comments) {
    if (comments.vendor) summary.push(item('Encoder', comments.vendor))
    summary.push(...commentSummary(comments.comments))
  }
  pictures.slice(0, 8).forEach((text, index) => summary.push(item(`Picture ${index + 1}`, text, null, 'Pictures')))
  return { formatName: 'FLAC Audio', summary, fields, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'flac',
  name: 'FLAC Audio',
  category: 'audio',
  detect: bytes => flacStart(bytes) >= 0,
  parse: fitted(parseFLAC)
}
