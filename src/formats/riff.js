import { ByteReader, capFields, field, fitted, formatDuration, formatNumber, fourcc, latin1, plural, printable } from './reader.js'
import { formatBytes, item } from './shared.js'

const MAX_DEPTH = 4
const MAX_CHUNKS_SHOWN = 64
// Chunks walked per list; AVI 'movi' lists can hold hundreds of thousands
const MAX_CHUNKS_WALKED = 20000

const WAVE_FORMATS = {
  0x0001: 'PCM', 0x0002: 'Microsoft ADPCM', 0x0003: 'IEEE float', 0x0006: 'A-law', 0x0007: 'µ-law',
  0x0011: 'IMA ADPCM', 0x0031: 'GSM 6.10', 0x0050: 'MPEG', 0x0055: 'MP3', 0x00FF: 'AAC', 0x0161: 'WMA',
  0x2000: 'AC-3', 0xFFFE: 'Extensible'
}

const INFO_TAGS = { INAM: 'Title', IART: 'Artist', IPRD: 'Album', ICMT: 'Comment', ICRD: 'Date', IGNR: 'Genre', ISFT: 'Software', ICOP: 'Copyright', ITRK: 'Track' }

const CHUNK_NAMES = {
  'fmt ': 'Format', data: 'Sample data', fact: 'Sample count', LIST: 'List', cue: 'Cue points', smpl: 'Sampler', bext: 'Broadcast extension',
  avih: 'Main AVI header', strh: 'Stream header', strf: 'Stream format', idx1: 'Index', JUNK: 'Padding',
  VP8: 'Lossy image data', VP8L: 'Lossless image data', VP8X: 'Extended header', ALPH: 'Alpha data', ANIM: 'Animation parameters',
  ANMF: 'Animation frame', ICCP: 'ICC profile', EXIF: 'EXIF metadata', 'XMP ': 'XMP metadata', id3: 'ID3 tag', 'ID3 ': 'ID3 tag'
}

const CONTAINERS = new Set(['LIST', 'RIFF'])

function chunkName(id) {
  return CHUNK_NAMES[id] || CHUNK_NAMES[id.trim()] || ''
}

/**
 * Walks chunks between `start` and `end`, calling `visit(chunk, depth)` for
 * each and building fields. LIST chunks are descended into.
 */
function walk(r, start, end, depth, ctx) {
  const fields = []
  let pos = start
  let walked = 0
  let hidden = 0
  while (pos + 8 <= end) {
    if (walked >= MAX_CHUNKS_WALKED || ctx.total >= ctx.maxTotal) {
      ctx.warnings.add('Stopped walking chunks early; the file has too many to list')
      return { fields: capFields(fields, MAX_CHUNKS_SHOWN, 'more chunks', hidden + 1, end), end }
    }
    walked++
    ctx.total++
    const id = fourcc(r.bytes, pos)
    const size = r.u32(pos + 4)
    const dataStart = pos + 8
    const declaredEnd = dataStart + size
    const dataEnd = Math.min(declaredEnd, end, r.length)
    if (declaredEnd > end) ctx.warnings.add(`Chunk "${printable(id)}" at offset ${pos} runs past the end of its ${declaredEnd > r.length ? 'file' : 'parent'}`)
    const chunk = { id, offset: pos, size, dataStart, dataEnd, listType: null }
    const children = [
      field('Chunk ID', pos, 4, id, 'Four-character code', 'magic'),
      field('Chunk size', pos + 4, 4, formatNumber(size), 'Bytes of data, excluding this header and padding', 'size')
    ]
    if (CONTAINERS.has(id) && dataEnd - dataStart >= 4) {
      chunk.listType = fourcc(r.bytes, dataStart)
      children.push(field('List type', dataStart, 4, chunk.listType, 'What this list holds', 'magic'))
      ctx.visit(chunk, depth)
      if (depth < MAX_DEPTH) {
        ctx.path.push(chunk.listType)
        const inner = walk(r, dataStart + 4, dataEnd, depth + 1, ctx)
        ctx.path.pop()
        children.push(...inner.fields)
      }
    } else {
      ctx.visit(chunk, depth)
      if (dataEnd > dataStart) children.push(field('Data', dataStart, dataEnd - dataStart, formatBytes(size), chunkName(id) || 'Chunk data', 'data', ctx.detail(chunk)))
    }
    const padded = declaredEnd + (size & 1)
    const chunkEnd = Math.min(padded, end, r.length)
    if ((size & 1) && padded <= Math.min(end, r.length)) children.push(field('Padding', declaredEnd, 1, undefined, 'Pads the chunk to an even length', 'padding'))
    const label = chunk.listType ? `${id} ${chunk.listType}` : id
    if (fields.length < MAX_CHUNKS_SHOWN + 1) {
      fields.push(field(label, pos, chunkEnd - pos, chunkName(id) || undefined, chunk.listType ? `List of chunks (${chunk.listType})` : `${chunkName(id) || 'Chunk'}`, 'header', children))
    } else {
      hidden++
    }
    if (chunkEnd <= pos) break
    pos = chunkEnd
  }
  const tailEnd = Math.min(end, r.length)
  if (pos < tailEnd && pos + 8 > tailEnd) ctx.warnings.add(`${plural(tailEnd - pos, 'stray byte')} at offset ${pos} too short for a chunk header`)
  return { fields: capFields(fields, MAX_CHUNKS_SHOWN, 'more chunks', hidden, pos), end: pos }
}

// WebP bitstream headers
function webpDetail(r, chunk, info) {
  const { dataStart: s, dataEnd: e, id } = chunk
  if (id === 'VP8 ' && e - s >= 10) {
    const frameTag = r.u24(s, true)
    const keyframe = (frameTag & 1) === 0
    if (keyframe && r.u8(s + 3) === 0x9D && r.u8(s + 4) === 0x01 && r.u8(s + 5) === 0x2A) {
      const w = r.u16(s + 6) & 0x3FFF
      const h = r.u16(s + 8) & 0x3FFF
      if (!info.width) Object.assign(info, { width: w, height: h })
      info.compression = info.compression || 'Lossy (VP8)'
      return [
        field('Frame tag', s, 3, keyframe ? 'key frame' : 'inter frame', 'VP8 frame header', 'flags'),
        field('Start code', s + 3, 3, '9D 01 2A', 'VP8 key frame start code', 'magic'),
        field('Width', s + 6, 2, `${w}px (scale ${r.u8(s + 7) >> 6})`, '14-bit width and 2-bit scale'),
        field('Height', s + 8, 2, `${h}px (scale ${r.u8(s + 9) >> 6})`, '14-bit height and 2-bit scale')
      ]
    }
  }
  if (id === 'VP8L' && e - s >= 5 && r.u8(s) === 0x2F) {
    const bits = r.u32(s + 1, true)
    const w = (bits & 0x3FFF) + 1
    const h = ((bits >>> 14) & 0x3FFF) + 1
    const alpha = (bits >>> 28) & 1
    if (!info.width) Object.assign(info, { width: w, height: h })
    info.compression = info.compression || 'Lossless (VP8L)'
    if (alpha) info.alpha = true
    return [
      field('Signature', s, 1, '0x2F', 'VP8L signature', 'magic'),
      field('Dimensions and flags', s + 1, 4, `${w}×${h}, alpha hint ${alpha ? 'set' : 'clear'}, version ${(bits >>> 29) & 7}`, '14-bit width-1, 14-bit height-1, alpha, version', 'flags')
    ]
  }
  if (id === 'VP8X' && e - s >= 10) {
    const flags = r.u8(s)
    const w = r.u24(s + 4, true) + 1
    const h = r.u24(s + 7, true) + 1
    Object.assign(info, { width: w, height: h, extended: true })
    info.features = [[0x20, 'ICC profile'], [0x10, 'alpha'], [0x08, 'EXIF'], [0x04, 'XMP'], [0x02, 'animation']].filter(([bit]) => flags & bit).map(([, name]) => name)
    if (flags & 0x10) info.alpha = true
    if (flags & 0x02) info.animated = true
    return [
      field('Flags', s, 1, info.features.join(', ') || 'none', 'Which optional features are present', 'flags'),
      field('Reserved', s + 1, 3, undefined, 'Zero', 'padding'),
      field('Canvas width', s + 4, 3, `${w}px`, 'Stored minus one'),
      field('Canvas height', s + 7, 3, `${h}px`, 'Stored minus one')
    ]
  }
  if (id === 'ANMF') info.frames = (info.frames || 0) + 1
  if (id === 'ANIM' && e - s >= 6) {
    info.loops = r.u16(s + 4)
    return [field('Background colour', s, 4, undefined, 'BGRA'), field('Loop count', s + 4, 2, info.loops || 'infinite', '0 loops forever', 'count')]
  }
  return []
}

function waveDetail(r, chunk, info) {
  const { dataStart: s, dataEnd: e, id } = chunk
  if (id === 'fmt ' && e - s >= 16) {
    let tag = r.u16(s)
    info.channels = r.u16(s + 2)
    info.sampleRate = r.u32(s + 4)
    info.byteRate = r.u32(s + 8)
    info.blockAlign = r.u16(s + 12)
    info.bits = r.u16(s + 14)
    const list = [
      field('Format tag', s, 2, `0x${tag.toString(16).toUpperCase().padStart(4, '0')} (${WAVE_FORMATS[tag] || 'unknown'})`, 'Audio encoding'),
      field('Channels', s + 2, 2, info.channels, 'Number of channels', 'count'),
      field('Sample rate', s + 4, 4, `${formatNumber(info.sampleRate)} Hz`, 'Samples per second per channel'),
      field('Byte rate', s + 8, 4, `${formatNumber(info.byteRate)} B/s`, 'Average bytes per second'),
      field('Block align', s + 12, 2, info.blockAlign, 'Bytes per sample frame', 'size'),
      field('Bits per sample', s + 14, 2, info.bits, 'Sample precision')
    ]
    if (tag === 0xFFFE && e - s >= 40) {
      info.validBits = r.u16(s + 18)
      info.channelMask = r.u32(s + 20)
      const sub = r.u16(s + 24)
      list.push(field('Extension size', s + 16, 2, r.u16(s + 16), 'Bytes of extension', 'size'),
        field('Valid bits', s + 18, 2, info.validBits, 'Meaningful bits per sample'),
        field('Channel mask', s + 20, 4, `0x${info.channelMask.toString(16).toUpperCase()}`, 'Speaker positions', 'flags'),
        field('Sub-format', s + 24, 16, WAVE_FORMATS[sub] || `0x${sub.toString(16)}`, 'Format GUID; its first two bytes are the format tag'))
      tag = sub
      info.extensible = true
    } else if (e - s >= 18) {
      list.push(field('Extension size', s + 16, 2, r.u16(s + 16), 'Bytes of format-specific data', 'size'))
    }
    info.format = WAVE_FORMATS[tag] || `Unknown (0x${tag.toString(16)})`
    return list
  }
  if (id === 'data' && ctxPath(info) === 'WAVE') info.dataSize = chunk.size
  if (id === 'fact' && e - s >= 4) {
    info.sampleFrames = r.u32(s)
    return [field('Sample frames', s, 4, formatNumber(info.sampleFrames), 'Per channel, for compressed audio', 'count')]
  }
  return []
}

function ctxPath(info) {
  return info.path[info.path.length - 1]
}

function aviDetail(r, chunk, info) {
  const { dataStart: s, dataEnd: e, id } = chunk
  if (id === 'avih' && e - s >= 40) {
    info.usPerFrame = r.u32(s)
    info.totalFrames = r.u32(s + 16)
    info.streams = r.u32(s + 24)
    info.width = r.u32(s + 32)
    info.height = r.u32(s + 36)
    return [
      field('Microseconds per frame', s, 4, formatNumber(info.usPerFrame), info.usPerFrame ? `${(1e6 / info.usPerFrame).toFixed(3)} fps` : ''),
      field('Max bytes per second', s + 4, 4, formatNumber(r.u32(s + 4)), 'Peak data rate'),
      field('Padding granularity', s + 8, 4, r.u32(s + 8), 'Alignment of data'),
      field('Flags', s + 12, 4, `0x${r.u32(s + 12).toString(16).toUpperCase()}`, 'AVIF_* flags (0x10 means it has an index)', 'flags'),
      field('Total frames', s + 16, 4, formatNumber(info.totalFrames), 'In this RIFF part', 'count'),
      field('Initial frames', s + 20, 4, r.u32(s + 20), 'For interleaved files', 'count'),
      field('Streams', s + 24, 4, info.streams, 'Number of streams', 'count'),
      field('Suggested buffer size', s + 28, 4, formatNumber(r.u32(s + 28)), 'For reading', 'size'),
      field('Width', s + 32, 4, `${info.width}px`, 'Frame width'),
      field('Height', s + 36, 4, `${info.height}px`, 'Frame height')
    ]
  }
  if (id === 'strh' && e - s >= 40) {
    const type = fourcc(r.bytes, s)
    const handler = fourcc(r.bytes, s + 4)
    const scale = r.u32(s + 20)
    const rate = r.u32(s + 24)
    const length = r.u32(s + 32)
    info.stream = { type, handler, scale, rate, length }
    info.streamList.push(info.stream)
    return [
      field('Type', s, 4, type, 'vids, auds, txts or mids', 'magic'),
      field('Handler', s + 4, 4, printable(handler), 'Codec FourCC'),
      field('Flags', s + 8, 4, `0x${r.u32(s + 8).toString(16)}`, 'Stream flags', 'flags'),
      field('Scale', s + 20, 4, scale, 'Rate divided by scale is samples per second'),
      field('Rate', s + 24, 4, rate, 'Time base numerator'),
      field('Start', s + 28, 4, r.u32(s + 28), 'Start time in rate/scale units'),
      field('Length', s + 32, 4, formatNumber(length), 'In rate/scale units', 'count')
    ]
  }
  if (id === 'strf' && info.stream) {
    if (info.stream.type === 'vids' && e - s >= 20) {
      info.stream.codec = fourcc(r.bytes, s + 16)
      info.stream.width = r.i32(s + 4)
      info.stream.height = r.i32(s + 8)
      return [
        field('Header size', s, 4, r.u32(s), 'BITMAPINFOHEADER', 'size'),
        field('Width', s + 4, 4, `${info.stream.width}px`, 'Frame width'),
        field('Height', s + 8, 4, `${info.stream.height}px`, 'Frame height'),
        field('Bit count', s + 14, 2, r.u16(s + 14), 'Bits per pixel'),
        field('Compression', s + 16, 4, printable(info.stream.codec), 'Codec FourCC')
      ]
    }
    if (info.stream.type === 'auds' && e - s >= 16) {
      const tag = r.u16(s)
      Object.assign(info.stream, { codec: WAVE_FORMATS[tag] || `0x${tag.toString(16)}`, channels: r.u16(s + 2), sampleRate: r.u32(s + 4) })
      return [
        field('Format tag', s, 2, info.stream.codec, 'Audio encoding'),
        field('Channels', s + 2, 2, info.stream.channels, 'Number of channels', 'count'),
        field('Sample rate', s + 4, 4, `${formatNumber(info.stream.sampleRate)} Hz`, 'Samples per second')
      ]
    }
  }
  return []
}

function infoTagDetail(r, chunk, info) {
  if (ctxPath(info) === 'INFO' && INFO_TAGS[chunk.id] && info.tags.length < 32) {
    const text = printable(latin1(r.bytes, chunk.dataStart, Math.min(chunk.dataEnd - chunk.dataStart, 256)).replace(/\0+$/, ''))
    if (text) info.tags.push([INFO_TAGS[chunk.id], text])
    return []
  }
  return null
}

export function parseRIFF(bytes) {
  const magic = latin1(bytes, 0, 4)
  const little = magic !== 'RIFX'
  const r = new ByteReader(bytes, little)
  const form = bytes.length >= 12 ? fourcc(bytes, 8) : ''
  const warnings = new Set()
  const info = { path: [form], tags: [], streamList: [], counts: {} }
  const detailFor = form === 'WEBP' ? webpDetail : form === 'WAVE' ? waveDetail : form === 'AVI ' ? aviDetail : () => []
  const ctx = {
    warnings,
    total: 0,
    maxTotal: 50000,
    path: info.path,
    visit: chunk => {
      info.counts[chunk.id] = (info.counts[chunk.id] || 0) + 1
      if (chunk.id === 'LIST' && chunk.listType === 'movi') info.movi = chunk
    },
    detail: chunk => infoTagDetail(r, chunk, info) || detailFor(r, chunk, info)
  }

  const summary = []
  const regions = []
  if (bytes.length < 12) {
    return { summary, fields: [field('RIFF header', 0, bytes.length, magic, 'Truncated', 'magic')], warnings: ['File is truncated inside the RIFF header'] }
  }
  const declared = r.u32(4)
  const rf64 = magic === 'RF64'
  const end = rf64 ? bytes.length : Math.min(bytes.length, 8 + declared)
  const inner = walk(r, 12, end, 1, ctx)
  const fields = [field(`${magic} ${form}`, 0, Math.min(bytes.length, Math.max(end, inner.end)), undefined, 'RIFF container', 'header', [
    field('Signature', 0, 4, magic, rf64 ? 'RIFF with 64-bit sizes' : little ? 'RIFF, little-endian sizes' : 'RIFX, big-endian sizes', 'magic'),
    field('Size', 4, 4, rf64 ? 'see ds64 chunk' : formatNumber(declared), 'Bytes after this field', 'size'),
    field('Form type', 8, 4, form, 'What the container holds', 'magic'),
    ...inner.fields
  ])]
  regions.push({ name: 'RIFF header', offset: 0, length: 12, kind: 'header' })
  if (!rf64 && 8 + declared > bytes.length) warnings.add(`RIFF size says ${formatNumber(8 + declared)} bytes but the file has ${formatNumber(bytes.length)} (truncated?)`)
  if (!rf64 && 8 + declared + 1 < bytes.length) {
    warnings.add(`${plural(bytes.length - 8 - declared, 'byte')} of trailing data after the RIFF container`)
    regions.push({ name: 'Trailing data', offset: 8 + declared, length: bytes.length - 8 - declared, kind: 'other' })
  }
  for (const top of inner.fields) {
    if (top.name.startsWith('…')) continue
    regions.push({ name: top.name, offset: top.offset, length: top.length, kind: top.name === 'data' || top.name.includes('movi') || top.name.startsWith('VP8') ? 'data' : 'metadata' })
  }

  let formatName
  if (form === 'WEBP') {
    formatName = 'WebP Image'
    if (info.width) summary.push(item('Width', `${info.width}px`), item('Height', `${info.height}px`))
    summary.push(item('Compression', info.compression || (info.animated ? 'Animated' : 'Unknown')))
    summary.push(item('Container', info.extended ? 'Extended (VP8X)' : 'Simple'))
    if (info.features && info.features.length) summary.push(item('Features', info.features.join(', ')))
    summary.push(item('Alpha', info.alpha ? 'Yes' : 'No'))
    if (info.animated) {
      summary.push(item('Frames', formatNumber(info.frames || 0)))
      if (info.loops !== undefined) summary.push(item('Loops', info.loops || 'Infinite'))
    }
  } else if (form === 'WAVE') {
    formatName = 'WAV Audio'
    if (info.format) {
      summary.push(item('Encoding', info.format + (info.extensible ? ' (extensible)' : '')))
      summary.push(item('Channels', info.channels))
      summary.push(item('Sample Rate', `${formatNumber(info.sampleRate)} Hz`))
      summary.push(item('Bits per Sample', info.validBits && info.validBits !== info.bits ? `${info.validBits} (in ${info.bits})` : info.bits))
      summary.push(item('Byte Rate', `${formatNumber(info.byteRate)} B/s`))
    } else {
      warnings.add('No format chunk found')
    }
    if (info.dataSize !== undefined) {
      summary.push(item('Audio Data', formatBytes(info.dataSize)))
      const seconds = info.sampleFrames && info.sampleRate ? info.sampleFrames / info.sampleRate : info.byteRate ? info.dataSize / info.byteRate : NaN
      if (Number.isFinite(seconds)) summary.push(item('Duration', formatDuration(seconds)))
    }
  } else if (form === 'AVI ') {
    formatName = 'AVI Video'
    if (info.width) summary.push(item('Width', `${info.width}px`), item('Height', `${info.height}px`))
    if (info.usPerFrame) {
      summary.push(item('Frame Rate', `${(1e6 / info.usPerFrame).toFixed(3).replace(/\.?0+$/, '')} fps`))
      summary.push(item('Duration', formatDuration(info.totalFrames * info.usPerFrame / 1e6)))
    }
    if (info.totalFrames !== undefined) summary.push(item('Frames', formatNumber(info.totalFrames)))
    info.streamList.slice(0, 16).forEach((stream, index) => {
      const kind = stream.type === 'vids' ? 'Video' : stream.type === 'auds' ? 'Audio' : stream.type === 'txts' ? 'Subtitles' : stream.type
      const details = stream.type === 'vids' ? `${printable(stream.codec || stream.handler)} ${stream.width || ''}×${stream.height || ''}`
        : stream.type === 'auds' ? `${stream.codec || ''}, ${stream.channels || '?'} ch, ${formatNumber(stream.sampleRate || 0)} Hz` : printable(stream.handler)
      summary.push(item(`Stream ${index}`, `${kind}: ${details}`, null, 'Streams'))
    })
    if (info.counts.idx1) summary.push(item('Index', 'Yes (idx1)'))
    if (info.counts.RIFF) summary.push(item('OpenDML', `Yes, ${plural(info.counts.RIFF + 1, 'RIFF part')}`))
  } else {
    formatName = `RIFF ${printable(form.trim())} File`
    summary.push(item('Form Type', printable(form)))
    summary.push(item('Chunks', formatNumber(ctx.total)))
  }
  if (!little) summary.push(item('Byte Order', 'Big-endian (RIFX)'))
  if (rf64) summary.push(item('Container', 'RF64 (64-bit sizes)'))
  for (const [label, value] of info.tags) summary.push(item(label, value, null, 'Tags'))

  return { formatName, summary, fields, regions, warnings: [...warnings] }
}

/** The form type of a RIFF file ('WAVE', 'AVI ', 'WEBP', ...), or null */
export function riffForm(bytes) {
  if (bytes.length < 12 || !['RIFF', 'RIFX', 'RF64'].includes(latin1(bytes, 0, 4))) return null
  const form = latin1(bytes, 8, 4)
  return /^[\x20-\x7E]{4}$/.test(form) ? form : null
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'riff',
  name: 'RIFF Container',
  category: 'media',
  detect: bytes => riffForm(bytes) !== null,
  parse: fitted(parseRIFF)
}
