import { ByteReader, capFields, field, fitted, formatDuration, formatNumber, latin1, plural, printable, utf16, utf8 } from './reader.js'
import { formatBytes, item } from './shared.js'

const MAX_FRAMES_SHOWN = 100
const SYNC_SEARCH = 64 * 1024
const FRAME_COUNT_LIMIT = 200000

const BITRATES = {
  // [version 1][layer], [version 2/2.5][layer] in kbit/s; index 0 is "free", 15 invalid
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
}
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] }
const CHANNEL_MODES = ['Stereo', 'Joint stereo', 'Dual channel', 'Mono']

const TEXT_FRAMES = {
  TIT2: 'Title', TPE1: 'Artist', TALB: 'Album', TYER: 'Year', TDRC: 'Recorded', TRCK: 'Track', TCON: 'Genre', TPE2: 'Album artist',
  TCOM: 'Composer', TENC: 'Encoded by', TSSE: 'Encoder settings', TLEN: 'Length (ms)', TPOS: 'Disc', TBPM: 'BPM', TCOP: 'Copyright', TPUB: 'Publisher',
  TT2: 'Title', TP1: 'Artist', TAL: 'Album', TYE: 'Year', TRK: 'Track', TCO: 'Genre', TEN: 'Encoded by'
}
const FRAME_NAMES = {
  APIC: 'Attached picture', PIC: 'Attached picture', COMM: 'Comment', COM: 'Comment', TXXX: 'User text', WXXX: 'User URL', PRIV: 'Private data',
  GEOB: 'Encapsulated object', USLT: 'Lyrics', POPM: 'Popularimeter', UFID: 'Unique file identifier', CHAP: 'Chapter', CTOC: 'Table of contents', PCNT: 'Play counter'
}

/** Decodes an MPEG audio frame header at `offset`, or returns null */
export function frameHeader(bytes, offset) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xFF || (bytes[offset + 1] & 0xE0) !== 0xE0) return null
  const b1 = bytes[offset + 1]
  const b2 = bytes[offset + 2]
  const b3 = bytes[offset + 3]
  const versionBits = (b1 >> 3) & 3
  const layerBits = (b1 >> 1) & 3
  const bitrateIndex = b2 >> 4
  const rateIndex = (b2 >> 2) & 3
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 15 || bitrateIndex === 0 || rateIndex === 3) return null
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5
  const layer = 4 - layerBits
  const bitrate = BITRATES[`${version === 1 ? 1 : 2}-${layer}`][bitrateIndex] * 1000
  const sampleRate = SAMPLE_RATES[version][rateIndex]
  const padding = (b2 >> 1) & 1
  const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152
  const length = layer === 1 ? (Math.floor(12 * bitrate / sampleRate) + padding) * 4 : Math.floor(samples / 8 * bitrate / sampleRate) + padding
  return {
    version, layer, bitrate, sampleRate, padding, samples, length,
    protection: (b1 & 1) === 0, channelMode: b3 >> 6, channels: (b3 >> 6) === 3 ? 1 : 2,
    copyright: (b3 >> 3) & 1, original: (b3 >> 2) & 1, emphasis: b3 & 3
  }
}

function sameStream(a, b) {
  return b && a.version === b.version && a.layer === b.layer && a.sampleRate === b.sampleRate
}

function syncsafe(bytes, offset) {
  return ((bytes[offset] & 0x7F) << 21) | ((bytes[offset + 1] & 0x7F) << 14) | ((bytes[offset + 2] & 0x7F) << 7) | (bytes[offset + 3] & 0x7F)
}

function decodeText(bytes, start, end) {
  if (end <= start) return ''
  const encoding = bytes[start]
  const s = start + 1
  const length = Math.min(end - s, 1024)
  let text
  if (encoding === 1 || encoding === 2) {
    let little = encoding === 1 ? true : false
    let from = s
    if (encoding === 1 && length >= 2) {
      if (bytes[s] === 0xFE && bytes[s + 1] === 0xFF) little = false
      from = s + 2
    }
    text = utf16(bytes, from, length - (from - s), little)
  } else if (encoding === 3) {
    text = utf8(bytes, s, length)
  } else {
    text = latin1(bytes, s, length)
  }
  return text.replace(/\0+$/, '').replace(/\0/g, ' / ')
}

function parseID3(r, warnings, tags) {
  const { bytes } = r
  const major = bytes[3]
  const flags = bytes[5]
  const size = syncsafe(bytes, 6)
  const footer = major === 4 && (flags & 0x10) ? 10 : 0
  const end = Math.min(10 + size, bytes.length)
  const total = 10 + size + footer
  if (10 + size > bytes.length) warnings.push('ID3v2 tag is truncated')
  const headerFields = [
    field('Identifier', 0, 3, 'ID3', 'ID3v2 tag signature', 'magic'),
    field('Version', 3, 2, `2.${major}.${bytes[4]}`, 'Major and revision', 'magic'),
    field('Flags', 5, 1, [[0x80, 'unsynchronisation'], [0x40, 'extended header'], [0x20, 'experimental'], [0x10, 'footer']].filter(([b]) => flags & b).map(([, n]) => n).join(', ') || 'none', 'Tag flags', 'flags'),
    field('Size', 6, 4, formatNumber(size), 'Tag size after the header (syncsafe integer)', 'size')
  ]
  const frameFields = []
  let pos = 10
  if (flags & 0x40 && major >= 3 && r.has(10, 4)) {
    const extSize = major === 4 ? syncsafe(bytes, 10) : r.u32(10) + 4
    if (extSize > 0 && 10 + extSize <= end) {
      frameFields.push(field('Extended header', 10, extSize, formatBytes(extSize), 'Optional extra tag information', 'header'))
      pos += extSize
    }
  }
  const idLength = major === 2 ? 3 : 4
  const headerLength = major === 2 ? 6 : 10
  let count = 0
  let hidden = 0
  let picture = null
  while (pos + headerLength <= end && count < 10000) {
    if (bytes[pos] === 0) {
      frameFields.push(field('Padding', pos, end - pos, formatBytes(end - pos), 'Zero padding reserved for edits', 'padding'))
      break
    }
    const id = latin1(bytes, pos, idLength)
    if (!/^[A-Z0-9]+$/.test(id)) {
      warnings.push(`Invalid ID3 frame id at offset ${pos}`)
      break
    }
    const frameSize = major === 2 ? r.u24(pos + 3) : major === 4 ? syncsafe(bytes, pos + 4) : r.u32(pos + 4)
    const dataStart = pos + headerLength
    const dataEnd = Math.min(dataStart + frameSize, end)
    if (dataStart + frameSize > end) warnings.push(`ID3 frame ${id} runs past the end of the tag`)
    count++
    let value
    const textName = TEXT_FRAMES[id]
    if (id[0] === 'T' && id !== 'TXXX' && id !== 'TXX') {
      value = printable(decodeText(bytes, dataStart, dataEnd), 120)
      if (textName && tags.length < 40) tags.push([textName, value])
    } else if ((id === 'APIC' || id === 'PIC') && dataEnd > dataStart + 2) {
      let p = dataStart + 1
      let mime
      if (id === 'PIC') {
        mime = latin1(bytes, p, 3)
        p += 3
      } else {
        let q = p
        while (q < dataEnd && bytes[q] !== 0) q++
        mime = latin1(bytes, p, Math.min(q - p, 64))
        p = q + 1
      }
      value = `${printable(mime)}, ${formatBytes(frameSize)}`
      picture = picture || value
    } else if ((id === 'COMM' || id === 'COM') && dataEnd > dataStart + 4) {
      const text = decodeText(bytes, dataStart, dataEnd)
      value = printable(text.slice(3).replace(/^.*? \/ /, ''), 120)
    }
    const children = [
      field('Frame ID', pos, idLength, id, FRAME_NAMES[id] || textName || 'ID3 frame', 'magic'),
      field('Frame size', pos + idLength, major === 2 ? 3 : 4, formatNumber(frameSize), 'Bytes after the frame header', 'size')
    ]
    if (major !== 2) children.push(field('Frame flags', pos + 8, 2, `0x${r.u16(pos + 8, false).toString(16).padStart(4, '0')}`, 'Status and format flags', 'flags'))
    if (dataEnd > dataStart) children.push(field('Content', dataStart, dataEnd - dataStart, formatBytes(frameSize), 'Frame data', 'data'))
    if (frameFields.length < 200) frameFields.push(field(id, pos, dataEnd - pos, value, FRAME_NAMES[id] || textName || 'ID3 frame', 'header', children))
    else hidden++
    if (dataEnd <= pos) break
    pos = dataEnd
  }
  const children = [...headerFields, ...capFields(frameFields, 200, 'more frames', hidden, end)]
  if (footer && r.has(10 + size, 10)) children.push(field('Footer', 10 + size, 10, '3DI', 'Copy of the header, for reading backwards', 'header'))
  return { end: Math.min(total, bytes.length), field: field('ID3v2 tag', 0, Math.min(total, bytes.length), `v2.${major}, ${plural(count, 'frame')}`, 'Metadata before the audio', 'header', children), version: `2.${major}`, picture, unsync: (flags & 0x80) !== 0 }
}

function parseMP3(bytes) {
  const r = new ByteReader(bytes, false)
  const warnings = []
  const fields = []
  const regions = []
  const summary = []
  const tags = []
  let audioStart = 0
  let id3 = null
  if (latin1(bytes, 0, 3) === 'ID3' && bytes.length >= 10) {
    id3 = parseID3(r, warnings, tags)
    fields.push(id3.field)
    regions.push({ name: 'ID3v2 tag', offset: 0, length: id3.end, kind: 'metadata' })
    audioStart = id3.end
  }
  let id3v1 = null
  let audioEnd = bytes.length
  if (bytes.length >= 128 && latin1(bytes, bytes.length - 128, 3) === 'TAG' && bytes.length - 128 >= audioStart) {
    audioEnd = bytes.length - 128
    const at = audioEnd
    const text = (o, n) => printable(latin1(bytes, at + o, n).replace(/[\0 ]+$/, ''), 60)
    id3v1 = { title: text(3, 30), artist: text(33, 30), album: text(63, 30), year: text(93, 4) }
  }

  // Find the first frame: skip zero padding, then search a little
  let first = -1
  for (let p = audioStart; p < Math.min(audioEnd - 3, audioStart + SYNC_SEARCH); p++) {
    if (bytes[p] !== 0xFF) continue
    const header = frameHeader(bytes, p)
    if (!header) continue
    const next = frameHeader(bytes, p + header.length)
    if (p + header.length >= audioEnd || sameStream(header, next)) {
      first = p
      break
    }
  }
  if (first < 0) {
    const flac = latin1(bytes, audioStart, 4) === 'fLaC'
    warnings.push(flac ? 'The ID3 tag is followed by a FLAC stream, not MPEG audio' : 'No MPEG audio frame found')
    summary.push(item('ID3 Tag', id3 ? `v${id3.version}` : 'None'))
    tags.forEach(([label, value]) => summary.push(item(label, value, null, 'Tags')))
    return { formatName: flac ? 'FLAC Audio (ID3-tagged)' : 'MP3 Audio', summary, fields, regions, warnings }
  }
  if (first > audioStart) {
    const zeros = bytes.subarray(audioStart, first).every(b => b === 0)
    fields.push(field(zeros ? 'Padding' : 'Unrecognised data', audioStart, first - audioStart, formatBytes(first - audioStart), zeros ? 'Zero bytes before the first frame' : 'Bytes before the first frame', zeros ? 'padding' : 'data'))
    if (!zeros) warnings.push(`${plural(first - audioStart, 'byte')} of unrecognised data before the first audio frame`)
  }

  const h = frameHeader(bytes, first)
  const versionName = h.version === 1 ? 'MPEG-1' : h.version === 2 ? 'MPEG-2' : 'MPEG-2.5'
  // Xing/Info (VBR) or VBRI header inside the first frame
  const sideInfo = h.version === 1 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17)
  const xingAt = first + 4 + sideInfo
  let vbr = null
  const xingTag = latin1(bytes, xingAt, 4)
  if (xingTag === 'Xing' || xingTag === 'Info') {
    const flags = r.u32(xingAt + 4)
    vbr = { kind: xingTag === 'Xing' ? 'VBR (Xing header)' : 'CBR (Info header)', frames: flags & 1 ? r.u32(xingAt + 8) : null, bytes: flags & 2 ? r.u32(xingAt + 8 + (flags & 1 ? 4 : 0)) : null }
    const lame = latin1(bytes, xingAt + 120, 9)
    if (/^(LAME|Lavc|Lavf)/.test(lame)) vbr.encoder = printable(lame.replace(/[\0 ]+$/, ''))
  } else if (latin1(bytes, first + 36, 4) === 'VBRI') {
    vbr = { kind: 'VBR (VBRI header)', bytes: r.u32(first + 46), frames: r.u32(first + 50) }
  }

  // Walk frames for a count and to lay out fields
  const frameFields = []
  let pos = first
  let frames = 0
  let hidden = 0
  let lastEnd = first
  while (pos + 4 <= audioEnd && frames < FRAME_COUNT_LIMIT) {
    const header = frameHeader(bytes, pos)
    if (!header || !sameStream(h, header)) break
    const end = Math.min(pos + header.length, audioEnd)
    if (frameFields.length < MAX_FRAMES_SHOWN) {
      const children = [field('Frame header', pos, 4, `${header.bitrate / 1000} kbit/s, ${header.sampleRate} Hz${header.padding ? ', padded' : ''}`, 'Sync, version, layer, bitrate, rate, mode', 'header')]
      if (end > pos + 4) children.push(field('Audio data', pos + 4, end - pos - 4, undefined, frames === 0 && vbr ? `Holds the ${vbr.kind}` : 'Side information and compressed audio', 'data'))
      frameFields.push(field(`Frame ${frames + 1}`, pos, end - pos, `${formatNumber(header.length)} bytes`, `${versionName} Layer ${header.layer} frame`, 'header', children))
    } else {
      hidden++
    }
    frames++
    lastEnd = end
    if (pos + header.length > audioEnd) {
      warnings.push('The last audio frame is truncated')
      break
    }
    pos += header.length
  }
  fields.push(...capFields(frameFields, MAX_FRAMES_SHOWN, 'more frames', hidden, lastEnd))
  regions.push({ name: 'Audio frames', offset: first, length: lastEnd - first, kind: 'data' })
  if (frames >= FRAME_COUNT_LIMIT) warnings.push(`Counted the first ${formatNumber(FRAME_COUNT_LIMIT)} frames only`)
  else if (lastEnd < audioEnd) {
    const rest = audioEnd - lastEnd
    if (latin1(bytes, lastEnd, 8) === 'APETAGEX') {
      fields.push(field('APE tag', lastEnd, rest, formatBytes(rest), 'APEv2 metadata', 'header'))
      summary.push(item('APE Tag', 'Present'))
    } else if (rest > 0) {
      warnings.push(`${plural(rest, 'byte')} after the last audio frame are not MPEG audio`)
      fields.push(field('Trailing data', lastEnd, rest, formatBytes(rest), 'Not part of the audio stream', 'data'))
    }
  }
  if (id3v1) {
    fields.push(field('ID3v1 tag', audioEnd, 128, `"${id3v1.title}"`, 'Fixed 128-byte tag at the end', 'header', [
      field('Identifier', audioEnd, 3, 'TAG', 'ID3v1 signature', 'magic'),
      field('Title', audioEnd + 3, 30, id3v1.title, 'Song title', 'string'),
      field('Artist', audioEnd + 33, 30, id3v1.artist, 'Artist', 'string'),
      field('Album', audioEnd + 63, 30, id3v1.album, 'Album', 'string'),
      field('Year', audioEnd + 93, 4, id3v1.year, 'Year', 'string'),
      field('Comment and genre', audioEnd + 97, 31, undefined, 'Comment, track number and genre index', 'data')
    ]))
    regions.push({ name: 'ID3v1 tag', offset: audioEnd, length: 128, kind: 'metadata' })
  }

  const totalFrames = vbr && vbr.frames ? vbr.frames : frames < FRAME_COUNT_LIMIT ? frames - (vbr ? 1 : 0) : null
  let seconds = totalFrames ? totalFrames * h.samples / h.sampleRate : NaN
  if (!Number.isFinite(seconds)) seconds = (audioEnd - first) * 8 / h.bitrate
  summary.push(item('Audio', `${versionName} Layer ${'I'.repeat(h.layer)}`))
  // A Xing/Info frame may use its own bitrate; the stream's starts with the next frame
  const second = vbr ? frameHeader(bytes, first + h.length) : null
  const bitrate = sameStream(h, second) ? second.bitrate : h.bitrate
  summary.push(item('Bitrate', vbr && vbr.kind.startsWith('VBR') ? `Variable (${vbr.bytes && Number.isFinite(seconds) && seconds > 0 ? `average ${Math.round(vbr.bytes * 8 / seconds / 1000)} kbit/s` : `first frame ${bitrate / 1000} kbit/s`})` : `${bitrate / 1000} kbit/s`))
  summary.push(item('Sample Rate', `${formatNumber(h.sampleRate)} Hz`))
  summary.push(item('Channels', `${CHANNEL_MODES[h.channelMode]} (${h.channels})`))
  summary.push(item('Duration', formatDuration(seconds), [vbr && vbr.frames ? 'From the frame count in the VBR header' : frames < FRAME_COUNT_LIMIT ? 'From the frames counted' : 'Estimated from the bitrate']))
  summary.push(item('Frames', totalFrames !== null ? formatNumber(totalFrames) : `${formatNumber(frames)}+`))
  if (vbr) summary.push(item('VBR Header', vbr.kind))
  if (vbr && vbr.encoder) summary.push(item('Encoder', vbr.encoder))
  summary.push(item('CRC Protection', h.protection ? 'Yes' : 'No'))
  summary.push(item('ID3 Tags', [id3 ? `v${id3.version}` : null, id3v1 ? 'v1' : null].filter(Boolean).join(', ') || 'None'))
  if (id3 && id3.picture) summary.push(item('Cover Art', id3.picture))
  if (id3 && id3.unsync) warnings.push('The ID3 tag uses unsynchronisation; frame contents are shown undecoded')
  tags.forEach(([label, value]) => summary.push(item(label, value, null, 'Tags')))
  if (!id3 && id3v1) {
    for (const [label, value] of [['Title', id3v1.title], ['Artist', id3v1.artist], ['Album', id3v1.album], ['Year', id3v1.year]]) {
      if (value) summary.push(item(label, value, null, 'Tags'))
    }
  }
  return { formatName: h.layer === 3 ? 'MP3 Audio' : `MPEG Audio Layer ${'I'.repeat(h.layer)}`, summary, fields, regions, warnings }
}

// With an ID3v2 tag the header is enough; bare frame sync needs two frames in a row
function detectMP3(bytes) {
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return bytes[3] >= 2 && bytes[3] <= 4 && bytes[4] !== 0xFF && ((bytes[6] | bytes[7] | bytes[8] | bytes[9]) & 0x80) === 0
  }
  const header = frameHeader(bytes, 0)
  if (!header) return false
  const next = frameHeader(bytes, header.length)
  if (!sameStream(header, next)) return false
  const third = frameHeader(bytes, header.length + next.length)
  return header.length + next.length >= bytes.length || sameStream(header, third)
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'mp3',
  name: 'MP3 Audio',
  category: 'audio',
  detect: detectMP3,
  parse: fitted(parseMP3)
}
