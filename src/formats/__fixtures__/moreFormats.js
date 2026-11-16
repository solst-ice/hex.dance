// Builders for small in-memory files used by the tests of the formats added
// alongside the original nine. Each returns a Uint8Array; checksums are
// computed here independently of the parsers.

const encoder = new TextEncoder()

export function bytesOf(...parts) {
  const arrays = parts.flat(Infinity).map(part => (typeof part === 'number' ? Uint8Array.of(part) : typeof part === 'string' ? encoder.encode(part) : part))
  const out = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0))
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

export const ascii = text => Uint8Array.from(text, c => c.charCodeAt(0))
export const zeros = n => new Uint8Array(n)

function int(size, value, little) {
  const out = new Uint8Array(size)
  let v = BigInt(value)
  for (let i = 0; i < size; i++) {
    out[little ? i : size - 1 - i] = Number(v & 0xFFn)
    v >>= 8n
  }
  return out
}
export const u16le = v => int(2, v, true)
export const u16be = v => int(2, v, false)
export const u24le = v => int(3, v, true)
export const u24be = v => int(3, v, false)
export const u32le = v => int(4, v, true)
export const u32be = v => int(4, v, false)
export const u64le = v => int(8, v, true)
export const u64be = v => int(8, v, false)

export function uleb(value) {
  const out = []
  do {
    let byte = value % 128
    value = Math.floor(value / 128)
    if (value > 0) byte |= 0x80
    out.push(byte)
  } while (value > 0)
  return Uint8Array.from(out)
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
export function crc32(bytes) {
  let crc = 0xFFFFFFFF
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// Deterministic pseudo-random bytes
export function noise(length, seed = 1) {
  const out = new Uint8Array(length)
  let x = seed >>> 0 || 1
  for (let i = 0; i < length; i++) {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    out[i] = x & 0xFF
  }
  return out
}

// --- Text -------------------------------------------------------------------

export const buildText = (text, { bom = false } = {}) => bytesOf(bom ? [0xEF, 0xBB, 0xBF] : [], text)

export function buildUtf16(text, little = true) {
  const out = [little ? [0xFF, 0xFE] : [0xFE, 0xFF]]
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    out.push(little ? [code & 0xFF, code >> 8] : [code >> 8, code & 0xFF])
  }
  return bytesOf(out)
}

// --- Compression ------------------------------------------------------------

// Raw DEFLATE streams made by zlib: fixed Huffman ("hello hello hello hello")
// and dynamic Huffman (a 150-byte pangram text)
export const DEFLATE_FIXED = Uint8Array.from([203, 72, 205, 201, 201, 87, 200, 64, 39, 1])
export const DEFLATE_FIXED_SIZE = 23
export const DEFLATE_DYNAMIC = Uint8Array.from(('0dcb471682300045d1ad7c37e0b197a1bd2b0ad6192581d00209a1adde8cdf7d5640902be6467004af52505e23544926c14b2250e81cdb6d03' +
  '8ffb5d18b676490347a38a1501282b894e2d4911b35c71a15f5f76d0eb0f86a3f1643a9bc3765c8f503f6061142729cf72210b555675d362b15cad37dbddfe703c9d2fd79b717f98d6f3f5fe7c7f7f').match(/../g).map(h => parseInt(h, 16)))
export const DEFLATE_DYNAMIC_SIZE = 150

/** A DEFLATE stream of stored blocks holding `data` */
export function deflateStored(data, blockSize = 65535) {
  const parts = []
  for (let i = 0; i < Math.max(1, data.length); i += blockSize) {
    const chunk = data.subarray(i, i + blockSize)
    const final = i + blockSize >= data.length ? 1 : 0
    parts.push(final, u16le(chunk.length), u16le(chunk.length ^ 0xFFFF), chunk)
  }
  return bytesOf(parts)
}

export function gzipMember({ deflate = DEFLATE_FIXED, size = DEFLATE_FIXED_SIZE, crc = 0x12345678, name = null, comment = null, extra = null, headerCrc = false, mtime = 1700000000, os = 3, xfl = 2 } = {}) {
  let flags = 0
  if (headerCrc) flags |= 2
  if (extra) flags |= 4
  if (name !== null) flags |= 8
  if (comment !== null) flags |= 16
  const header = bytesOf(0x1F, 0x8B, 8, flags, u32le(mtime), xfl, os,
    extra ? [u16le(extra.length), extra] : [], name !== null ? [name, 0] : [], comment !== null ? [comment, 0] : [])
  const hcrc = headerCrc ? u16le(crc32(header) & 0xFFFF) : []
  return bytesOf(header, hcrc, deflate, u32le(crc), u32le(size))
}

/** xz stream with one block holding `data` as uncompressed LZMA2 chunks and a CRC32 check */
export function buildXz(data = ascii('hello xz world\n')) {
  const header = bytesOf(0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00, 0x00, 0x01)
  const streamHeader = bytesOf(header, u32le(crc32(header.subarray(6, 8))))
  // Block header: size byte, flags (1 filter), LZMA2 filter id 0x21 with 1 property byte, padding, CRC32
  const blockHeaderBody = bytesOf(0x02, 0x00, 0x21, 0x01, 0x16, 0x00, 0x00, 0x00)
  const blockHeader = bytesOf(blockHeaderBody, u32le(crc32(blockHeaderBody)))
  const chunks = []
  for (let i = 0; i < data.length; i += 65536) {
    const chunk = data.subarray(i, i + 65536)
    chunks.push(i === 0 ? 0x01 : 0x02, u16be(chunk.length - 1), chunk)
  }
  const compressed = bytesOf(chunks, 0x00)
  const unpadded = blockHeader.length + compressed.length + 4
  const padding = zeros((4 - (compressed.length % 4)) % 4)
  const block = bytesOf(blockHeader, compressed, padding, u32le(crc32(data)))
  const indexBody = bytesOf(0x00, uleb(1), uleb(unpadded), uleb(data.length))
  const indexPadded = bytesOf(indexBody, zeros((4 - (indexBody.length % 4)) % 4))
  const index = bytesOf(indexPadded, u32le(crc32(indexPadded)))
  const footerBody = bytesOf(u32le(index.length / 4 - 1), 0x00, 0x01)
  const footer = bytesOf(u32le(crc32(footerBody)), footerBody, 0x59, 0x5A)
  return bytesOf(streamHeader, block, index, footer)
}

/** Writes bits most-significant first, as bzip2 does */
function bitWriter() {
  const bits = []
  return {
    put(value, count) {
      for (let i = count - 1; i >= 0; i--) bits.push(Math.floor(value / 2 ** i) % 2)
    },
    bytes() {
      const out = new Uint8Array(Math.ceil(bits.length / 8))
      bits.forEach((bit, i) => { if (bit) out[i >> 3] |= 0x80 >> (i & 7) })
      return out
    }
  }
}

/**
 * bzip2-shaped stream: header, `blocks` block markers each followed by
 * `junkBits` of filler (so later markers are not byte-aligned) and the
 * end-of-stream marker. The filler is not valid Huffman data.
 */
export function buildBzip2({ level = 9, blocks = 2, junkBits = 37, combinedCrc = 0xCAFEBABE } = {}) {
  const w = bitWriter()
  w.put(0x425A68, 24)
  w.put(0x30 + level, 8)
  for (let i = 0; i < blocks; i++) {
    w.put(0x314159, 24)
    w.put(0x265359, 24)
    w.put(0x11223344 + i, 32)
    for (let j = 0; j < junkBits; j++) w.put(j % 3 === 0 ? 1 : 0, 1)
  }
  w.put(0x177245, 24)
  w.put(0x385090, 24)
  w.put(combinedCrc, 32)
  return w.bytes()
}

/** Zstandard frame with raw blocks (valid and decodable) */
export function buildZstd(data = ascii('zstd raw block data'), { checksum = false, contentSize = true, skippable = false } = {}) {
  // Single segment with a 1-byte content size when it fits; otherwise a window descriptor
  const single = contentSize && data.length < 256
  const descriptor = (single ? 0x20 : 0) | (checksum ? 0x04 : 0) | (contentSize && !single ? 0x40 : 0)
  const header = [0x28, 0xB5, 0x2F, 0xFD, descriptor]
  if (!single) header.push(0x50)
  if (single) header.push(data.length)
  else if (contentSize) header.push(...u16le(data.length - 256))
  const blocks = []
  const size = Math.max(1, Math.ceil(data.length / 1000))
  for (let i = 0; i < size; i++) {
    const chunk = data.subarray(i * 1000, (i + 1) * 1000)
    const last = i === size - 1 ? 1 : 0
    blocks.push(u24le((chunk.length << 3) | last), chunk)
  }
  const frame = bytesOf(header, blocks, checksum ? u32le(0xDEADBEEF) : [])
  return skippable ? bytesOf(u32le(0x184D2A50), u32le(4), ascii('meta'), frame) : frame
}

/** 7z archive with an empty or plain header listing `names` (one empty file each) */
export function build7z({ names = ['a.txt', 'dir'], encodedHeader = false } = {}) {
  let header
  if (encodedHeader) {
    // kEncodedHeader + PackInfo(pos 0, 1 stream, size 5) + UnpackInfo(1 folder, LZMA2 coder, size 9)
    header = bytesOf(0x17, 0x06, 0x00, 0x01, 0x09, 0x05, 0x00, 0x07, 0x0B, 0x01, 0x00, 0x01, 0x21, 0x21, 0x01, 0x18, 0x0C, 0x09, 0x00, 0x00)
  } else {
    const nameBytes = []
    for (const name of names) {
      for (const ch of name) nameBytes.push(ch.charCodeAt(0), 0)
      nameBytes.push(0, 0)
    }
    const emptyStream = new Uint8Array(Math.ceil(names.length / 8)).fill(0)
    names.forEach((_, i) => { emptyStream[i >> 3] |= 0x80 >> (i & 7) })
    const attributes = [0x01, 0x00, ...names.flatMap(name => [...u32le(name === 'dir' ? 0x10 : 0x20)])]
    header = bytesOf(0x01, 0x05, names.length,
      0x0E, emptyStream.length, emptyStream,
      0x11, nameBytes.length + 1, 0x00, nameBytes,
      0x15, attributes.length, attributes,
      0x00, 0x00)
  }
  const packed = encodedHeader ? ascii('xxxxx') : new Uint8Array(0)
  const start = bytesOf(u64le(packed.length), u64le(header.length), u32le(crc32(header)))
  return bytesOf(0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0x00, 0x04, u32le(crc32(start)), start, packed, header)
}

function rar5Block(type, flags, fields, data = new Uint8Array(0), extra = new Uint8Array(0)) {
  const body = bytesOf(uleb(type), uleb(flags | (extra.length ? 1 : 0) | (data.length ? 2 : 0)), extra.length ? uleb(extra.length) : [], data.length ? uleb(data.length) : [], fields, extra)
  const sized = bytesOf(uleb(body.length), body)
  return bytesOf(u32le(crc32(sized)), sized, data)
}

/** RAR 5 archive: files are [{ name, data, dir?, encrypted? }] */
export function buildRar5(files = [{ name: 'hello.txt', data: ascii('hi there') }, { name: 'docs', dir: true }], { solid = false, end = true } = {}) {
  const blocks = [rar5Block(1, 0, uleb(solid ? 4 : 0))]
  for (const file of files) {
    const data = file.data || new Uint8Array(0)
    const name = encoder.encode(file.name)
    const fields = bytesOf(uleb(file.dir ? 1 : 0), uleb(data.length), uleb(0x20), uleb(3 << 7), uleb(1), uleb(name.length), name)
    const extra = file.encrypted ? bytesOf(uleb(2), uleb(1)) : new Uint8Array(0)
    blocks.push(rar5Block(2, 0, fields, data, extra))
  }
  if (end) blocks.push(rar5Block(5, 0, uleb(0)))
  return bytesOf(0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00, blocks)
}

function rar4Block(type, flags, fields, data = new Uint8Array(0)) {
  const size = 7 + fields.length
  const rest = bytesOf(type, u16le(flags), u16le(size), fields)
  return bytesOf(u16le(crc32(rest) & 0xFFFF), rest, data)
}

/** RAR 1.5-4.x archive */
export function buildRar4(files = [{ name: 'readme.txt', data: ascii('rar four') }, { name: 'sub', dir: true }]) {
  const blocks = [bytesOf(0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00), rar4Block(0x73, 0, zeros(6))]
  for (const file of files) {
    const data = file.data || new Uint8Array(0)
    const name = ascii(file.name)
    const flags = 0x8000 | (file.dir ? 0xE0 : 0)
    // pack size, unpacked size, host OS, CRC, DOS time (2020-01-02 03:04:06), version, method, name length, attributes
    const fields = bytesOf(u32le(data.length), u32le(data.length), 3, u32le(crc32(data)), u32le(0x50220000 | (3 << 11) | (4 << 5) | 3), 29, 0x30, u16le(name.length), u32le(file.dir ? 0x41ED : 0x81A4), name)
    blocks.push(rar4Block(0x74, flags, fields, data))
  }
  blocks.push(rar4Block(0x7B, 0x4000, new Uint8Array(0)))
  return bytesOf(blocks)
}

// --- Archives ---------------------------------------------------------------

function octal(value, length) {
  return bytesOf(value.toString(8).padStart(length - 1, '0'), 0)
}

function tarHeader({ name, size = 0, type = '0', mtime = 1600000000, magic = 'ustar\x0000', link = '', prefix = '' }) {
  const h = new Uint8Array(512)
  h.set(encoder.encode(name).subarray(0, 100), 0)
  h.set(octal(0o644, 8), 100)
  h.set(octal(1000, 8), 108)
  h.set(octal(1000, 8), 116)
  h.set(octal(size, 12), 124)
  h.set(octal(mtime, 12), 136)
  h.fill(0x20, 148, 156)
  h[156] = type.charCodeAt(0)
  h.set(encoder.encode(link), 157)
  if (magic) {
    h.set(ascii(magic), 257)
    h.set(ascii('user'), 265)
    h.set(ascii('group'), 297)
    h.set(encoder.encode(prefix), 345)
  }
  let sum = 0
  for (const b of h) sum += b
  h.set(bytesOf(sum.toString(8).padStart(6, '0'), 0, 0x20), 148)
  return h
}

const padBlock = data => bytesOf(data, zeros((512 - (data.length % 512)) % 512))

/** tar archive; entries are { name, data?, type?, link? }; format 'ustar' | 'gnu' | 'pax' | 'v7' */
export function buildTar(entries = [{ name: 'dir/', type: '5' }, { name: 'dir/a.txt', data: 'hello tar\n' }, { name: 'link', type: '2', link: 'dir/a.txt' }], { format = 'ustar', end = true, recordPadding = 0 } = {}) {
  const magic = format === 'gnu' ? 'ustar  \0' : format === 'v7' ? '' : 'ustar\x0000'
  const parts = []
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data || new Uint8Array(0)
    if (entry.name.length > 100) {
      if (format === 'gnu') {
        const long = bytesOf(entry.name, 0)
        parts.push(tarHeader({ name: '././@LongLink', size: long.length, type: 'L', magic }), padBlock(long))
      } else if (format === 'pax') {
        let record = ` path=${entry.name}\n`
        let length = record.length
        length += String(length + String(length).length).length
        record = `${length}${record}`
        const body = encoder.encode(record)
        parts.push(tarHeader({ name: 'PaxHeader/x', size: body.length, type: 'x', magic }), padBlock(body))
      }
    }
    parts.push(tarHeader({ name: entry.name.slice(0, 100), size: data.length, type: entry.type || '0', link: entry.link || '', magic }), padBlock(data))
  }
  if (end) parts.push(zeros(1024))
  parts.push(zeros(recordPadding))
  return bytesOf(parts)
}

// --- Images -----------------------------------------------------------------

export function buildBMP({ width = 4, height = 3, bpp = 24, headerSize = 40, topDown = false, trailing = 0 } = {}) {
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4
  const pixels = zeros(rowSize * height)
  const palette = bpp <= 8 ? zeros(4 * (1 << bpp)) : new Uint8Array(0)
  const dib = new Uint8Array(headerSize)
  const v = new DataView(dib.buffer)
  v.setUint32(0, headerSize, true)
  if (headerSize === 12) {
    v.setUint16(4, width, true)
    v.setUint16(6, height, true)
    v.setUint16(8, 1, true)
    v.setUint16(10, bpp, true)
  } else {
    v.setInt32(4, width, true)
    v.setInt32(8, topDown ? -height : height, true)
    v.setUint16(12, 1, true)
    v.setUint16(14, bpp, true)
    v.setUint32(20, pixels.length, true)
    v.setInt32(24, 2835, true)
    v.setInt32(28, 2835, true)
    if (headerSize >= 108) v.setUint32(56, 0x73524742, true)
  }
  const offset = 14 + headerSize + palette.length
  const size = offset + pixels.length + trailing
  return bytesOf(ascii('BM'), u32le(size), u32le(0), u32le(offset), dib, palette, pixels, zeros(trailing))
}

const PNG_HEADER = (w, h) => bytesOf(0x89, ascii('PNG\r\n'), 0x1A, 0x0A, u32be(13), ascii('IHDR'), u32be(w), u32be(h), 8, 6, 0, 0, 0, u32be(0))

/** ICO or CUR: images are { width, height, png? } */
export function buildICO(images = [{ width: 16, height: 16 }, { width: 32, height: 32, png: true }], { cursor = false } = {}) {
  const datas = images.map(image => {
    if (image.png) return PNG_HEADER(image.width, image.height)
    const dib = new Uint8Array(40)
    const v = new DataView(dib.buffer)
    v.setUint32(0, 40, true)
    v.setInt32(4, image.width, true)
    v.setInt32(8, image.height * 2, true)
    v.setUint16(12, 1, true)
    v.setUint16(14, 32, true)
    return bytesOf(dib, zeros(image.width * image.height * 4 + Math.ceil(image.width / 32) * 4 * image.height))
  })
  let offset = 6 + 16 * images.length
  const entries = images.map((image, i) => {
    const entry = bytesOf(image.width & 0xFF, image.height & 0xFF, 0, 0, u16le(cursor ? 3 : 1), u16le(cursor ? 4 : 32), u32le(datas[i].length), u32le(offset))
    offset += datas[i].length
    return entry
  })
  return bytesOf(u16le(0), u16le(cursor ? 2 : 1), u16le(images.length), entries, datas)
}

export function riffChunk(id, data) {
  const body = typeof data === 'string' ? ascii(data) : data
  return bytesOf(ascii(id), u32le(body.length), body, body.length % 2 ? 0 : [])
}

export const riffList = (type, ...chunks) => riffChunk('LIST', bytesOf(ascii(type), chunks))

export function buildRIFF(form, ...chunks) {
  const body = bytesOf(ascii(form), chunks)
  return bytesOf(ascii('RIFF'), u32le(body.length), body)
}

export function buildWebP(kind = 'VP8L', { width = 40, height = 30 } = {}) {
  if (kind === 'VP8') {
    return buildRIFF('WEBP', riffChunk('VP8 ', bytesOf(0x30, 0x01, 0x00, 0x9D, 0x01, 0x2A, u16le(width), u16le(height), zeros(8))))
  }
  if (kind === 'VP8X') {
    const vp8x = bytesOf(0x10 | 0x02, 0, 0, 0, u24le(width - 1), u24le(height - 1))
    const frame = bytesOf(u24le(0), u24le(0), u24le(width - 1), u24le(height - 1), u24le(100), 0)
    return buildRIFF('WEBP', riffChunk('VP8X', vp8x), riffChunk('ANIM', bytesOf(u32le(0), u16le(0))), riffChunk('ANMF', frame), riffChunk('ANMF', frame))
  }
  const bits = (width - 1) | ((height - 1) << 14) | (1 << 28)
  return buildRIFF('WEBP', riffChunk('VP8L', bytesOf(0x2F, u32le(bits >>> 0), zeros(5))))
}

export function buildWAV({ channels = 2, rate = 8000, bits = 16, seconds = 0.5, info = 'Test tone' } = {}) {
  const blockAlign = channels * bits / 8
  const data = zeros(Math.round(rate * seconds) * blockAlign)
  const fmt = bytesOf(u16le(1), u16le(channels), u32le(rate), u32le(rate * blockAlign), u16le(blockAlign), u16le(bits))
  return buildRIFF('WAVE', riffChunk('fmt ', fmt), riffChunk('data', data), riffList('INFO', riffChunk('INAM', bytesOf(info, 0))))
}

export function buildAVI({ width = 64, height = 48, frames = 5, usPerFrame = 40000 } = {}) {
  const avih = bytesOf(u32le(usPerFrame), u32le(0), u32le(0), u32le(0x10), u32le(frames), u32le(0), u32le(1), u32le(0), u32le(width), u32le(height), zeros(16))
  const strh = bytesOf(ascii('vids'), ascii('MJPG'), u32le(0), u32le(0), u32le(0), u32le(1), u32le(25), u32le(0), u32le(frames), zeros(20))
  const strf = bytesOf(u32le(40), u32le(width), u32le(height), u16le(1), u16le(24), ascii('MJPG'), zeros(20))
  const movi = Array.from({ length: frames }, () => riffChunk('00dc', zeros(10)))
  return buildRIFF('AVI ', riffList('hdrl', riffChunk('avih', avih), riffList('strl', riffChunk('strh', strh), riffChunk('strf', strf))), riffList('movi', movi), riffChunk('idx1', zeros(16 * frames)))
}

/**
 * TIFF with one strip per page; `exif` and `gps` add pointer tags and their
 * IFDs to the first page. Blobs are appended in order, so every offset is
 * known when it is written.
 */
export function buildTIFF({ little = true, width = 8, height = 4, exif = false, gps = false, pages = 1, extraTags = [] } = {}) {
  const w16 = little ? u16le : u16be
  const w32 = little ? u32le : u32be
  const blobs = []
  let size = 8
  const append = data => {
    const at = size
    blobs.push(data)
    size += data.length
    if (size % 2) {
      blobs.push(zeros(1))
      size++
    }
    return at
  }
  const encode = (type, values) => {
    if (type === 2) return bytesOf(values, 0)
    if (type === 5) return bytesOf(values.map(([n, d]) => [w32(n), w32(d)]))
    return bytesOf(values.map(v => (type === 3 ? w16(v) : w32(v))))
  }
  const writeIfd = (entries, next = 0) => {
    const sorted = [...entries].sort((a, b) => a[0] - b[0])
    const encoded = sorted.map(([, type, values]) => encode(type, values))
    const offsets = encoded.map(data => (data.length > 4 ? append(data) : null))
    const parts = [w16(sorted.length)]
    sorted.forEach(([tag, type], i) => {
      const count = type === 2 ? encoded[i].length : type === 5 ? encoded[i].length / 8 : encoded[i].length / (type === 3 ? 2 : 4)
      parts.push(w16(tag), w16(type), w32(count), offsets[i] !== null ? w32(offsets[i]) : bytesOf(encoded[i], zeros(4 - encoded[i].length)))
    })
    parts.push(w32(next))
    return append(bytesOf(parts))
  }
  const strip = zeros(width * height)
  const stripAt = append(strip)
  const exifAt = exif ? writeIfd([[33434, 5, [[1, 250]]], [33437, 5, [[28, 10]]], [34855, 3, [400]], [36867, 2, '2024:01:02 03:04:05']]) : null
  const gpsAt = gps ? writeIfd([[1, 2, 'N'], [2, 5, [[52, 1], [22, 1], [125, 10]]], [3, 2, 'W'], [4, 5, [[4, 1], [53, 1], [0, 1]]]]) : null
  let next = 0
  for (let p = pages - 1; p >= 0; p--) {
    const entries = [[256, 3, [width]], [257, 3, [height]], [258, 3, [8]], [259, 3, [p === 0 ? 1 : 5]], [262, 3, [1]], [271, 2, 'Maker'], [273, 4, [stripAt]],
      [277, 3, [1]], [278, 3, [height]], [279, 4, [strip.length]], [282, 5, [[300, 1]]], [283, 5, [[300, 1]]], [296, 3, [2]]]
    if (p === 0) {
      entries.push(...extraTags)
      if (exifAt !== null) entries.push([34665, 4, [exifAt]])
      if (gpsAt !== null) entries.push([34853, 4, [gpsAt]])
    }
    next = writeIfd(entries, next)
  }
  return bytesOf(little ? ascii('II') : ascii('MM'), w16(42), w32(next), blobs)
}

// --- ISO base media -----------------------------------------------------------

export const box = (type, ...payload) => {
  const body = bytesOf(payload)
  return bytesOf(u32be(body.length + 8), ascii(type), body)
}
const fullBox = (type, version, flags, ...payload) => box(type, version, u24be(flags), payload)

export function buildMP4({ brand = 'isom', video = true, audio = true, fragmented = false, heif = false } = {}) {
  const ftyp = box('ftyp', ascii(brand), u32be(512), ascii(brand), ascii(heif ? 'mif1' : 'mp41'))
  if (heif) {
    const meta = fullBox('meta', 0, 0,
      fullBox('hdlr', 0, 0, u32be(0), ascii('pict'), zeros(12), 0),
      fullBox('pitm', 0, 0, u16be(1)),
      fullBox('iinf', 0, 0, u16be(2), fullBox('infe', 2, 0, u16be(1), u16be(0), ascii(brand === 'avif' ? 'av01' : 'hvc1'), 0), fullBox('infe', 2, 0, u16be(2), u16be(0), ascii('Exif'), 0)),
      box('iprp', box('ipco', fullBox('ispe', 0, 0, u32be(640), u32be(480)))))
    return bytesOf(ftyp, meta, box('mdat', zeros(32)))
  }
  const mvhd = fullBox('mvhd', 0, 0, u32be(3786000000), u32be(3786000000), u32be(1000), u32be(fragmented ? 0 : 2500), u32be(0x10000), u16be(0x100), zeros(10), zeros(36), zeros(24), u32be(3))
  const trak = (id, handler, entry) => box('trak',
    fullBox('tkhd', 0, 3, u32be(0), u32be(0), u32be(id), u32be(0), u32be(2500), zeros(8), u16be(0), u16be(0), u16be(0), u16be(0), zeros(36), u32be(handler === 'vide' ? 320 << 16 : 0), u32be(handler === 'vide' ? 240 << 16 : 0)),
    box('mdia',
      fullBox('mdhd', 0, 0, u32be(0), u32be(0), u32be(handler === 'vide' ? 25 : 8000), u32be(handler === 'vide' ? 62 : 20000), u16be(0x15C7), u16be(0)),
      fullBox('hdlr', 0, 0, u32be(0), ascii(handler), zeros(12), ascii('Handler'), 0),
      box('minf', box('stbl', fullBox('stsd', 0, 0, u32be(1), entry), fullBox('stsz', 0, 0, u32be(0), u32be(handler === 'vide' ? 62 : 20))))))
  const visual = box('avc1', zeros(6), u16be(1), zeros(16), u16be(320), u16be(240), u32be(0x480000), u32be(0x480000), u32be(0), u16be(1), zeros(32), u16be(24), u16be(0xFFFF), box('avcC', 1, 100, 0, 31, 0xFF, 0xE0, 0))
  const sound = box('mp4a', zeros(6), u16be(1), zeros(8), u16be(2), u16be(16), u16be(0), u16be(0), u32be(8000 << 16))
  const tracks = []
  if (video) tracks.push(trak(1, 'vide', visual))
  if (audio) tracks.push(trak(2, 'soun', sound))
  const ilst = box('udta', fullBox('meta', 0, 0, fullBox('hdlr', 0, 0, u32be(0), ascii('mdir'), zeros(12), 0), box('ilst', box('\xA9nam', box('data', u32be(1), u32be(0), ascii('Fixture clip'))))))
  const moov = box('moov', mvhd, tracks, fragmented ? box('mvex', zeros(0)) : [], ilst)
  const mdat = box('mdat', zeros(64))
  return fragmented ? bytesOf(ftyp, moov, box('moof', fullBox('mfhd', 0, 0, u32be(1))), mdat) : bytesOf(ftyp, moov, mdat)
}

// --- Code and data ------------------------------------------------------------

const wasmName = text => bytesOf(uleb(encoder.encode(text).length), text)
const wasmSection = (id, body) => bytesOf(id, uleb(body.length), body)

export function buildWasm() {
  const types = wasmSection(1, bytesOf(1, 0x60, 2, 0x7F, 0x7F, 1, 0x7F))
  const imports = wasmSection(2, bytesOf(2, wasmName('env'), wasmName('log'), 0x00, 0, wasmName('env'), wasmName('memory'), 0x02, 0x00, 1))
  const functions = wasmSection(3, bytesOf(2, 0, 0))
  const globals = wasmSection(6, bytesOf(1, 0x7F, 0, 0x41, 0, 0x0B))
  const exports = wasmSection(7, bytesOf(2, wasmName('add'), 0x00, 1, wasmName('sub'), 0x00, 2))
  const body = bytesOf(0, 0x20, 0, 0x20, 1, 0x6A, 0x0B)
  const code = wasmSection(10, bytesOf(2, uleb(body.length), body, uleb(body.length), body))
  const names = wasmSection(0, bytesOf(wasmName('name'), 1, uleb(9), 2, 1, wasmName('add'), 2, wasmName('sub')))
  return bytesOf(0, 0x61, 0x73, 0x6D, u32le(1), types, imports, functions, globals, exports, code, names)
}

/** SQLite database of two 1024-byte pages; page 1 holds one schema row */
export function buildSQLite({ pageSize = 1024, pages = 2, tableName = 'items' } = {}) {
  const db = new Uint8Array(pageSize * pages)
  db.set(ascii('SQLite format 3\0'), 0)
  const v = new DataView(db.buffer)
  v.setUint16(16, pageSize === 65536 ? 1 : pageSize, false)
  db[18] = 1
  db[19] = 1
  db[21] = 64
  db[22] = 32
  db[23] = 32
  v.setUint32(24, 7, false)
  v.setUint32(28, pages, false)
  v.setUint32(44, 4, false)
  v.setUint32(56, 1, false)
  v.setUint32(92, 7, false)
  v.setUint32(96, 3045001, false)
  // sqlite_schema leaf page with one cell: type, name, tbl_name, rootpage, sql
  const sql = `CREATE TABLE ${tableName}(id INTEGER PRIMARY KEY, name TEXT)`
  const values = ['table', tableName, tableName].map(s => ascii(s))
  const types = [...values.map(s => 13 + 2 * s.length), 1, 13 + 2 * sql.length]
  const header = bytesOf(types.length + 1, ...types.map(t => (t < 128 ? [t] : [0x80 | (t >> 7), t & 0x7F])))
  const record = bytesOf(header.length, header.subarray(1), values, 2, ascii(sql))
  const cell = bytesOf(record.length < 128 ? record.length : [0x80 | (record.length >> 7), record.length & 0x7F], 1, record)
  const cellStart = pageSize - cell.length
  db.set(cell, cellStart)
  db.set([0x0D, 0, 0, 0, 1, cellStart >> 8, cellStart & 0xFF, 0], 100)
  db.set([cellStart >> 8, cellStart & 0xFF], 108)
  return db
}

// --- Audio --------------------------------------------------------------------

/** MPEG-1 Layer III, 128 kbit/s, 44.1 kHz frames (417 bytes) */
export function mp3Frame(padding = 0) {
  return bytesOf(0xFF, 0xFB, 0x90 | (padding << 1), 0xC4, zeros(413 + padding))
}

export function buildMP3({ frames = 4, id3 = true, id3v1 = false } = {}) {
  const parts = []
  if (id3) {
    const frame = (id, text) => {
      const body = bytesOf(3, text)
      return bytesOf(ascii(id), u32be(body.length), 0, 0, body)
    }
    const tag = bytesOf(frame('TIT2', 'Fixture song'), frame('TPE1', 'Test artist'), zeros(20))
    const size = tag.length
    parts.push(ascii('ID3'), 3, 0, 0, [(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F], tag)
  }
  for (let i = 0; i < frames; i++) parts.push(mp3Frame(0))
  if (id3v1) parts.push(ascii('TAG'), ascii('Old title'.padEnd(30, '\0')), ascii('Old artist'.padEnd(30, '\0')), zeros(30), ascii('1999'), zeros(31))
  return bytesOf(parts)
}

export function buildFLAC({ rate = 44100, channels = 2, bits = 16, samples = 88200, comments = ['TITLE=Fixture', 'ARTIST=Nobody'] } = {}) {
  const info = new Uint8Array(34)
  const v = new DataView(info.buffer)
  v.setUint16(0, 4096, false)
  v.setUint16(2, 4096, false)
  // sample rate (20) | channels-1 (3) | bits-1 (5) | total samples (36)
  const packed = (BigInt(rate) << 44n) | (BigInt(channels - 1) << 41n) | (BigInt(bits - 1) << 36n) | BigInt(samples)
  info.set(int(8, packed, false), 10)
  info.set(noise(16, 7), 18)
  const vorbis = bytesOf(u32le(7), ascii('fixture'), u32le(comments.length), comments.map(c => [u32le(encoder.encode(c).length), c]))
  const block = (type, data, last) => bytesOf((last ? 0x80 : 0) | type, u24be(data.length), data)
  return bytesOf(ascii('fLaC'), block(0, info, false), block(4, vorbis, false), block(1, zeros(16), true), 0xFF, 0xF8, zeros(30))
}

let oggTable = null
function oggCrc(bytes) {
  if (!oggTable) {
    oggTable = Array.from({ length: 256 }, (_, i) => {
      let c = i << 24
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04C11DB7 : c << 1
      return c >>> 0
    })
  }
  let crc = 0
  for (const b of bytes) crc = (oggTable[((crc >>> 24) ^ b) & 0xFF] ^ (crc << 8)) >>> 0
  return crc
}

export function oggPage({ type = 0, granule = 0, serial = 0x1234, sequence = 0, packets = [] }) {
  const lacing = []
  for (const packet of packets) {
    let n = packet.length
    while (n >= 255) {
      lacing.push(255)
      n -= 255
    }
    lacing.push(n)
  }
  const page = bytesOf(ascii('OggS'), 0, type, u64le(granule), u32le(serial), u32le(sequence), u32le(0), lacing.length, lacing, packets)
  page.set(u32le(oggCrc(page)), 22)
  return page
}

export function buildOgg({ codec = 'opus' } = {}) {
  const tags = (magic) => bytesOf(magic, u32le(7), ascii('fixture'), u32le(1), u32le(12), ascii('TITLE=Ogg ok'))
  const head = codec === 'opus'
    ? bytesOf(ascii('OpusHead'), 1, 2, u16le(312), u32le(48000), u16le(0), 0)
    : bytesOf(1, ascii('vorbis'), u32le(0), 1, u32le(44100), u32le(0), u32le(96000), u32le(0), 0xB8, 1)
  const comments = codec === 'opus' ? tags(ascii('OpusTags')) : bytesOf(tags(bytesOf(3, ascii('vorbis'))), 1)
  const rate = codec === 'opus' ? 48000 : 44100
  return bytesOf(
    oggPage({ type: 2, packets: [head] }),
    oggPage({ sequence: 1, packets: [comments] }),
    oggPage({ sequence: 2, granule: rate, packets: [zeros(100)] }),
    oggPage({ type: 4, sequence: 3, granule: rate * 2 + (codec === 'opus' ? 312 : 0), packets: [zeros(50)] }))
}

// --- Fonts --------------------------------------------------------------------

function sfntTables() {
  const head = bytesOf(u32be(0x10000), u32be(0x10000), u32be(0), u32be(0x5F0F3CF5), u16be(0), u16be(1000), u64be(3786000000), u64be(3786000000), zeros(18))
  const maxp = bytesOf(u32be(0x5000), u16be(42))
  const nameText = [[1, 'Fixture Sans'], [2, 'Regular'], [4, 'Fixture Sans Regular'], [5, 'Version 1.000']]
  let storage = []
  let offset = 0
  const records = nameText.map(([id, text]) => {
    const encoded = bytesOf([...text].map(c => [0, c.charCodeAt(0)]))
    const record = bytesOf(u16be(3), u16be(1), u16be(0x409), u16be(id), u16be(encoded.length), u16be(offset))
    storage.push(encoded)
    offset += encoded.length
    return record
  })
  const name = bytesOf(u16be(0), u16be(nameText.length), u16be(6 + 12 * nameText.length), records, storage)
  const os2 = bytesOf(u16be(4), u16be(500), u16be(400), u16be(5), u16be(0), zeros(10))
  return [['OS/2', os2], ['head', head], ['maxp', maxp], ['name', name]]
}

function tableChecksum(data) {
  const padded = bytesOf(data, zeros((4 - (data.length % 4)) % 4))
  let sum = 0
  for (let i = 0; i < padded.length; i += 4) sum = (sum + ((padded[i] << 24) | (padded[i + 1] << 16) | (padded[i + 2] << 8) | padded[i + 3])) >>> 0
  return sum
}

export function buildTTF() {
  const tables = sfntTables()
  const n = tables.length
  let offset = 12 + 16 * n
  const records = []
  const datas = []
  for (const [tag, data] of tables) {
    records.push(bytesOf(ascii(tag), u32be(tableChecksum(data)), u32be(offset), u32be(data.length)))
    const padded = bytesOf(data, zeros((4 - (data.length % 4)) % 4))
    datas.push(padded)
    offset += padded.length
  }
  return bytesOf(u32be(0x10000), u16be(n), u16be(64), u16be(2), u16be(0), records, datas)
}

/** WOFF 1.0 with every table stored uncompressed */
export function buildWOFF() {
  const tables = sfntTables()
  const n = tables.length
  let offset = 44 + 20 * n
  const records = []
  const datas = []
  for (const [tag, data] of tables) {
    records.push(bytesOf(ascii(tag), u32be(offset), u32be(data.length), u32be(data.length), u32be(tableChecksum(data))))
    const padded = bytesOf(data, zeros((4 - (data.length % 4)) % 4))
    datas.push(padded)
    offset += padded.length
  }
  return bytesOf(ascii('wOFF'), u32be(0x10000), u32be(offset), u16be(n), u16be(0), u32be(offset), u16be(1), u16be(0), zeros(20), records, datas)
}

/** WOFF2 header and table directory with a dummy compressed stream */
export function buildWOFF2() {
  const directory = bytesOf(1, uleb(54), 4, uleb(6), 10 | 0x00, uleb(1000), uleb(800), 11, uleb(200), uleb(0))
  const compressed = noise(40, 3)
  return bytesOf(ascii('wOF2'), u32be(0x10000), u32be(48 + directory.length + compressed.length), u16be(4), u16be(0), u32be(2000), u32be(compressed.length), u16be(1), u16be(0), zeros(20), directory, compressed)
}

// --- Captures and containers --------------------------------------------------

export function buildPcap({ packets = 3, little = true, nano = false } = {}) {
  const w32 = little ? u32le : u32be
  const w16 = little ? u16le : u16be
  const parts = [w32(nano ? 0xA1B23C4D : 0xA1B2C3D4), w16(2), w16(4), w32(0), w32(0), w32(65535), w32(1)]
  for (let i = 0; i < packets; i++) {
    const data = noise(60 + i, i + 1)
    parts.push(w32(1700000000 + i), w32(500000), w32(data.length), w32(data.length + (i === 0 ? 10 : 0)), data)
  }
  return bytesOf(parts)
}

export function buildPcapng({ packets = 2 } = {}) {
  const block = (type, body) => bytesOf(u32le(type), u32le(body.length + 12), body, u32le(body.length + 12))
  const option = (code, value) => {
    const data = typeof value === 'string' ? ascii(value) : value
    return bytesOf(u16le(code), u16le(data.length), data, zeros((4 - (data.length % 4)) % 4))
  }
  const shb = block(0x0A0D0D0A, bytesOf(u32le(0x1A2B3C4D), u16le(1), u16le(0), u64le(0xFFFFFFFFFFFFFFFFn), option(4, 'fixture'), u32le(0)))
  const idb = block(1, bytesOf(u16le(1), u16le(0), u32le(262144), option(2, 'eth0'), u32le(0)))
  const epbs = Array.from({ length: packets }, (_, i) => {
    const data = noise(42, i + 5)
    const stamp = BigInt(1700000000 + i) * 1000000n
    return block(6, bytesOf(u32le(0), u32le(Number(stamp >> 32n)), u32le(Number(stamp & 0xFFFFFFFFn)), u32le(data.length), u32le(data.length), data, zeros(2)))
  })
  return bytesOf(shb, idb, epbs)
}

/** Binary plist: { name: 'Fixture', count: 3, ok: true } */
export function buildBplist() {
  const objects = [
    bytesOf(0xD3, 1, 2, 3, 4, 5, 6),
    bytesOf(0x54, ascii('name')), bytesOf(0x55, ascii('count')), bytesOf(0x52, ascii('ok')),
    bytesOf(0x57, ascii('Fixture')), bytesOf(0x10, 3), bytesOf(0x09)
  ]
  const offsets = []
  let offset = 8
  for (const object of objects) {
    offsets.push(offset)
    offset += object.length
  }
  const trailer = bytesOf(zeros(6), 1, 1, u64be(objects.length), u64be(0), u64be(offset))
  return bytesOf(ascii('bplist00'), objects, offsets, trailer)
}

const tlv = (tag, ...content) => {
  const body = bytesOf(content)
  const length = body.length < 128 ? [body.length] : body.length < 256 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xFF]
  return bytesOf(tag, length, body)
}
const oid = (...bytes) => tlv(0x06, Uint8Array.from(bytes))
const name = (cn) => tlv(0x30, tlv(0x31, tlv(0x30, oid(0x55, 0x04, 0x06), tlv(0x13, ascii('NL')))), tlv(0x31, tlv(0x30, oid(0x55, 0x04, 0x03), tlv(0x0C, ascii(cn)))))

/** An X.509-shaped certificate (the key and signature are not real) */
export function buildCertificate() {
  const sha256rsa = tlv(0x30, oid(0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B), tlv(0x05))
  const rsaKey = tlv(0x30, tlv(0x02, 0x00, noise(64, 9)), tlv(0x02, 0x01, 0x00, 0x01))
  const spki = tlv(0x30, tlv(0x30, oid(0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01), tlv(0x05)), tlv(0x03, 0x00, rsaKey))
  const san = tlv(0x30, oid(0x55, 0x1D, 0x11), tlv(0x04, tlv(0x30, tlv(0x82, ascii('fixture.test')), tlv(0x82, ascii('www.fixture.test')))))
  const basic = tlv(0x30, oid(0x55, 0x1D, 0x13), tlv(0x01, 0xFF), tlv(0x04, tlv(0x30, tlv(0x01, 0xFF))))
  const tbs = tlv(0x30,
    tlv(0xA0, tlv(0x02, 0x02)),
    tlv(0x02, 0x01, 0x23, 0x45),
    sha256rsa,
    name('Fixture CA'),
    tlv(0x30, tlv(0x17, ascii('240102030405Z')), tlv(0x18, ascii('20341231235959Z'))),
    name('fixture.test'),
    spki,
    tlv(0xA3, tlv(0x30, basic, san)))
  return tlv(0x30, tbs, sha256rsa, tlv(0x03, 0x00, noise(64, 11)))
}

// --- ROMs and disks -----------------------------------------------------------

export function buildNES({ prg = 2, chr = 1, mapper = 1, vertical = true, battery = true, nes2 = false } = {}) {
  const header = bytesOf(ascii('NES'), 0x1A, prg, chr, ((mapper & 0x0F) << 4) | (vertical ? 1 : 0) | (battery ? 2 : 0), (mapper & 0xF0) | (nes2 ? 0x08 : 0), zeros(8))
  return bytesOf(header, zeros(prg * 16384), zeros(chr * 8192))
}

export const GB_LOGO = [
  0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00, 0x0D,
  0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E, 0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD, 0xD9, 0x99,
  0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC, 0xDD, 0xDC, 0x99, 0x9F, 0xBB, 0xB9, 0x33, 0x3E
]

export function buildGameBoy({ title = 'FIXTURE', cgb = 0x80, type = 0x03, romCode = 0, ramCode = 2 } = {}) {
  const rom = new Uint8Array(32768 << romCode)
  rom.set([0x00, 0xC3, 0x50, 0x01], 0x100)
  rom.set(GB_LOGO, 0x104)
  rom.set(ascii(title.slice(0, 11)), 0x134)
  rom[0x143] = cgb
  rom.set(ascii('01'), 0x144)
  rom[0x147] = type
  rom[0x148] = romCode
  rom[0x149] = ramCode
  rom[0x14A] = 1
  rom[0x14B] = 0x33
  let x = 0
  for (let i = 0x134; i <= 0x14C; i++) x = (x - rom[i] - 1) & 0xFF
  rom[0x14D] = x
  let sum = 0
  for (let i = 0; i < rom.length; i++) if (i !== 0x14E && i !== 0x14F) sum = (sum + rom[i]) & 0xFFFF
  rom[0x14E] = sum >> 8
  rom[0x14F] = sum & 0xFF
  return rom
}

const mbrEntry = (status, type, start, count) => bytesOf(status, 0, 2, 0, type, 0xFE, 0xFF, 0xFF, u32le(start), u32le(count))

export function buildMBR({ sectors = 64 } = {}) {
  const disk = new Uint8Array(512 * sectors)
  disk.set(u32le(0xA1B2C3D4), 440)
  disk.set(mbrEntry(0x80, 0x0C, 2, 20), 446)
  disk.set(mbrEntry(0, 0x83, 22, 40), 462)
  disk.set([0x55, 0xAA], 510)
  return disk
}

function guidBytes(text) {
  const hex = text.replace(/-/g, '')
  const b = hex.match(/../g).map(h => parseInt(h, 16))
  return Uint8Array.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.slice(8)])
}

export function buildGPT({ sectors = 128 } = {}) {
  const disk = new Uint8Array(512 * sectors)
  disk.set(mbrEntry(0, 0xEE, 1, sectors - 1), 446)
  disk.set([0x55, 0xAA], 510)
  const entries = new Uint8Array(128 * 128)
  const parts = [['C12A7328-F81F-11D2-BA4B-00A0C93EC93B', 34, 63, 'EFI'], ['0FC63DAF-8483-4772-8E79-3D69D8477DE4', 64, 120, 'root']]
  parts.forEach(([type, first, last, label], i) => {
    entries.set(guidBytes(type), i * 128)
    entries.set(noise(16, i + 20), i * 128 + 16)
    entries.set(u64le(first), i * 128 + 32)
    entries.set(u64le(last), i * 128 + 40)
    entries.set(bytesOf([...label].map(c => [c.charCodeAt(0), 0])), i * 128 + 56)
  })
  const header = bytesOf(ascii('EFI PART'), u32le(0x10000), u32le(92), u32le(0), u32le(0), u64le(1), u64le(sectors - 1), u64le(34), u64le(sectors - 34),
    guidBytes('12345678-1234-5678-9ABC-DEF012345678'), u64le(2), u32le(128), u32le(128), u32le(crc32(entries)))
  header.set(u32le(crc32(header)), 16)
  disk.set(header, 512)
  disk.set(entries, 1024)
  return disk
}

/** ISO 9660 image: primary descriptor, terminator, path tables, root with one file and one directory */
export function buildISO({ label = 'FIXTURE' } = {}) {
  const sector = 2048
  const image = new Uint8Array(sector * 23)
  const both32 = v => bytesOf(u32le(v), u32be(v))
  const both16 = v => bytesOf(u16le(v), u16be(v))
  const record = (extent, size, flags, nameText) => {
    const nameBytes = typeof nameText === 'string' ? ascii(nameText) : Uint8Array.of(nameText)
    return bytesOf(33 + nameBytes.length + (nameBytes.length % 2 === 0 ? 1 : 0), 0, both32(extent), both32(size), 124, 1, 2, 3, 4, 5, 0, flags, 0, 0, both16(1), nameBytes.length, nameBytes, nameBytes.length % 2 === 0 ? 0 : [])
  }
  const pathTable = (w32, w16) => bytesOf(1, 0, w32(18), w16(1), 0, 0, 3, 0, w32(19), w16(1), ascii('SUB'), 0)
  const pvd = new Uint8Array(sector)
  pvd.set(bytesOf(1, ascii('CD001'), 1, 0, ascii('LINUX'.padEnd(32)), ascii(label.padEnd(32)), zeros(8), both32(23), zeros(32), both16(1), both16(1), both16(sector), both32(22), u32le(20), u32le(0), u32be(22), u32be(0)), 0)
  pvd.set(record(18, sector, 2, 0), 156)
  pvd.set(ascii(''.padEnd(128)), 190)
  pvd.set(ascii('FIXTURE PUBLISHER'.padEnd(128)), 318)
  pvd.set(ascii(''.padEnd(128 * 2)), 446)
  pvd.set(ascii(''.padEnd(37 * 3)), 702)
  pvd.set(ascii('2024010203040500'), 813)
  pvd.set(ascii('2024010203040500'), 830)
  pvd.set(ascii('0000000000000000'), 847)
  pvd.set(ascii('0000000000000000'), 864)
  pvd[881] = 1
  image.set(pvd, 16 * sector)
  image.set(bytesOf(255, ascii('CD001'), 1), 17 * sector)
  image.set(bytesOf(record(18, sector, 2, 0), record(18, sector, 2, 1), record(21, 5, 0, 'HELLO.TXT;1'), record(19, sector, 2, 'SUB')), 18 * sector)
  image.set(bytesOf(record(19, sector, 2, 0), record(18, sector, 2, 1), record(21, 5, 0, 'NESTED.TXT;1')), 19 * sector)
  image.set(pathTable(u32le, u16le), 20 * sector)
  image.set(ascii('hello'), 21 * sector)
  image.set(pathTable(u32be, u16be), 22 * sector)
  return image
}
