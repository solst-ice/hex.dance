import { commentSummary, readVorbisComments } from './flac.js'
import { ByteReader, capFields, field, fitted, formatDuration, formatNumber, latin1, plural, printable } from './reader.js'
import { formatBytes, item } from './shared.js'

const MAX_PAGES = 200000
const MAX_PAGE_FIELDS = 64
const MAX_STREAMS = 32

let crcTable = null
// Ogg uses the non-reflected CRC-32 (polynomial 0x04C11DB7, no final xor)
function oggCrc(bytes, start, end, crcAt) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i << 24
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04C11DB7 : c << 1
      crcTable[i] = c >>> 0
    }
  }
  let crc = 0
  for (let i = start; i < end; i++) {
    const byte = i >= crcAt && i < crcAt + 4 ? 0 : bytes[i]
    crc = (crcTable[((crc >>> 24) ^ byte) & 0xFF] ^ (crc << 8)) >>> 0
  }
  return crc
}

// Identification header of a logical stream, from its first packet
function identify(r, s, e) {
  const { bytes } = r
  const tag = latin1(bytes, s, 8)
  if (tag.startsWith('\x01vorbis') && e - s >= 30) {
    return { codec: 'Vorbis', channels: r.u8(s + 11), sampleRate: r.u32(s + 12, true), bitrate: r.i32(s + 20, true),
      fields: [field('Packet type', s, 7, '\\x01vorbis', 'Vorbis identification header', 'magic'), field('Channels', s + 11, 1, r.u8(s + 11), 'Audio channels', 'count'),
        field('Sample rate', s + 12, 4, `${formatNumber(r.u32(s + 12, true))} Hz`, 'Samples per second'), field('Nominal bitrate', s + 20, 4, formatNumber(r.i32(s + 20, true)), 'Bits per second, if set')] }
  }
  if (tag === 'OpusHead' && e - s >= 19) {
    return { codec: 'Opus', channels: r.u8(s + 9), sampleRate: 48000, inputRate: r.u32(s + 12, true), preSkip: r.u16(s + 10, true),
      fields: [field('Magic', s, 8, 'OpusHead', 'Opus identification header', 'magic'), field('Version', s + 8, 1, r.u8(s + 8), 'Format version'),
        field('Channels', s + 9, 1, r.u8(s + 9), 'Output channels', 'count'), field('Pre-skip', s + 10, 2, r.u16(s + 10, true), 'Samples to discard at 48 kHz'),
        field('Input sample rate', s + 12, 4, `${formatNumber(r.u32(s + 12, true))} Hz`, 'Of the original audio (informational)')] }
  }
  if (tag.startsWith('\x7FFLAC') && e - s >= 51) {
    const at = s + 13 + 4
    const sampleRate = r.u24(at + 10, false) >> 4
    return { codec: 'FLAC', channels: ((r.u8(at + 12) >> 1) & 7) + 1, sampleRate, fields: [field('Magic', s, 5, '\\x7FFLAC', 'Ogg FLAC mapping header', 'magic')] }
  }
  if (tag === 'Speex   ' && e - s >= 52) return { codec: 'Speex', sampleRate: r.u32(s + 36, true), channels: r.u32(s + 48, true), fields: [field('Magic', s, 8, 'Speex', 'Speex header', 'magic')] }
  if (tag.startsWith('\x80theora') && e - s >= 42) {
    const width = r.u24(s + 14, false)
    const height = r.u24(s + 17, false)
    const fpsN = r.u32(s + 22, false)
    const fpsD = r.u32(s + 26, false)
    return { codec: 'Theora', width, height, fps: fpsD ? fpsN / fpsD : 0, shift: ((r.u8(s + 40) & 3) << 3) | (r.u8(s + 41) >> 5), fields: [field('Magic', s, 7, '\\x80theora', 'Theora identification header', 'magic'), field('Picture size', s + 14, 6, `${width}×${height}`, 'Displayed picture size')] }
  }
  if (tag === 'fishead\0') return { codec: 'Skeleton (metadata)', fields: [field('Magic', s, 8, 'fishead', 'Ogg Skeleton header', 'magic')] }
  if (tag.startsWith('OVP80')) return { codec: 'VP8', fields: [] }
  if (latin1(bytes, s, 5) === '\x80kate') return { codec: 'Kate (subtitles)', fields: [] }
  return { codec: `Unknown (${printable(tag.replace(/[^\x20-\x7E]/g, '.'))})`, fields: [] }
}

function parseOgg(bytes) {
  const r = new ByteReader(bytes, true)
  const warnings = []
  const regions = []
  const summary = []
  const streams = new Map()
  const pageFields = []
  let pos = 0
  let pages = 0
  let badCrc = 0
  let hiddenEnd = 0
  let hidden = 0

  while (pos + 27 <= bytes.length && pages < MAX_PAGES) {
    if (latin1(bytes, pos, 4) !== 'OggS') {
      // Resynchronise on the next capture pattern
      let next = -1
      for (let p = pos + 1; p + 4 <= bytes.length && p < pos + 65536; p++) {
        if (bytes[p] === 0x4F && bytes[p + 1] === 0x67 && bytes[p + 2] === 0x67 && bytes[p + 3] === 0x53) {
          next = p
          break
        }
      }
      warnings.push(`Lost page sync at offset ${pos}${next >= 0 ? `; resumed at ${next}` : ''}`)
      if (next < 0) break
      pos = next
      continue
    }
    const version = r.u8(pos + 4)
    const type = r.u8(pos + 5)
    const granule = r.u64(pos + 6)
    const granuleUnset = r.u32(pos + 6) === 0xFFFFFFFF && r.u32(pos + 10) === 0xFFFFFFFF
    const serial = r.u32(pos + 14)
    const sequence = r.u32(pos + 18)
    const crc = r.u32(pos + 22)
    const segments = r.u8(pos + 26)
    const tableEnd = pos + 27 + segments
    if (tableEnd > bytes.length) {
      warnings.push(`Page at offset ${pos} is truncated in its segment table`)
      break
    }
    let payload = 0
    for (let i = pos + 27; i < tableEnd; i++) payload += bytes[i]
    const end = tableEnd + payload
    const truncated = end > bytes.length
    if (truncated) warnings.push(`Page at offset ${pos} is truncated`)
    const pageEnd = Math.min(end, bytes.length)
    pages++
    const crcOk = !truncated && (pages <= MAX_PAGE_FIELDS || pages % 64 === 0) ? oggCrc(bytes, pos, end, pos + 22) === crc : null
    if (crcOk === false) badCrc++

    let stream = streams.get(serial)
    if (!stream && streams.size < MAX_STREAMS) {
      stream = { serial, pages: 0, bytes: 0, lastGranule: null, info: null, comments: null, bos: (type & 2) !== 0, eos: false }
      streams.set(serial, stream)
    }
    let payloadChildren = []
    if (stream) {
      stream.pages++
      stream.bytes += payload
      if (!granuleUnset) stream.lastGranule = granule
      if (type & 4) stream.eos = true
      // First packet of the page, if it ends inside it
      let packetLength = 0
      let complete = false
      for (let i = pos + 27; i < tableEnd; i++) {
        packetLength += bytes[i]
        if (bytes[i] < 255) {
          complete = true
          break
        }
      }
      const packetEnd = Math.min(tableEnd + packetLength, pageEnd)
      if ((type & 2) && !stream.info) {
        stream.info = identify(r, tableEnd, packetEnd)
        payloadChildren = stream.info.fields
      } else if (stream.info && !stream.comments && stream.pages === 2 && complete) {
        const magic = latin1(bytes, tableEnd, 8)
        const offset = magic.startsWith('\x03vorbis') ? 7 : magic === 'OpusTags' ? 8 : stream.info.codec === 'FLAC' && (bytes[tableEnd] & 0x7F) === 4 ? 4 : -1
        if (offset >= 0) {
          stream.comments = readVorbisComments(r, tableEnd + offset, packetEnd)
          payloadChildren = [field('Comment header', tableEnd, packetEnd - tableEnd, plural(stream.comments.count, 'comment'), 'Vendor string and tags', 'header', capFields(stream.comments.fields, 40, 'more comments'))]
        }
      }
    }

    if (pageFields.length < MAX_PAGE_FIELDS) {
      const flags = [[1, 'continued'], [2, 'first page'], [4, 'last page']].filter(([bit]) => type & bit).map(([, name]) => name).join(', ') || 'none'
      const children = [
        field('Capture pattern', pos, 4, 'OggS', 'Page signature', 'magic'),
        field('Version', pos + 4, 1, version, 'Always 0', 'magic'),
        field('Header type', pos + 5, 1, flags, 'Continuation, beginning and end of stream', 'flags'),
        field('Granule position', pos + 6, 8, granuleUnset ? 'none (-1)' : formatNumber(granule), 'Codec-defined position (samples for audio)'),
        field('Serial number', pos + 14, 4, `0x${serial.toString(16).toUpperCase()}`, 'Identifies the logical stream'),
        field('Sequence number', pos + 18, 4, formatNumber(sequence), 'Page counter within the stream', 'count'),
        field('CRC', pos + 22, 4, `0x${crc.toString(16).toUpperCase().padStart(8, '0')}${crcOk === null ? '' : crcOk ? ' (valid)' : ' (mismatch)'}`, 'CRC-32 of the page with this field zeroed', 'checksum'),
        field('Segment count', pos + 26, 1, segments, 'Entries in the lacing table', 'count')
      ]
      if (segments) children.push(field('Segment table', pos + 27, segments, `${formatNumber(payload)} bytes`, 'Lacing values; a value below 255 ends a packet', 'table'))
      if (pageEnd > tableEnd) children.push(field('Payload', tableEnd, pageEnd - tableEnd, formatBytes(payload), 'Packet data', 'data', payloadChildren))
      pageFields.push(field(`Page ${pages - 1}`, pos, pageEnd - pos, `stream 0x${serial.toString(16).toUpperCase()}, ${flags}`, 'Ogg page', 'header', children))
    } else {
      hidden++
      hiddenEnd = pageEnd
    }
    pos = pageEnd
    if (truncated) break
  }
  if (pages >= MAX_PAGES && pos < bytes.length) warnings.push(`Stopped after ${formatNumber(MAX_PAGES)} pages`)
  else if (pos < bytes.length && pos + 27 > bytes.length) warnings.push(`${plural(bytes.length - pos, 'byte')} of trailing data after the last page`)
  if (badCrc) warnings.push(`${plural(badCrc, 'page')} with a CRC mismatch (checked the first ${MAX_PAGE_FIELDS} and every 64th)`)
  const fields = capFields(pageFields, MAX_PAGE_FIELDS, 'more pages', hidden, hiddenEnd)
  if (pos > 0) regions.push({ name: 'Ogg pages', offset: 0, length: pos, kind: 'data' })

  const list = [...streams.values()]
  const codecs = list.map(stream => (stream.info ? stream.info.codec : 'Unknown'))
  summary.push(item('Streams', list.length === 1 ? codecs[0] : `${list.length} (${codecs.join(', ')})`))
  summary.push(item('Pages', formatNumber(pages)))
  let longest = 0
  list.forEach((stream, index) => {
    const info = stream.info || {}
    const parts = [info.codec || 'Unknown codec']
    if (info.sampleRate) parts.push(`${formatNumber(info.sampleRate)} Hz`)
    if (info.channels) parts.push(`${info.channels} ch`)
    if (info.width) parts.push(`${info.width}×${info.height}`)
    if (info.fps) parts.push(`${+info.fps.toFixed(3)} fps`)
    let seconds = NaN
    if (stream.lastGranule !== null && info.sampleRate) seconds = (stream.lastGranule - (info.preSkip || 0)) / info.sampleRate
    if (stream.lastGranule !== null && info.codec === 'Theora' && info.fps) {
      const frames = Math.floor(stream.lastGranule / 2 ** info.shift) + (stream.lastGranule % 2 ** info.shift)
      seconds = frames / info.fps
    }
    if (Number.isFinite(seconds) && seconds >= 0) {
      parts.push(formatDuration(seconds))
      longest = Math.max(longest, seconds)
    }
    if (info.bitrate > 0) parts.push(`${Math.round(info.bitrate / 1000)} kbit/s nominal`)
    summary.push(item(`Stream ${index + 1}`, parts.join(', '), [`Serial 0x${stream.serial.toString(16).toUpperCase()}, ${plural(stream.pages, 'page')}, ${formatBytes(stream.bytes)}`, stream.eos ? 'Ends with an end-of-stream page' : 'No end-of-stream page (truncated or still being written)'], 'Streams'))
    if (!stream.bos) warnings.push(`Stream 0x${stream.serial.toString(16).toUpperCase()} does not start with a beginning-of-stream page`)
  })
  if (longest > 0) summary.push(item('Duration', formatDuration(longest)))
  const withComments = list.find(stream => stream.comments)
  if (withComments) {
    if (withComments.comments.vendor) summary.push(item('Encoder', withComments.comments.vendor))
    summary.push(...commentSummary(withComments.comments.comments))
  }
  const main = codecs.find(codec => codec !== 'Skeleton (metadata)') || codecs[0] || ''
  const formatName = /Theora|VP8/.test(codecs.join()) ? 'Ogg Video' : main === 'Opus' ? 'Ogg Opus Audio' : main === 'Vorbis' ? 'Ogg Vorbis Audio' : main === 'FLAC' ? 'Ogg FLAC Audio' : 'Ogg Container'
  return { formatName, summary, fields, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'ogg',
  name: 'Ogg Container',
  category: 'audio',
  detect: bytes => bytes.length >= 27 && bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53 && bytes[4] === 0,
  parse: fitted(parseOgg)
}
