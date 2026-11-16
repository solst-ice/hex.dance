import { isFourCC, latin1, u16be, u16le, u32be, u32le, u64be } from '../bytes.js'
import { oggCrc32 } from '../../../lib/crc32.js'
import { Reader } from '../source.js'
import { found, plural, hex } from './common.js'

/** FLAC: STREAMINFO first, metadata blocks, then a frame sync. Audio frames have no length, so the end is not computed. */
export async function flac(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 42)
  if (h.length < 42 || (h[4] & 0x7F) !== 0 || h[5] !== 0 || h[6] !== 0 || h[7] !== 34) return null
  const rate = (h[18] << 12) | (h[19] << 4) | (h[20] >> 4)
  const channels = ((h[20] >> 1) & 7) + 1
  if (!rate || rate > 655350) return null
  const r = new Reader(src)
  let pos = start + 4
  let blocks = 0
  for (;;) {
    if (!(await r.need(pos, 4)) || ctx.expired()) return null
    const i = pos - r.base
    const type = r.buf[i] & 0x7F
    if (type > 6) return null
    pos += 4 + ((r.buf[i + 1] << 16) | (r.buf[i + 2] << 8) | r.buf[i + 3])
    blocks++
    if (r.buf[i] & 0x80) break
  }
  const sync = (await r.need(pos, 2)) && r.u8(pos) === 0xFF && (r.u8(pos + 1) & 0xFE) === 0xF8
  return found(ctx, {
    type: 'flac', ext: 'flac', module: 'flac', name: 'FLAC audio',
    confidence: sync ? 'high' : 'medium', end: null,
    note: `${rate} Hz, ${channels} ch, ${plural(blocks, 'metadata block')}${sync ? ', first frame found' : ''}; audio frames do not record the stream length`
  })
}

/** Ogg: pages walked while they follow one another; the first page's CRC is checked. */
export async function ogg(ctx) {
  const { src, start } = ctx
  const r = new Reader(src)
  let pos = start
  let pages = 0
  let begun = 0
  let ended = 0
  let codec = ''
  const skip = []
  for (;;) {
    if (ctx.expired()) break
    if (!(await r.need(pos, 27))) break
    const i = pos - r.base
    if (u32be(r.buf, i) !== 0x4F676753 || r.buf[i + 4] !== 0) break
    const segments = r.buf[i + 26]
    if (!(await r.need(pos, 27 + segments))) break
    let body = 0
    for (let k = 0; k < segments; k++) body += r.u8(pos + 27 + k)
    const length = 27 + segments + body
    const flags = r.u8(pos + 5)
    if (pages < 2) {
      if (!(await r.need(pos, length))) break
      const j = pos - r.base
      const copy = r.buf.slice(j, j + length)
      const stored = u32le(copy, 22)
      copy.fill(0, 22, 26)
      if (oggCrc32(copy, 0, length) !== stored) break
      if (pages === 0) {
        const p = latin1(copy, 27 + segments, 8)
        codec = p.startsWith('\x01vorbis') ? 'Vorbis' : p.startsWith('OpusHead') ? 'Opus' : p.startsWith('\x80theora') ? 'Theora' : p.startsWith('\x7FFLAC') ? 'FLAC' : p.startsWith('Speex') ? 'Speex' : ''
      }
    }
    if (flags & 2) begun++
    if (flags & 4) ended++
    if (pos !== start) skip.push(pos)
    pos += length
    pages++
  }
  if (!pages) return null
  const complete = begun > 0 && begun === ended
  const ext = codec === 'Opus' ? 'opus' : codec === 'Theora' ? 'ogv' : 'ogg'
  return found(ctx, {
    type: 'ogg', ext, module: 'ogg', name: codec ? `Ogg ${codec}` : 'Ogg stream',
    confidence: 'high', end: Math.min(pos, ctx.size), endKind: complete ? 'exact' : 'estimated', skip,
    note: `${plural(pages, 'page')}; page CRC matches${complete ? ', every stream reaches its last page' : ''}`
  })
}

const RIFF_FORMS = {
  WEBP: { type: 'webp', module: 'webp', ext: 'webp', name: 'WebP image' },
  WAVE: { type: 'wav', module: 'wav', ext: 'wav', name: 'WAV audio' },
  'AVI ': { type: 'avi', module: 'avi', ext: 'avi', name: 'AVI video' },
  RMID: { type: 'riff', module: 'riff', ext: 'rmi', name: 'RIFF MIDI' },
  ACON: { type: 'riff', module: 'riff', ext: 'ani', name: 'Animated cursor' }
}

/** RIFF: form type, a chunk list that fills the declared size. */
export async function riff(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 20)
  if (h.length < 20) return null
  const size = u32le(h, 4)
  if (size < 12 || !isFourCC(h, 8) || !isFourCC(h, 12) || u32le(h, 16) > size) return null
  const form = latin1(h, 8, 4)
  const kind = RIFF_FORMS[form] || { type: 'riff', module: 'riff', ext: 'riff', name: `RIFF ${form.trim()}` }
  const end = start + 8 + size + (size & 1)
  const r = new Reader(src)
  let pos = start + 12
  let chunks = 0
  let filled = false
  while (!ctx.expired() && chunks < 100000) {
    if (pos >= start + 8 + size - 1) {
      filled = pos <= end
      break
    }
    if (!(await r.need(pos, 8)) || !isFourCC(r.buf, pos - r.base)) break
    const n = u32le(r.buf, pos - r.base + 4)
    pos += 8 + n + (n & 1)
    chunks++
  }
  return found(ctx, {
    ...kind, confidence: filled ? 'high' : 'medium', end,
    note: `${plural(chunks, 'chunk')}${filled ? ' filling the declared size' : ''}; size from the RIFF header`
  })
}

const HEIF_BRANDS = { heic: 'heic', heix: 'heic', mif1: 'heic', msf1: 'heic', hevc: 'heic', avif: 'avif', avis: 'avif' }

/** ISO base media (MP4, MOV, HEIF, AVIF, 3GP): top-level boxes walked from ftyp. */
export async function isobmff(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 16)
  if (h.length < 16) return null
  const ftypSize = u32be(h, 0)
  if (ftypSize < 16 || ftypSize > 1024 || ftypSize % 4 || !isFourCC(h, 8)) return null
  const brand = latin1(h, 8, 4)
  const r = new Reader(src)
  let pos = start
  const boxes = []
  let ok = false
  while (!ctx.expired() && boxes.length < 10000) {
    if (!(await r.need(pos, 16)) && !r.has(pos, 8)) {
      ok = pos === ctx.size
      break
    }
    const i = pos - r.base
    let size = u32be(r.buf, i)
    if (!isFourCC(r.buf, i + 4)) break
    const type = latin1(r.buf, i + 4, 4)
    if (size === 1) {
      if (!r.has(pos, 16)) break
      size = u64be(r.buf, i + 8)
    } else if (size === 0) {
      size = ctx.size - pos
    }
    if (size < 8) break
    boxes.push(type)
    pos += size
  }
  const major = boxes.some(b => b === 'moov' || b === 'mdat' || b === 'meta' || b === 'moof')
  if (!major && boxes.length < 2) return null
  const heif = HEIF_BRANDS[brand]
  const ext = heif || (brand === 'qt  ' ? 'mov' : brand.startsWith('3g') ? '3gp' : brand.startsWith('M4A') ? 'm4a' : 'mp4')
  return found(ctx, {
    type: heif ? 'heif' : 'isobmff', ext, module: heif ? 'heif' : 'isobmff',
    name: heif === 'avif' ? 'AVIF image' : heif ? 'HEIF image' : brand === 'qt  ' ? 'QuickTime movie' : 'MP4 / ISO media',
    confidence: major ? 'high' : 'medium', end: Math.min(pos, ctx.size), endKind: ok || pos >= ctx.size ? 'exact' : 'estimated',
    note: `brand "${brand.trim()}", boxes ${boxes.slice(0, 6).join(' ')}${boxes.length > 6 ? ' …' : ''}`
  })
}

const BITRATES = {
  '3-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '3-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '3-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
}
const RATES = [44100, 48000, 32000]

/** Length in bytes of the MPEG audio frame whose header is at b[i], or 0. */
export function mpegFrameLength(b, i) {
  if (b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) return 0
  const version = (b[i + 1] >> 3) & 3
  const layer = (b[i + 1] >> 1) & 3
  const bri = b[i + 2] >> 4
  const sri = (b[i + 2] >> 2) & 3
  const pad = (b[i + 2] >> 1) & 1
  if (version === 1 || layer === 0 || bri === 0 || bri === 15 || sri === 3) return 0
  const v1 = version === 3
  const table = v1 ? BITRATES[`3-${layer}`] : BITRATES[layer === 3 ? '2-3' : '2-2']
  const bitrate = table[bri] * 1000
  const rate = RATES[sri] / (v1 ? 1 : version === 2 ? 2 : 4)
  if (layer === 3) return (Math.floor((12 * bitrate) / rate) + pad) * 4
  if (layer === 1 && !v1) return Math.floor((72 * bitrate) / rate) + pad
  return Math.floor((144 * bitrate) / rate) + pad
}

/** MP3 with an ID3v2 tag: the tag's synchsafe size, then consecutive MPEG frames and an optional ID3v1 tag. */
export async function mp3(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 10)
  if (h.length < 10 || h[3] < 2 || h[3] > 4 || h[4] === 0xFF || (h[5] & 0x0F) || ((h[6] | h[7] | h[8] | h[9]) & 0x80)) return null
  const tagSize = (h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9]
  let pos = start + 10 + tagSize + (h[5] & 0x10 ? 10 : 0)
  const r = new Reader(src)
  // Some taggers pad with zeros past the declared size
  for (let k = 0; k < 4096 && (await r.need(pos, 1)) && r.u8(pos) === 0; k++) pos++
  if (await r.need(pos, 4) && latin1(r.buf, pos - r.base, 4) === 'fLaC') {
    return found(ctx, { type: 'mp3', ext: 'id3', module: 'mp3', name: 'ID3 tag', confidence: 'medium', end: pos, note: `ID3v2.${h[3]} tag in front of FLAC audio` })
  }
  let frames = 0
  while (!ctx.expired()) {
    if (!(await r.need(pos, 4))) break
    const n = mpegFrameLength(r.buf, pos - r.base)
    if (!n) break
    pos += n
    frames++
  }
  if (pos > ctx.size) pos = ctx.size
  if (frames && (await r.need(pos, 128)) && latin1(r.buf, pos - r.base, 3) === 'TAG') pos += 128
  if (frames < 3) {
    if (start + 10 + tagSize > ctx.size || tagSize === 0) return null
    return found(ctx, { type: 'mp3', ext: 'id3', module: 'mp3', name: 'ID3 tag', confidence: 'medium', end: start + 10 + tagSize, note: `ID3v2.${h[3]} tag; no MPEG audio frames follow it` })
  }
  return found(ctx, {
    type: 'mp3', ext: 'mp3', module: 'mp3', name: 'MP3 audio', confidence: 'high', end: pos, endKind: 'estimated',
    note: `ID3v2.${h[3]} tag and ${plural(frames, 'consecutive frame')}; the end is where the frames stop`
  })
}

/** iNES / NES 2.0: size from the PRG and CHR bank counts. */
export async function nes(ctx) {
  const h = await ctx.src.read(ctx.start, 16)
  if (h.length < 16 || h[4] === 0) return null
  const nes2 = (h[7] & 0x0C) === 0x08
  if (!nes2 && h.subarray(11, 16).some(v => v !== 0)) return null
  const prg = h[4] + (nes2 ? (h[9] & 0x0F) * 256 : 0)
  const chr = h[5] + (nes2 ? (h[9] >> 4) * 256 : 0)
  const size = 16 + (h[6] & 4 ? 512 : 0) + prg * 16384 + chr * 8192
  return found(ctx, {
    type: 'nes', ext: 'nes', module: 'nes', name: 'NES ROM', confidence: 'medium', end: ctx.start + size,
    note: `${nes2 ? 'NES 2.0' : 'iNES'}, ${prg} × 16 KB PRG, ${chr} × 8 KB CHR, mapper ${(h[6] >> 4) | (h[7] & 0xF0)}`
  })
}

/** Game Boy: the Nintendo logo at 0x104 and the header checksum. */
export async function gameboy(ctx) {
  const h = await ctx.src.read(ctx.start, 0x150)
  if (h.length < 0x150) return null
  let x = 0
  for (let i = 0x134; i <= 0x14C; i++) x = (x - h[i] - 1) & 0xFF
  if (x !== h[0x14D] || h[0x148] > 8) return null
  const title = latin1(h, 0x134, 16).replace(/[\0\x80-\xFF].*$/s, '').trim()
  return found(ctx, {
    type: 'gameboy', ext: h[0x143] & 0x80 ? 'gbc' : 'gb', module: 'gameboy', name: 'Game Boy ROM',
    confidence: 'high', end: ctx.start + (32768 << h[0x148]),
    note: `${title ? `"${title}", ` : ''}header checksum matches; size from the ROM size byte`
  })
}

const SFNT = new Set([0x00010000, 0x4F54544F, 0x74727565])

/** TrueType/OpenType: the binary-search fields must agree with the table count; WOFF and WOFF2 store their length. */
export async function font(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 44)
  if (h.length < 44) return null
  const tag = u32be(h, 0)
  if (tag === 0x774F4646 || tag === 0x774F4632) {
    const woff2 = tag === 0x774F4632
    const length = u32be(h, 8)
    if (!SFNT.has(u32be(h, 4)) || u16be(h, 14) !== 0 || !u16be(h, 12) || length < 44) return null
    return found(ctx, {
      type: 'font', ext: woff2 ? 'woff2' : 'woff', module: 'font', name: woff2 ? 'WOFF2 font' : 'WOFF font',
      confidence: 'high', end: start + length, note: `${plural(u16be(h, 12), 'table')}; length from its header`
    })
  }
  const n = u16be(h, 4)
  if (n < 1 || n > 64) return null
  const log = Math.floor(Math.log2(n))
  const searchRange = 16 * 2 ** log
  if (u16be(h, 6) !== searchRange || u16be(h, 8) !== log || u16be(h, 10) !== n * 16 - searchRange) return null
  const t = await src.read(start + 12, n * 16)
  if (t.length < n * 16) return null
  let end = 12 + n * 16
  let previous = ''
  for (let k = 0; k < n; k++) {
    const name = latin1(t, k * 16, 4)
    if (!/^[\x20-\x7E]{4}$/.test(name) || name < previous) return null
    previous = name
    end = Math.max(end, u32be(t, k * 16 + 8) + u32be(t, k * 16 + 12))
  }
  end = (end + 3) & ~3
  const cff = tag === 0x4F54544F
  return found(ctx, {
    type: 'font', ext: cff ? 'otf' : 'ttf', module: 'font', name: cff ? 'OpenType font' : 'TrueType font',
    confidence: 'high', end: start + end, note: `${plural(n, 'table')} in sorted order; ends after the last table`
  })
}

/** pcap: version 2.4, sane snapshot length and link type, then records walked while their lengths are plausible. */
export async function pcap(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 24)
  if (h.length < 24) return null
  const le = h[0] === 0xD4 || h[0] === 0x4D
  const nano = h[0] === 0x4D || h[3] === 0x4D
  const u16 = le ? u16le : u16be
  const u32 = le ? u32le : u32be
  const snap = u32(h, 16)
  const link = u32(h, 20) & 0x0FFFFFFF
  if (u16(h, 4) !== 2 || u16(h, 6) !== 4 || snap === 0 || snap > (1 << 24) || link > 300) return null
  const r = new Reader(src)
  let pos = start + 24
  let packets = 0
  while (!ctx.expired()) {
    if (!(await r.need(pos, 16))) break
    const i = pos - r.base
    const frac = u32(r.buf, i + 4)
    const incl = u32(r.buf, i + 8)
    const orig = u32(r.buf, i + 12)
    if (frac >= (nano ? 1e9 : 1e6) || incl > orig || incl > Math.max(snap, 262144) || orig > (1 << 24)) break
    if (pos + 16 + incl > ctx.size) break
    pos += 16 + incl
    packets++
  }
  return found(ctx, {
    type: 'pcap', ext: 'pcap', module: 'pcap', name: 'Packet capture',
    confidence: packets ? 'high' : 'medium', end: pos, endKind: pos >= ctx.size ? 'exact' : 'estimated',
    note: `${plural(packets, 'packet')}, link type ${link}; the end is where records stop`
  })
}

/** pcapng: section header with its byte-order magic, then blocks whose leading and trailing lengths agree. */
export async function pcapng(ctx) {
  const { src, start } = ctx
  const h = await src.read(start, 28)
  if (h.length < 28) return null
  const bom = u32le(h, 8)
  if (bom !== 0x1A2B3C4D && bom !== 0x4D3C2B1A) return null
  const u32 = bom === 0x1A2B3C4D ? u32le : u32be
  const r = new Reader(src)
  let pos = start
  let blocks = 0
  while (!ctx.expired()) {
    if (!(await r.need(pos, 12))) break
    const length = u32(r.buf, pos - r.base + 4)
    if (length < 12 || length % 4 || pos + length > ctx.size) break
    if (!(await r.need(pos + length - 4, 4)) || u32(r.buf, pos + length - 4 - r.base) !== length) break
    pos += length
    blocks++
  }
  if (!blocks) return null
  return found(ctx, {
    type: 'pcapng', ext: 'pcapng', module: 'pcap', name: 'Packet capture (pcapng)',
    confidence: 'high', end: pos, endKind: pos >= ctx.size ? 'exact' : 'estimated',
    note: `${plural(blocks, 'block')} whose leading and trailing lengths agree`
  })
}

/** Binary property list: the trailer that gives its size sits at its end, so only the version is checked. */
export async function bplist(ctx) {
  const h = await ctx.src.read(ctx.start, 9)
  if (h.length < 9 || (h[7] !== 0x30 && h[7] !== 0x31)) return null
  const marker = h[8] >> 4
  if (![0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x8, 0xA, 0xC, 0xD].includes(marker)) return null
  return found(ctx, {
    type: 'bplist', ext: 'plist', module: 'bplist', name: 'Binary property list',
    confidence: 'low', end: null, note: `version ${latin1(h, 6, 2)}; its size is only recorded in a trailer at its end (${hex(ctx.start)} onward)`
  })
}
