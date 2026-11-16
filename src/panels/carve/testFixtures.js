// Small, valid instances of the formats the scan knows, built in code for
// the tests. Only the structure the validators look at is filled in.

import { adler32, crc32, crc32ogg, fromLatin1 } from './bytes.js'

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const le16 = (v) => [v & 0xFF, (v >> 8) & 0xFF]
const le32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]
const be16 = (v) => [(v >> 8) & 0xFF, v & 0xFF]
const be32 = (v) => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]
const le64 = (v) => [...le32(v % 0x100000000), ...le32(Math.floor(v / 0x100000000))]
const bytes = (...parts) => Uint8Array.from(parts.flatMap(p => (typeof p === 'string' ? Array.from(p, c => c.charCodeAt(0)) : Array.isArray(p) || p instanceof Uint8Array ? [...p] : [p])))

/** Deterministic pseudo-random bytes (xorshift). */
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

/** zlib framing around a raw DEFLATE stream made of one stored block. */
export function zlibStored(data) {
  return concat(bytes(0x78, 0x01, 0x01, ...le16(data.length), ...le16(~data.length & 0xFFFF)), data, bytes(...be32(adler32(data))))
}

function pngChunk(type, data) {
  const body = concat(fromLatin1(type), data)
  return concat(bytes(...be32(data.length)), body, bytes(...be32(crc32(body))))
}

export function png(width = 2, height = 2) {
  const ihdr = bytes(...be32(width), ...be32(height), 8, 0, 0, 0, 0)
  const raw = new Uint8Array((width + 1) * height)
  return concat(fromLatin1('\x89PNG\r\n\x1a\n'), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlibStored(raw)), pngChunk('IEND', new Uint8Array(0)))
}

export function jpeg() {
  return bytes(
    0xFF, 0xD8,
    0xFF, 0xE0, ...be16(16), 'JFIF\0', 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xFF, 0xC0, ...be16(11), 8, ...be16(4), ...be16(6), 1, 1, 0x11, 0,
    0xFF, 0xDA, ...be16(8), 1, 1, 0, 0, 63, 0,
    0x12, 0x34, 0xFF, 0x00, 0x56, 0xFF, 0xD0, 0x78,
    0xFF, 0xD9
  )
}

export function gif() {
  return bytes('GIF89a', ...le16(3), ...le16(2), 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
    0x21, 0xF9, 4, 0, 0, 0, 0, 0,
    0x2C, 0, 0, 0, 0, ...le16(3), ...le16(2), 0, 2, 2, 0x4C, 0x01, 0,
    0x3B)
}

export function bmp(width = 2, height = 2) {
  const stride = Math.ceil((width * 24) / 32) * 4
  const size = 54 + stride * height
  return concat(bytes('BM', ...le32(size), 0, 0, 0, 0, ...le32(54), ...le32(40), ...le32(width), ...le32(height), ...le16(1), ...le16(24), ...le32(0), ...le32(stride * height), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), new Uint8Array(stride * height))
}

export function ico() {
  const image = png(1, 1)
  return concat(bytes(0, 0, 1, 0, ...le16(1), 1, 1, 0, 0, ...le16(1), ...le16(32), ...le32(image.length), ...le32(22)), image)
}

export function tiff() {
  // Little-endian, one IFD with width, height and a strip of 8 bytes at offset 8 + 2 + 4 * 12 + 4 = 62
  const entries = [[256, 3, 1, 2], [257, 3, 1, 2], [273, 4, 1, 62], [279, 4, 1, 8]]
  const ifd = bytes(...le16(entries.length), ...entries.flatMap(([tag, type, count, value]) => [...le16(tag), ...le16(type), ...le32(count), ...le32(value)]), ...le32(0))
  return concat(bytes('II', 42, 0, ...le32(8)), ifd, new Uint8Array(8).fill(7))
}

/** A 64-bit PE with one section of 0x200 bytes at 0x200. */
export function pe({ sectionSize = 0x200 } = {}) {
  const out = new Uint8Array(0x200 + sectionSize)
  out.set(bytes('MZ'), 0)
  out.set(le32(0x40), 0x3C)
  const opt = 0x40 + 24
  out.set(bytes('PE\0\0', ...le16(0x8664), ...le16(1), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le16(240), ...le16(0x22)), 0x40)
  out.set(le16(0x20B), opt)
  out.set(le32(0x200), opt + 60)
  out.set(le32(16), opt + 108)
  const sections = opt + 240
  out.set(bytes('.text\0\0\0', ...le32(sectionSize), ...le32(0x1000), ...le32(sectionSize), ...le32(0x200)), sections)
  return out
}

/** A 64-bit little-endian ELF executable with one program header covering the whole file. */
export function elf(total = 256) {
  const out = new Uint8Array(total)
  out.set(bytes(0x7F, 'ELF', 2, 1, 1), 0)
  out.set(le16(2), 16)
  out.set(le16(62), 18)
  out.set(le32(1), 20)
  out.set(le64(64), 32)
  out.set(le64(0), 40)
  out.set(le16(64), 52)
  out.set(le16(56), 54)
  out.set(le16(1), 56)
  out.set(le16(64), 58)
  out.set(le16(0), 60)
  out.set(bytes(...le32(1), ...le32(5), ...le64(0), ...le64(0x400000), ...le64(0x400000), ...le64(total), ...le64(total), ...le64(0x1000)), 64)
  return out
}

/** A thin 64-bit Mach-O with one LC_SEGMENT_64 whose file range ends at `total`. */
export function macho(total = 512) {
  const out = new Uint8Array(total)
  out.set(bytes(0xCF, 0xFA, 0xED, 0xFE, ...le32(0x0100000C), ...le32(0), ...le32(2), ...le32(1), ...le32(72), ...le32(0), ...le32(0)), 0)
  out.set(bytes(...le32(0x19), ...le32(72), '__TEXT\0\0\0\0\0\0\0\0\0\0', ...le64(0), ...le64(0x4000), ...le64(0), ...le64(total), ...le32(5), ...le32(5), ...le32(0), ...le32(0)), 32)
  return out
}

export function fatMacho() {
  const slice = macho(256)
  const header = bytes(0xCA, 0xFE, 0xBA, 0xBE, ...be32(1), ...be32(0x0100000C), ...be32(0), ...be32(4096), ...be32(slice.length), ...be32(12))
  const out = new Uint8Array(4096 + slice.length)
  out.set(header, 0)
  out.set(slice, 4096)
  return out
}

export function javaClass() {
  const utf = (s) => [1, ...be16(s.length), ...Array.from(s, c => c.charCodeAt(0))]
  return bytes(0xCA, 0xFE, 0xBA, 0xBE, ...be16(0), ...be16(52),
    ...be16(5), ...utf('A'), 7, ...be16(1), ...utf('java/lang/Object'), 7, ...be16(3),
    ...be16(0x21), ...be16(2), ...be16(4), ...be16(0), ...be16(0), ...be16(0),
    ...be16(1), ...be16(1), ...be32(2), 0, 0)
}

/** A ZIP of stored entries. `descriptor` puts the sizes in data descriptors instead. */
export function zip(entries = [{ name: 'a.txt', data: 'hello' }], { descriptor = false } = {}) {
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? fromLatin1(entry.data) : entry.data
    const name = fromLatin1(entry.name)
    const crc = crc32(data)
    const flags = descriptor ? 8 : 0
    const sizes = descriptor ? [...le32(0), ...le32(0), ...le32(0)] : [...le32(crc), ...le32(data.length), ...le32(data.length)]
    const local = concat(bytes('PK\x03\x04', ...le16(20), ...le16(flags), ...le16(0), 0, 0, 0, 0, ...sizes, ...le16(name.length), ...le16(0)), name, data,
      descriptor ? bytes('PK\x07\x08', ...le32(crc), ...le32(data.length), ...le32(data.length)) : new Uint8Array(0))
    central.push(concat(bytes('PK\x01\x02', ...le16(20), ...le16(20), ...le16(flags), ...le16(0), 0, 0, 0, 0, ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(name.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le32(offset)), name))
    locals.push(local)
    offset += local.length
  }
  const cd = concat(...central)
  const eocd = bytes('PK\x05\x06', 0, 0, 0, 0, ...le16(entries.length), ...le16(entries.length), ...le32(cd.length), ...le32(offset), 0, 0)
  return concat(...locals, cd, eocd)
}

export function tar(members = [{ name: 'a.txt', data: new Uint8Array(10).fill(65) }]) {
  const blocks = []
  for (const member of members) {
    const header = new Uint8Array(512)
    header.set(fromLatin1(member.name), 0)
    header.set(fromLatin1('0000644\0'), 100)
    header.set(fromLatin1('0000000\0'), 108)
    header.set(fromLatin1('0000000\0'), 116)
    header.set(fromLatin1(member.data.length.toString(8).padStart(11, '0') + '\0'), 124)
    header.set(fromLatin1('00000000000\0'), 136)
    header[156] = 0x30
    header.set(fromLatin1('ustar\x0000'), 257)
    header.fill(0x20, 148, 156)
    const sum = header.reduce((a, b) => a + b, 0)
    header.set(fromLatin1(sum.toString(8).padStart(6, '0') + '\0 '), 148)
    const data = new Uint8Array(Math.ceil(member.data.length / 512) * 512)
    data.set(member.data)
    blocks.push(header, data)
  }
  const body = concat(...blocks, new Uint8Array(1024))
  return concat(body, new Uint8Array((10240 - (body.length % 10240)) % 10240))
}

export function sevenZip(next = fromLatin1('\x01\x04\x06\x00')) {
  const tail = bytes(...le64(4), ...le64(next.length), ...le32(crc32(next)))
  return concat(bytes('7z\xBC\xAF\x27\x1C', 0, 4, ...le32(crc32(tail))), tail, new Uint8Array(4), next)
}

export function zstd(payload = fromLatin1('hello zstd')) {
  const block = (payload.length << 3) | 1
  return concat(bytes(0x28, 0xB5, 0x2F, 0xFD, 0x20, payload.length, block & 0xFF, (block >> 8) & 0xFF, (block >> 16) & 0xFF), payload)
}

export function xz() {
  const flags = bytes(0, 1)
  const header = concat(bytes(0xFD, '7zXZ', 0), flags, bytes(...le32(crc32(flags))))
  const index = bytes(0, 0, 0, 0)
  const footerBody = bytes(...le32(0), 0, 1)
  const footer = concat(bytes(...le32(crc32(footerBody))), footerBody, bytes('YZ'))
  return concat(header, index, footer)
}

export function lz4(payload = fromLatin1('lz4 data')) {
  return concat(bytes(0x04, 0x22, 0x4D, 0x18, 0x60, 0x40, 0x82, ...le32((payload.length | 0x80000000) >>> 0)), payload, bytes(...le32(0)))
}

export function cab() {
  const out = new Uint8Array(100)
  out.set(bytes('MSCF', 0, 0, 0, 0, ...le32(100), 0, 0, 0, 0, ...le32(44), 0, 0, 0, 0, 3, 1, ...le16(1), ...le16(1)), 0)
  return out
}

export function ar(deb = false) {
  const member = (name, data) => concat(fromLatin1(name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(data.length).padEnd(10) + '`\n'), data, data.length & 1 ? bytes(10) : new Uint8Array(0))
  return concat(fromLatin1('!<arch>\n'), member(deb ? 'debian-binary' : 'a.o', fromLatin1('2.0\n')), member('b.o', fromLatin1('xyz')))
}

export function cpio() {
  const entry = (name, data) => {
    const field = (v) => v.toString(16).toUpperCase().padStart(8, '0')
    const header = '070701' + [1, 0o100644, 0, 0, 1, 0, data.length, 0, 0, 0, 0, name.length + 1, 0].map(field).join('')
    const head = fromLatin1(header + name + '\0')
    const pad = (n) => new Uint8Array((4 - (n % 4)) % 4)
    return concat(head, pad(head.length), data, pad(data.length))
  }
  return concat(entry('a.txt', fromLatin1('hello')), entry('TRAILER!!!', new Uint8Array(0)))
}

export function squashfs(size = 8192) {
  const out = new Uint8Array(size)
  out.set(bytes('hsqs', ...le32(3), ...le32(0), ...le32(131072), ...le32(0), ...le16(1), ...le16(17), ...le16(0), ...le16(1), ...le16(4), ...le16(0), ...le64(0), ...le64(size)), 0)
  return out
}

export function ext2(blocks = 64) {
  const out = new Uint8Array(blocks * 1024)
  const s = 1024
  out.set(le32(16), s)
  out.set(le32(blocks), s + 4)
  out.set(le32(1), s + 20)
  out.set(le32(0), s + 24)
  out.set(le32(8192), s + 32)
  out.set(le32(16), s + 40)
  out.set(le16(0xEF53), s + 56)
  out.set(le16(1), s + 58)
  out.set(le16(1), s + 60)
  out.set(le32(1), s + 76)
  return out
}

export function fat16(sectors = 128) {
  const out = new Uint8Array(sectors * 512)
  out.set(bytes(0xEB, 0x3C, 0x90, 'MSDOS5.0', ...le16(512), 4, ...le16(1), 2, ...le16(512), ...le16(sectors), 0xF8, ...le16(1)), 0)
  out.set(fromLatin1('FAT16   '), 54)
  out.set([0x55, 0xAA], 510)
  return out
}

export function mbr(partitionSectors = 16) {
  const out = new Uint8Array((1 + partitionSectors) * 512)
  out.set(bytes(0x80, 0, 0, 0, 0x83, 0, 0, 0, ...le32(1), ...le32(partitionSectors)), 446)
  out.set([0x55, 0xAA], 510)
  return out
}

export function iso(blocks = 20) {
  const out = new Uint8Array(blocks * 2048)
  const d = 0x8000
  out.set(bytes(1, 'CD001', 1), d)
  out.set(fromLatin1('TESTDISC'.padEnd(32)), d + 40)
  out.set([...le32(blocks), ...be32(blocks)], d + 80)
  out.set([...le16(2048), ...be16(2048)], d + 128)
  return out
}

export function uimage(payload = fromLatin1('kernel payload')) {
  const header = new Uint8Array(64)
  header.set(be32(0x27051956), 0)
  header.set(be32(payload.length), 12)
  header.set(be32(crc32(payload)), 24)
  header.set([5, 2, 2, 0], 28)
  header.set(fromLatin1('Linux test'), 32)
  header.set(be32(crc32(header)), 4)
  return concat(header, payload)
}

export function dtb(total = 128) {
  const out = new Uint8Array(total)
  out.set(bytes(0xD0, 0x0D, 0xFE, 0xED, ...be32(total), ...be32(56), ...be32(100), ...be32(40), ...be32(17), ...be32(16)), 0)
  return out
}

export function androidBoot() {
  const page = 2048
  const out = new Uint8Array(page * 3)
  out.set(bytes('ANDROID!', ...le32(1000), ...le32(0), ...le32(500), ...le32(0), ...le32(0), ...le32(0), ...le32(0), ...le32(page), ...le32(0)), 0)
  return out
}

export function dex() {
  const out = new Uint8Array(0x70 + 16)
  out.set(fromLatin1('dex\n035\0'), 0)
  out.set(le32(out.length), 32)
  out.set(le32(0x70), 36)
  out.set(le32(0x12345678), 40)
  out.set(le32(adler32(out, 12)), 8)
  return out
}

export function ole() {
  const sector = 512
  const out = new Uint8Array(sector * 4)
  out.set(bytes(0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1), 0)
  out.set([...le16(0x3E), ...le16(3), ...le16(0xFFFE), ...le16(9), ...le16(6)], 24)
  out.set(le32(1), 44)
  out.set(le32(0), 76)
  const fat = new Uint8Array(sector).fill(0xFF)
  fat.set([...le32(0xFFFFFFFD), ...le32(0xFFFFFFFE), ...le32(0xFFFFFFFE)], 0)
  out.set(fat, sector)
  for (let i = 1; i < 109; i++) out.set(le32(0xFFFFFFFF), 76 + i * 4)
  return out
}

export function pem() {
  return fromLatin1('-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUTEST\nAAAA\n-----END CERTIFICATE-----\n')
}

/** A DER SEQUENCE shaped like an X.509 certificate, with a two-byte length. */
export function der() {
  const tlv = (tag, content) => {
    const n = content.length
    const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xFF]
    return concat(bytes(tag, ...len), content)
  }
  const oid = tlv(0x06, bytes(0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B))
  const name = tlv(0x30, tlv(0x31, tlv(0x30, concat(tlv(0x06, bytes(0x55, 0x04, 0x03)), tlv(0x0C, fromLatin1('test'.repeat(20)))))))
  const tbs = tlv(0x30, concat(tlv(0xA0, tlv(0x02, bytes(2))), tlv(0x02, bytes(1, 2, 3)), tlv(0x30, oid), name, name))
  const cert = tlv(0x30, concat(tbs, tlv(0x30, oid), tlv(0x03, concat(bytes(0), new Uint8Array(64).fill(9)))))
  return cert
}

export function pdf() {
  return fromLatin1('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')
}

export function wasm() {
  return bytes(0, 'asm', 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 10, 4, 1, 2, 0, 0x0B)
}

export function sqlite(pages = 2, pageSize = 1024) {
  const out = new Uint8Array(pages * pageSize)
  out.set(fromLatin1('SQLite format 3\0'), 0)
  out.set([...be16(pageSize), 1, 1, 0, 64, 32, 32, ...be32(3), ...be32(pages)], 16)
  out.set(be32(3), 92)
  return out
}

export function flac() {
  const info = new Uint8Array(34)
  info.set([0x0A, 0xC4, 0x42, 0xF0], 10)
  return concat(bytes('fLaC', 0x80, 0, 0, 34), info, bytes(0xFF, 0xF8, 0x69, 0x08))
}

export function ogg() {
  const page = (flags, seq, packet) => {
    const header = concat(bytes('OggS', 0, flags, ...le64(0), ...le32(1234), ...le32(seq), ...le32(0), 1, packet.length))
    const all = concat(header, packet)
    all.set(le32(crc32ogg(all, 0, all.length)), 22)
    return all
  }
  return concat(page(2, 0, fromLatin1('\x01vorbis-header-data')), page(4, 1, fromLatin1('audio')))
}

export function wav() {
  const fmt = bytes('fmt ', ...le32(16), ...le16(1), ...le16(1), ...le32(8000), ...le32(8000), ...le16(1), ...le16(8))
  const data = concat(bytes('data', ...le32(4)), bytes(1, 2, 3, 4))
  const body = concat(fromLatin1('WAVE'), fmt, data)
  return concat(bytes('RIFF', ...le32(body.length)), body)
}

export function mp4() {
  const box = (type, content) => concat(bytes(...be32(8 + content.length), type), content)
  return concat(box('ftyp', bytes('isom', 0, 0, 2, 0, 'isom', 'mp41')), box('moov', new Uint8Array(16)), box('mdat', new Uint8Array(32)))
}

/** ID3v2.3 tag of `tagSize` bytes, then `frames` MPEG-1 Layer III 128 kbps 44.1 kHz frames (417 bytes each). */
export function mp3(frames = 4, tagSize = 20) {
  const tag = concat(bytes('ID3', 3, 0, 0, 0, 0, 0, tagSize), new Uint8Array(tagSize))
  const frame = new Uint8Array(417)
  frame.set([0xFF, 0xFB, 0x90, 0x00], 0)
  return concat(tag, ...Array.from({ length: frames }, () => frame))
}

export function nes() {
  return concat(bytes('NES\x1A', 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), new Uint8Array(16384 + 8192))
}

export function gameboy() {
  const out = new Uint8Array(32768)
  out.set([0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00, 0x0D, 0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E, 0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD, 0xD9, 0x99, 0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC, 0xDD, 0xDC, 0x99, 0x9F, 0xBB, 0xB9, 0x33, 0x3E], 0x104)
  out.set(fromLatin1('TESTROM'), 0x134)
  let x = 0
  for (let i = 0x134; i <= 0x14C; i++) x = (x - out[i] - 1) & 0xFF
  out[0x14D] = x
  return out
}

export function font() {
  const tables = [['cmap', 12], ['glyf', 20], ['head', 54]]
  let offset = 12 + tables.length * 16
  const records = []
  for (const [tag, length] of tables) {
    records.push(...Array.from(tag, c => c.charCodeAt(0)), 0, 0, 0, 0, ...be32(offset), ...be32(length))
    offset += (length + 3) & ~3
  }
  return concat(bytes(0, 1, 0, 0, ...be16(3), ...be16(32), ...be16(1), ...be16(16)), Uint8Array.from(records), new Uint8Array(offset - 12 - tables.length * 16))
}

export function pcap(packets = 3) {
  const record = concat(bytes(...le32(1), ...le32(2), ...le32(10), ...le32(10)), new Uint8Array(10))
  return concat(bytes(0xD4, 0xC3, 0xB2, 0xA1, ...le16(2), ...le16(4), ...le32(0), ...le32(0), ...le32(65535), ...le32(1)), ...Array.from({ length: packets }, () => record))
}

export function pcapng() {
  const shb = bytes(0x0A, 0x0D, 0x0D, 0x0A, ...le32(28), ...le32(0x1A2B3C4D), ...le16(1), ...le16(0), ...le64(0xFFFFFFFF), ...le32(28))
  const idb = bytes(...le32(1), ...le32(20), ...le16(1), ...le16(0), ...le32(65535), ...le32(20))
  return concat(shb, idb)
}

export { le16, le32, be16, be32, bytes }
