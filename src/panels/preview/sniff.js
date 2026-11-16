// Decides whether the browser can show a file as an image, audio or video,
// from its first bytes, its MIME type or its extension.

/** @typedef {{ kind: 'image'|'audio'|'video', mime: string, label: string }} Media */

const media = (kind, mime, label) => ({ kind, mime, label })

export const PNG = media('image', 'image/png', 'PNG')
export const JPEG = media('image', 'image/jpeg', 'JPEG')
export const GIF = media('image', 'image/gif', 'GIF')
export const WEBP = media('image', 'image/webp', 'WebP')
export const BMP = media('image', 'image/bmp', 'BMP')
export const ICO = media('image', 'image/x-icon', 'ICO')
export const CUR = media('image', 'image/x-icon', 'Windows cursor')
export const SVG = media('image', 'image/svg+xml', 'SVG')
export const AVIF = media('image', 'image/avif', 'AVIF')
export const WAV = media('audio', 'audio/wav', 'WAV')
export const MP3 = media('audio', 'audio/mpeg', 'MP3')
export const AAC = media('audio', 'audio/aac', 'AAC')
export const FLAC = media('audio', 'audio/flac', 'FLAC')
export const OGG_AUDIO = media('audio', 'audio/ogg', 'Ogg audio')
export const OGG_VIDEO = media('video', 'video/ogg', 'Ogg video')
export const M4A = media('audio', 'audio/mp4', 'MPEG-4 audio')
export const MP4 = media('video', 'video/mp4', 'MPEG-4 video')
export const MOV = media('video', 'video/quicktime', 'QuickTime video')
export const WEBM = media('video', 'video/webm', 'WebM')
export const MKV = media('video', 'video/x-matroska', 'Matroska')

const BY_MIME = {
  'image/png': PNG, 'image/apng': PNG, 'image/jpeg': JPEG, 'image/pjpeg': JPEG, 'image/gif': GIF, 'image/webp': WEBP,
  'image/bmp': BMP, 'image/x-ms-bmp': BMP, 'image/x-icon': ICO, 'image/vnd.microsoft.icon': ICO,
  'image/svg+xml': SVG, 'image/avif': AVIF,
  'audio/wav': WAV, 'audio/x-wav': WAV, 'audio/wave': WAV, 'audio/mpeg': MP3, 'audio/mp3': MP3, 'audio/aac': AAC,
  'audio/flac': FLAC, 'audio/x-flac': FLAC, 'audio/ogg': OGG_AUDIO, 'audio/opus': OGG_AUDIO, 'audio/mp4': M4A,
  'audio/x-m4a': M4A, 'audio/webm': media('audio', 'audio/webm', 'WebM audio'),
  'video/mp4': MP4, 'video/webm': WEBM, 'video/ogg': OGG_VIDEO, 'video/quicktime': MOV
}

const BY_EXTENSION = {
  png: PNG, apng: PNG, jpg: JPEG, jpeg: JPEG, jpe: JPEG, jfif: JPEG, gif: GIF, webp: WEBP, bmp: BMP, dib: BMP,
  ico: ICO, cur: CUR, svg: SVG, avif: AVIF,
  wav: WAV, mp3: MP3, aac: AAC, flac: FLAC, ogg: OGG_AUDIO, oga: OGG_AUDIO, opus: OGG_AUDIO, m4a: M4A,
  mp4: MP4, m4v: MP4, webm: WEBM, ogv: OGG_VIDEO, mov: MOV, mkv: MKV
}

const BY_FORMAT_ID = { png: PNG, jpeg: JPEG, jpg: JPEG, gif: GIF, webp: WEBP, bmp: BMP, ico: ICO, svg: SVG, avif: AVIF }

const ascii = (bytes, at, length) => {
  let out = ''
  for (let i = at; i < at + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

const startsWith = (bytes, signature, at = 0) =>
  bytes.length >= at + signature.length && signature.every((v, i) => bytes[at + i] === v)

const u16le = (b, i) => b[i] | (b[i + 1] << 8)
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0

function sniffIco(bytes, type) {
  if (bytes.length < 22 || u16le(bytes, 0) !== 0 || u16le(bytes, 2) !== type) return null
  const count = u16le(bytes, 4)
  // first directory entry: reserved byte must be 0, and its data must start after the directory
  if (count < 1 || count > 512 || bytes[9] !== 0) return null
  const dataOffset = u32le(bytes, 18)
  if (dataOffset < 6 + 16 * count) return null
  return type === 1 ? ICO : CUR
}

function sniffBmp(bytes) {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null
  const dibSize = u32le(bytes, 14)
  const pixelOffset = u32le(bytes, 10)
  if (![12, 16, 40, 52, 56, 64, 108, 124].includes(dibSize)) return null
  return pixelOffset >= 14 + dibSize ? BMP : null
}

function sniffFtyp(bytes) {
  if (ascii(bytes, 4, 4) !== 'ftyp' || bytes.length < 12) return null
  const boxSize = Math.min(u32beSafe(bytes, 0), bytes.length, 256)
  const brands = [ascii(bytes, 8, 4)]
  for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(ascii(bytes, i, 4))
  if (brands.includes('avif') || brands.includes('avis')) return AVIF
  const major = brands[0]
  if (major === 'M4A ' || major === 'M4B ' || major === 'M4P ') return M4A
  if (major === 'qt  ') return MOV
  if (major.startsWith('hei') || major === 'mif1' || major === 'msf1') return null
  return MP4
}

function u32beSafe(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
}

function sniffSvg(bytes) {
  const head = ascii(bytes, 0, 4096).replace(/^\xEF\xBB\xBF/, '')
  const trimmed = head.trimStart()
  if (!trimmed.startsWith('<')) return null
  return /<svg[\s>]/i.test(trimmed) ? SVG : null
}

/** Media type from the file's first bytes (4 KB is plenty), or null. */
export function sniffBytes(bytes) {
  if (!bytes || bytes.length < 2) return null
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG
  const four = ascii(bytes, 0, 4)
  if (four === 'GIF8' && /^GIF8[79]a/.test(ascii(bytes, 0, 6))) return GIF
  if (four === 'RIFF') {
    const kind = ascii(bytes, 8, 4)
    if (kind === 'WEBP') return WEBP
    if (kind === 'WAVE') return WAV
    return null
  }
  if (four === 'fLaC') return FLAC
  if (four === 'OggS') {
    const head = ascii(bytes, 0, 128)
    if (head.includes('theora')) return OGG_VIDEO
    return OGG_AUDIO
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ascii(bytes, 0, 64).includes('webm') ? WEBM : MKV
  }
  const ftyp = sniffFtyp(bytes)
  if (ftyp) return ftyp
  if (ascii(bytes, 0, 3) === 'ID3') return MP3
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const layer = (bytes[1] >> 1) & 3
    const version = (bytes[1] >> 3) & 3
    if (layer === 0 && (bytes[1] & 0xf6) === 0xf0) return AAC
    if (layer !== 0 && version !== 1 && (bytes[2] >> 4) !== 0xf && ((bytes[2] >> 2) & 3) !== 3) return MP3
  }
  return sniffBmp(bytes) || sniffIco(bytes, 1) || sniffIco(bytes, 2) || sniffSvg(bytes)
}

export function mediaFromMime(type) {
  return BY_MIME[String(type || '').toLowerCase().split(';')[0].trim()] || null
}

export function mediaFromName(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return match ? BY_EXTENSION[match[1].toLowerCase()] || null : null
}

export function mediaFromFormatId(formatId) {
  return BY_FORMAT_ID[String(formatId || '').toLowerCase()] || null
}

/**
 * Best guess for the whole file. The bytes win; the analysis, MIME type and
 * extension are only used when the bytes are not recognised.
 */
export function chooseMedia({ bytes, fileName, mimeType, formatId }) {
  return sniffBytes(bytes) || mediaFromFormatId(formatId) || mediaFromMime(mimeType) || mediaFromName(fileName)
}
