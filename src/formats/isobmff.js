import { ByteReader, capFields, field, fitted, formatDate, formatDuration, formatNumber, fourcc, plural, printable, utf8 } from './reader.js'
import { formatBytes, item } from './shared.js'

const MAX_DEPTH = 10
const MAX_BOXES = 20000
const MAX_CHILDREN_SHOWN = 64

// Seconds between 1904-01-01 (QuickTime/ISO epoch) and 1970-01-01
const MAC_EPOCH = 2082844800

const BRANDS = {
  isom: 'ISO base media', iso2: 'ISO base media v2', iso4: 'ISO base media v4', iso5: 'ISO base media v5', iso6: 'ISO base media v6',
  mp41: 'MP4 v1', mp42: 'MP4 v2', avc1: 'MP4 with H.264', 'qt  ': 'QuickTime', 'M4A ': 'Apple audio (M4A)', 'M4B ': 'Apple audiobook',
  'M4P ': 'Apple protected audio', 'M4V ': 'Apple video (M4V)', 'M4VH': 'Apple video', 'M4VP': 'Apple video', '3gp4': '3GPP', '3gp5': '3GPP',
  '3gp6': '3GPP', '3g2a': '3GPP2', heic: 'HEIC image', heix: 'HEIC image (extended)', heim: 'HEIC multi-layer', heis: 'HEIC scalable',
  hevc: 'HEVC image sequence', hevx: 'HEVC image sequence', mif1: 'HEIF image', mif2: 'HEIF image v2', msf1: 'HEIF image sequence', avif: 'AVIF image',
  avis: 'AVIF image sequence', crx: 'Canon raw (CR3)', dash: 'MPEG-DASH segment', cmfc: 'CMAF', f4v: 'Adobe Flash video', mmp4: 'Mobile MP4', 'MSNV': 'Sony PSP video'
}

export const IMAGE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'mif2', 'msf1', 'avif', 'avis'])

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta', 'mvex', 'moof', 'traf', 'mfra', 'iprp', 'ipco', 'sinf', 'schi', 'tref', 'ilst', 'gmhd', 'wave', 'tapt', 'clip', 'matt', 'rinf', 'grpl', 'strk', 'strd'])
// Full boxes (version and flags first) whose payload is a list of boxes, with
// how many bytes come before the list
const LIST_BOXES = { stsd: 8, dref: 8, iref: 4 }

const HANDLERS = { vide: 'Video', soun: 'Audio', hint: 'Hint', meta: 'Metadata', pict: 'Image', text: 'Text', subt: 'Subtitles', sbtl: 'Subtitles', tmcd: 'Timecode', clcp: 'Captions', auxv: 'Auxiliary video' }
const AUDIO_ENTRIES = new Set(['mp4a', 'Opus', 'fLaC', 'ac-3', 'ec-3', 'alac', 'samr', 'sawb', 'twos', 'sowt', 'lpcm', 'ipcm', 'fpcm', 'mp3 ', '.mp3', 'ulaw', 'alaw', 'dtsc'])
const VISUAL_ENTRIES = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp08', 'vp09', 'mp4v', 'jpeg', 'mjpa', 'apcn', 'apch', 'apcs', 'apco', 'ap4h', 'dvh1', 'dvhe', 's263', 'encv', 'png ', 'raw ', 'rle ', 'jpgc'])
const ILST_NAMES = { '©nam': 'Title', '©ART': 'Artist', '©alb': 'Album', '©day': 'Year', '©too': 'Encoder', '©gen': 'Genre', '©wrt': 'Composer', '©cmt': 'Comment', aART: 'Album artist', desc: 'Description', '©xyz': 'Location' }

function macDate(seconds) {
  return seconds ? formatDate(new Date((seconds - MAC_EPOCH) * 1000)) : null
}

function language(code) {
  if (!code || code === 0x7FFF) return null
  const chars = [(code >> 10) & 31, (code >> 5) & 31, code & 31].map(c => String.fromCharCode(c + 0x60))
  const text = chars.join('')
  return /^[a-z]{3}$/.test(text) && text !== 'und' ? text : null
}

/**
 * Parses the box tree. Returns facts gathered along the way plus fields.
 */
function parseBoxes(bytes) {
  const r = new ByteReader(bytes, false)
  const warnings = new Set()
  const facts = { brands: null, tracks: [], items: [], ispe: [], tags: [], order: [], fragments: 0, boxes: 0, mvhd: null, pitm: null }
  let track = null

  const fullBox = (s, children) => {
    const version = r.u8(s)
    children.push(field('Version', s, 1, version, 'Box format version'), field('Flags', s + 1, 3, `0x${r.u24(s).toString(16).padStart(6, '0')}`, 'Box flags', 'flags'))
    return version
  }

  // Decodes a leaf box payload into child fields and facts
  const leaf = (type, s, e, children, path) => {
    const len = e - s
    if (type === 'ftyp' && len >= 8) {
      const major = fourcc(bytes, s)
      const compatible = []
      for (let p = s + 8; p + 4 <= e && compatible.length < 64; p += 4) compatible.push(fourcc(bytes, p))
      facts.brands = facts.brands || { major, minor: r.u32(s + 4), compatible }
      children.push(field('Major brand', s, 4, `${major}${BRANDS[major] ? ` (${BRANDS[major]})` : ''}`, 'Best-fitting specification', 'magic'),
        field('Minor version', s + 4, 4, r.u32(s + 4), 'Version of the major brand'))
      if (compatible.length) children.push(field('Compatible brands', s + 8, compatible.length * 4, compatible.map(b => printable(b)).join(', '), 'Specifications the file also conforms to'))
      return
    }
    if ((type === 'mvhd' || type === 'mdhd') && len >= 24) {
      const version = fullBox(s, children)
      const wide = version === 1
      const need = wide ? 32 : 20
      if (len < need) return
      const created = wide ? r.u64(s + 4) : r.u32(s + 4)
      const modified = wide ? r.u64(s + 12) : r.u32(s + 8)
      const scaleAt = wide ? s + 20 : s + 12
      const timescale = r.u32(scaleAt)
      const duration = wide ? r.u64(scaleAt + 4) : r.u32(scaleAt + 4)
      const n = wide ? 8 : 4
      // All ones means the duration is unknown
      const unknown = r.u32(scaleAt + 4) === 0xFFFFFFFF && (!wide || r.u32(scaleAt + 8) === 0xFFFFFFFF)
      const seconds = timescale && !unknown ? duration / timescale : NaN
      children.push(field('Created', s + 4, n, macDate(created) || 'not set', 'Seconds since 1904'),
        field('Modified', s + 4 + n, n, macDate(modified) || 'not set', 'Seconds since 1904'),
        field('Timescale', scaleAt, 4, `${formatNumber(timescale)} units/s`, 'Time units per second'),
        field('Duration', scaleAt + 4, n, Number.isFinite(seconds) ? `${formatNumber(duration)} (${formatDuration(seconds)})` : formatNumber(duration), 'In timescale units'))
      if (type === 'mvhd') {
        facts.mvhd = facts.mvhd || { created, modified, timescale, duration, seconds }
        if (r.has(scaleAt + 4 + n + 76, 4)) children.push(field('Next track ID', scaleAt + 4 + n + 76, 4, r.u32(scaleAt + 4 + n + 76), 'ID for a new track'))
      } else if (track) {
        track.seconds = seconds
        track.timescale = timescale
        const lang = language(r.u16(scaleAt + 4 + n))
        if (lang) track.language = lang
        children.push(field('Language', scaleAt + 4 + n, 2, lang || 'undetermined', 'ISO 639-2 code, packed'))
      }
      return
    }
    if (type === 'tkhd' && len >= 84) {
      const version = fullBox(s, children)
      const wide = version === 1
      const n = wide ? 8 : 4
      const idAt = s + 4 + 2 * n
      const durationAt = idAt + 8
      const sizeAt = durationAt + n + 52
      if (!r.has(sizeAt, 8) || sizeAt + 8 > e) return
      const width = r.u32(sizeAt) / 65536
      const height = r.u32(sizeAt + 4) / 65536
      if (track) Object.assign(track, { id: r.u32(idAt), width, height })
      children.push(field('Track ID', idAt, 4, r.u32(idAt), 'Unique within the movie'),
        field('Duration', durationAt, n, formatNumber(wide ? r.u64(durationAt) : r.u32(durationAt)), 'In movie timescale units'),
        field('Width', sizeAt, 4, `${+width.toFixed(2)}px`, '16.16 fixed point'),
        field('Height', sizeAt + 4, 4, `${+height.toFixed(2)}px`, '16.16 fixed point'))
      return
    }
    if (type === 'hdlr' && len >= 12) {
      fullBox(s, children)
      const handler = fourcc(bytes, s + 8)
      if (track && path[path.length - 2] === 'mdia') track.handler = handler
      const nameStart = s + 24
      const name = nameStart < e ? printable(utf8(bytes, nameStart, Math.min(e - nameStart, 256)).replace(/\0[\s\S]*$/, ''), 80) : ''
      children.push(field('Handler type', s + 8, 4, `${handler}${HANDLERS[handler] ? ` (${HANDLERS[handler]})` : ''}`, 'What the track or metadata holds'))
      if (name) children.push(field('Name', nameStart, e - nameStart, name, 'Human-readable handler name', 'string'))
      return
    }
    if (type === 'stsz' && len >= 12) {
      fullBox(s, children)
      const count = r.u32(s + 8)
      if (track) track.samples = count
      children.push(field('Sample size', s + 4, 4, r.u32(s + 4) || 'varies', 'Shared size, or 0 if each is listed', 'size'),
        field('Sample count', s + 8, 4, formatNumber(count), 'Samples in the track', 'count'))
      return
    }
    if (type === 'ispe' && len >= 12) {
      fullBox(s, children)
      const size = { width: r.u32(s + 4), height: r.u32(s + 8) }
      if (facts.ispe.length < 256) facts.ispe.push(size)
      children.push(field('Width', s + 4, 4, `${size.width}px`, 'Image width'), field('Height', s + 8, 4, `${size.height}px`, 'Image height'))
      return
    }
    if (type === 'pitm' && len >= 6) {
      const version = fullBox(s, children)
      facts.pitm = version === 0 ? r.u16(s + 4) : r.u32(s + 4)
      children.push(field('Primary item ID', s + 4, version === 0 ? 2 : 4, facts.pitm, 'The image shown by default'))
      return
    }
    if (type === 'infe' && len >= 8) {
      const version = fullBox(s, children)
      if (version >= 2) {
        const idSize = version === 2 ? 2 : 4
        const id = idSize === 2 ? r.u16(s + 4) : r.u32(s + 4)
        const typeAt = s + 4 + idSize + 2
        if (typeAt + 4 > e) return
        const itemType = fourcc(bytes, typeAt)
        if (facts.items.length < 10000) facts.items.push({ id, type: itemType })
        children.push(field('Item ID', s + 4, idSize, id, 'Item identifier'), field('Item type', typeAt, 4, itemType, 'Codec or metadata kind'))
      }
      return
    }
    if (type === 'avcC' && len >= 4) {
      const profiles = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4' }
      const profile = r.u8(s + 1)
      if (track) track.profile = `${profiles[profile] || `profile ${profile}`}, level ${(r.u8(s + 3) / 10).toFixed(1)}`
      children.push(field('Profile', s + 1, 1, profiles[profile] || profile, 'H.264 profile'), field('Level', s + 3, 1, (r.u8(s + 3) / 10).toFixed(1), 'H.264 level'))
      return
    }
    if (type === 'data' && path[path.length - 3] === 'ilst' && len > 8) {
      const key = path[path.length - 2]
      const name = ILST_NAMES[key]
      if (name && r.u32(s) === 1 && facts.tags.length < 32) facts.tags.push([name, printable(utf8(bytes, s + 8, Math.min(len - 8, 512)), 120)])
      children.push(field('Type', s, 4, r.u32(s) === 1 ? 'UTF-8 text' : r.u32(s), 'Well-known data type'), field('Value', s + 8, len - 8, name && r.u32(s) === 1 ? printable(utf8(bytes, s + 8, Math.min(len - 8, 256)), 80) : formatBytes(len - 8), 'Tag value', 'data'))
    }
  }

  // Sample entries in stsd have fixed fields before their child boxes
  const sampleEntryPrefix = (type, s, e, children) => {
    if (VISUAL_ENTRIES.has(type) && e - s >= 78) {
      const width = r.u16(s + 24)
      const height = r.u16(s + 26)
      if (track) Object.assign(track, { codec: type, codedWidth: width, codedHeight: height })
      children.push(field('Data reference index', s + 6, 2, r.u16(s + 6), 'Which dref entry holds the data'),
        field('Width', s + 24, 2, `${width}px`, 'Coded width'), field('Height', s + 26, 2, `${height}px`, 'Coded height'),
        field('Compressor name', s + 42, 32, printable(utf8(bytes, s + 43, Math.min(r.u8(s + 42), 31))), 'Pascal string', 'string'),
        field('Depth', s + 74, 2, r.u16(s + 74), 'Bits per pixel'))
      return 78
    }
    if (AUDIO_ENTRIES.has(type) && e - s >= 28) {
      const version = r.u16(s + 8)
      const channels = r.u16(s + 16)
      const sampleRate = r.u32(s + 24) / 65536
      if (track) Object.assign(track, { codec: type, channels, sampleRate })
      children.push(field('Data reference index', s + 6, 2, r.u16(s + 6), 'Which dref entry holds the data'),
        field('Channels', s + 16, 2, channels, 'Channel count', 'count'), field('Sample size', s + 18, 2, r.u16(s + 18), 'Bits per sample'),
        field('Sample rate', s + 24, 4, `${formatNumber(sampleRate)} Hz`, '16.16 fixed point'))
      return 28 + (version === 1 ? 16 : version === 2 ? 36 : 0)
    }
    if (track) track.codec = type
    return -1
  }

  const walk = (start, end, depth, path) => {
    const fields = []
    let pos = start
    let hidden = 0
    let hiddenEnd = start
    while (pos + 8 <= end) {
      if (facts.boxes >= MAX_BOXES) {
        warnings.add(`Stopped after ${formatNumber(MAX_BOXES)} boxes`)
        break
      }
      facts.boxes++
      let size = r.u32(pos)
      const type = fourcc(bytes, pos + 4)
      let header = 8
      const children = [field('Size', pos, 4, size === 0 ? '0 (to end of file)' : size === 1 ? '1 (64-bit size follows)' : formatNumber(size), 'Box length including this header', 'size'),
        field('Type', pos + 4, 4, type, 'Four-character box type', 'magic')]
      if (size === 1) {
        if (!r.has(pos + 8, 8)) {
          warnings.add(`Box "${printable(type)}" at offset ${pos} is truncated`)
          break
        }
        size = r.u64(pos + 8)
        children.push(field('Large size', pos + 8, 8, formatNumber(size), '64-bit box length', 'size'))
        header = 16
      } else if (size === 0) {
        size = end - pos
      }
      if (size < header) {
        warnings.add(`Box "${printable(type)}" at offset ${pos} has an invalid size (${size})`)
        break
      }
      if (type === 'uuid') {
        children.push(field('User type', pos + header, 16, undefined, 'Extended type UUID'))
        header += 16
      }
      if (pos + size > end) warnings.add(`Box "${printable(type)}" at offset ${pos} runs past the end of its ${pos + size > bytes.length ? 'file' : 'parent'}`)
      const boxEnd = Math.min(pos + size, end)
      const payload = pos + header
      if (depth === 0) facts.order.push(type)
      if (type === 'moof') facts.fragments++

      let childStart = -1
      if (CONTAINERS.has(type)) {
        childStart = payload
      } else if (type === 'meta') {
        // ISO meta is a full box; QuickTime's is not
        const iso = fourcc(bytes, payload + 4) !== 'hdlr'
        if (iso) fullBox(payload, children)
        childStart = iso ? payload + 4 : payload
      } else if (LIST_BOXES[type] !== undefined) {
        fullBox(payload, children)
        if (type !== 'iref') children.push(field('Entry count', payload + 4, 4, r.u32(payload + 4), 'Child entries', 'count'))
        childStart = payload + LIST_BOXES[type]
      } else if (type === 'iinf') {
        const version = fullBox(payload, children)
        const countSize = version === 0 ? 2 : 4
        children.push(field('Entry count', payload + 4, countSize, version === 0 ? r.u16(payload + 4) : r.u32(payload + 4), 'Items in the file', 'count'))
        childStart = payload + 4 + countSize
      } else if (path[path.length - 1] === 'stsd') {
        const prefix = sampleEntryPrefix(type, payload, boxEnd, children)
        if (prefix >= 0) childStart = payload + prefix
      } else if (path[path.length - 1] === 'ilst' || path[path.length - 1] === 'wave') {
        childStart = payload
      }

      if (type === 'trak') {
        track = { index: facts.tracks.length + 1 }
        if (facts.tracks.length < 64) facts.tracks.push(track)
      }
      if (childStart >= 0 && childStart <= boxEnd && depth < MAX_DEPTH) {
        children.push(...walk(childStart, boxEnd, depth + 1, [...path, type]))
      } else if (childStart < 0) {
        leaf(type, payload, boxEnd, children, [...path, type])
        if (type === 'mdat' && boxEnd > payload) children.push(field('Media data', payload, boxEnd - payload, formatBytes(boxEnd - payload), 'Interleaved samples', 'data'))
      }
      if (type === 'trak') track = null

      const label = path[path.length - 1] === 'ilst' && ILST_NAMES[type] ? `${type} (${ILST_NAMES[type]})` : type
      if (fields.length < MAX_CHILDREN_SHOWN) fields.push(field(printable(label), pos, boxEnd - pos, size > 1024 ? formatBytes(size) : undefined, describeBox(type), 'header', children))
      else {
        hidden++
        hiddenEnd = boxEnd
      }
      if (pos + size <= pos) break
      pos += size
    }
    if (pos < end && pos + 8 > end && end <= bytes.length && depth === 0) {
      warnings.add(`${plural(end - pos, 'byte')} at offset ${pos} too short for a box header`)
    }
    return capFields(fields, MAX_CHILDREN_SHOWN, 'more boxes', hidden, hiddenEnd)
  }

  const fields = walk(0, bytes.length, 0, [])
  return { facts, fields, warnings }
}

const BOX_DESCRIPTIONS = {
  ftyp: 'File type and compatible brands', moov: 'Movie metadata', mvhd: 'Movie header', trak: 'Track', tkhd: 'Track header', mdia: 'Media',
  mdhd: 'Media header', hdlr: 'Handler', minf: 'Media information', stbl: 'Sample table', stsd: 'Sample descriptions', stts: 'Decoding times',
  stsc: 'Samples per chunk', stsz: 'Sample sizes', stco: 'Chunk offsets', co64: 'Chunk offsets (64-bit)', stss: 'Sync samples', mdat: 'Media data',
  free: 'Free space', skip: 'Free space', wide: 'Reserved for a 64-bit size', udta: 'User data', meta: 'Metadata', ilst: 'iTunes metadata list',
  edts: 'Edit list container', elst: 'Edit list', dinf: 'Data information', dref: 'Data references', moof: 'Movie fragment', mfra: 'Fragment random access',
  iinf: 'Item information', infe: 'Item info entry', iloc: 'Item locations', iprp: 'Item properties', ipco: 'Property container', ipma: 'Property associations',
  ispe: 'Image spatial extents', pitm: 'Primary item', iref: 'Item references', idat: 'Item data', colr: 'Colour information', pixi: 'Pixel information',
  avcC: 'H.264 configuration', hvcC: 'HEVC configuration', av1C: 'AV1 configuration', esds: 'Elementary stream descriptor', vmhd: 'Video media header',
  smhd: 'Sound media header', sidx: 'Segment index', styp: 'Segment type', uuid: 'Extension box', pasp: 'Pixel aspect ratio', btrt: 'Bit rate'
}

function describeBox(type) {
  return BOX_DESCRIPTIONS[type] || (VISUAL_ENTRIES.has(type) ? 'Visual sample entry' : AUDIO_ENTRIES.has(type) ? 'Audio sample entry' : 'Box')
}

export function parseISOBMFF(bytes) {
  const { facts, fields, warnings } = parseBoxes(bytes)
  const summary = []
  const regions = fields.filter(f => !f.name.startsWith('…')).map(f => ({ name: f.name, offset: f.offset, length: f.length, kind: f.name === 'mdat' ? 'data' : f.name === 'free' || f.name === 'skip' ? 'padding' : 'metadata' }))
  const brands = facts.brands
  const major = brands ? brands.major : null
  const all = brands ? [major, ...brands.compatible] : []
  const tracks = facts.tracks
  const hasVideo = tracks.some(t => t.handler === 'vide')
  const hasAudio = tracks.some(t => t.handler === 'soun')
  let formatName = 'ISO Media File'
  if (major && IMAGE_BRANDS.has(major)) formatName = major.startsWith('avi') ? 'AVIF Image' : major === 'mif1' || major === 'msf1' || major === 'mif2' ? (all.includes('avif') ? 'AVIF Image' : 'HEIF Image') : 'HEIC Image'
  else if (major === 'qt  ' || (!brands && facts.order.includes('moov'))) formatName = 'QuickTime Movie'
  else if (major && major.startsWith('3g')) formatName = '3GPP Media'
  else if (major === 'M4A ' || major === 'M4B ' || (hasAudio && !hasVideo)) formatName = major === 'M4B ' ? 'M4B Audiobook' : 'MP4 Audio'
  else if (major === 'crx ') formatName = 'Canon CR3 Raw Image'
  else if (hasVideo || major) formatName = 'MP4 Video'

  if (brands) {
    summary.push(item('Major Brand', `${printable(major)}${BRANDS[major] ? ` (${BRANDS[major]})` : ''}`))
    summary.push(item('Minor Version', brands.minor))
    if (brands.compatible.length) summary.push(item('Compatible Brands', brands.compatible.map(b => printable(b.trim())).filter(Boolean).join(', ')))
  } else {
    summary.push(item('File Type Box', 'None (classic QuickTime layout)'))
  }
  if (facts.mvhd) {
    if (facts.fragments && !facts.mvhd.seconds) summary.push(item('Duration', 'Not in the header (fragmented file)'))
    else if (Number.isFinite(facts.mvhd.seconds)) summary.push(item('Duration', formatDuration(facts.mvhd.seconds)))
    if (facts.mvhd.created) summary.push(item('Created', macDate(facts.mvhd.created)))
    summary.push(item('Timescale', `${formatNumber(facts.mvhd.timescale)} units/s`))
  }
  tracks.forEach(t => {
    const kind = HANDLERS[t.handler] || (t.handler ? printable(t.handler) : 'Unknown')
    const parts = [t.codec ? printable(t.codec) : null]
    if (t.handler === 'vide' && (t.codedWidth || t.width)) parts.push(`${t.codedWidth || Math.round(t.width)}×${t.codedHeight || Math.round(t.height)}`)
    if (t.profile) parts.push(t.profile)
    if (t.handler === 'soun' && t.sampleRate) parts.push(`${formatNumber(t.sampleRate)} Hz`, `${t.channels} ch`)
    const fragmentedEmpty = facts.fragments > 0 && !t.samples
    if (Number.isFinite(t.seconds) && !fragmentedEmpty) parts.push(formatDuration(t.seconds))
    if (t.samples !== undefined && !fragmentedEmpty) parts.push(plural(t.samples, 'sample'))
    if (t.language) parts.push(t.language)
    summary.push(item(`Track ${t.id || t.index}`, `${kind}: ${parts.filter(Boolean).join(', ')}`, null, 'Tracks'))
  })
  if (facts.items.length) {
    const counts = {}
    for (const entry of facts.items) counts[entry.type] = (counts[entry.type] || 0) + 1
    summary.push(item('Items', formatNumber(facts.items.length), Object.entries(counts).map(([type, count]) => `${printable(type)}: ${count}`)))
    if (facts.pitm !== null) {
      const primary = facts.items.find(entry => entry.id === facts.pitm)
      summary.push(item('Primary Item', `#${facts.pitm}${primary ? ` (${printable(primary.type)})` : ''}`))
    }
    if (counts.Exif) summary.push(item('EXIF', 'Present'))
  }
  if (facts.ispe.length) {
    const largest = facts.ispe.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
    summary.push(item('Image Size', `${largest.width}×${largest.height}`, facts.ispe.length > 1 ? [`Largest of ${facts.ispe.length} image extents`] : null))
  }
  if (facts.fragments) summary.push(item('Fragmented', `Yes (${plural(facts.fragments, 'fragment')})`))
  const moov = facts.order.indexOf('moov')
  const mdat = facts.order.indexOf('mdat')
  if (moov >= 0 && mdat >= 0) summary.push(item('Fast Start', moov < mdat ? 'Yes (metadata before media)' : 'No (metadata after media)'))
  facts.tags.forEach(([label, value]) => summary.push(item(label, value, null, 'Tags')))
  summary.push(item('Top-Level Boxes', facts.order.slice(0, 24).map(type => printable(type)).join(', ') + (facts.order.length > 24 ? ', …' : '')))
  return { formatName, summary, fields, regions, warnings: [...warnings] }
}

const LEGACY_FIRST = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'])

/** Major brand of an ISO BMFF file, '' for a classic QuickTime file, or null */
export function isoBrand(bytes) {
  if (bytes.length < 12) return null
  const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])
  if (type === 'ftyp') return size >= 16 && size <= 4096 ? String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) : null
  if (!LEGACY_FIRST.has(type) || size < 8) return null
  if (size === bytes.length) return ''
  if (size + 8 > bytes.length) return null
  // The next box must look like a box too
  const next = String.fromCharCode(bytes[size + 4], bytes[size + 5], bytes[size + 6], bytes[size + 7])
  return /^[a-z]{4}$/.test(next) ? '' : null
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'isobmff',
  name: 'ISO Media File',
  category: 'media',
  detect: bytes => isoBrand(bytes) !== null,
  parse: fitted(parseISOBMFF)
}
