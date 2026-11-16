import { ByteReader, field, fitted, formatNumber, hex32, plural, printable, utf16 } from './reader.js'
import { crc32 } from '../lib/crc32.js'
import { formatBytes, item } from './shared.js'

const SIGNATURE = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]
const MAX_ITEMS = 100000
const CODERS = {
  '00': 'Copy', '03': 'Delta', '03030103': 'BCJ x86', '0303011B': 'BCJ2', '03030205': 'PPC', '03030401': 'IA64', '03030501': 'ARM', '03030701': 'ARM Thumb',
  '03030805': 'SPARC', '0A': 'ARM64', '030101': 'LZMA', '21': 'LZMA2', '030401': 'PPMd', '040108': 'Deflate', '040109': 'Deflate64', '040202': 'BZip2',
  '06F10701': 'AES-256 + SHA-256', '04F71101': 'Zstandard', '04F71104': 'LZ4'
}

class SevenZipError extends Error {}

// Reads the structures of a 7z header (all numbers use 7z's variable-length encoding)
class HeaderReader {
  constructor(bytes, start, end) {
    this.bytes = bytes
    this.pos = start
    this.end = end
  }

  byte() {
    if (this.pos >= this.end) throw new SevenZipError('header is truncated')
    return this.bytes[this.pos++]
  }

  number() {
    const first = this.byte()
    let mask = 0x80
    let value = 0
    for (let i = 0; i < 8; i++) {
      if ((first & mask) === 0) {
        const high = first & (mask - 1)
        return value + high * 2 ** (8 * i)
      }
      value += this.byte() * 2 ** (8 * i)
      mask >>= 1
    }
    return value
  }

  count() {
    const value = this.number()
    if (value > MAX_ITEMS) throw new SevenZipError(`too many entries (${value})`)
    return value
  }

  skip(length) {
    if (this.pos + length > this.end) throw new SevenZipError('header is truncated')
    this.pos += length
  }

  bits(count) {
    const all = this.byte()
    if (all) return new Array(count).fill(true)
    const out = []
    let byte = 0
    for (let i = 0; i < count; i++) {
      if (i % 8 === 0) byte = this.byte()
      out.push((byte & (0x80 >> (i % 8))) !== 0)
    }
    return out
  }

  rawBits(count) {
    const out = []
    let byte = 0
    for (let i = 0; i < count; i++) {
      if (i % 8 === 0) byte = this.byte()
      out.push((byte & (0x80 >> (i % 8))) !== 0)
    }
    return out
  }

  digests(count) {
    const defined = this.bits(count)
    for (const isDefined of defined) if (isDefined) this.skip(4)
  }

  streamsInfo(info) {
    for (;;) {
      const id = this.byte()
      if (id === 0x00) return
      if (id === 0x06) {
        info.packPos = this.number()
        const packs = this.count()
        info.packSizes = []
        for (;;) {
          const sub = this.byte()
          if (sub === 0) break
          if (sub === 0x09) for (let i = 0; i < packs; i++) info.packSizes.push(this.number())
          else if (sub === 0x0A) this.digests(packs)
          else throw new SevenZipError(`unexpected property ${sub} in pack info`)
        }
      } else if (id === 0x07) {
        if (this.byte() !== 0x0B) throw new SevenZipError('expected folder list')
        const folders = this.count()
        if (this.byte() !== 0) throw new SevenZipError('external folders are not supported')
        info.folders = []
        for (let f = 0; f < folders; f++) {
          const folder = { coders: [], outputs: 0, unpackSizes: [] }
          const coders = this.count()
          let inputs = 0
          for (let c = 0; c < coders; c++) {
            const flags = this.byte()
            const idSize = flags & 0x0F
            let idHex = ''
            for (let i = 0; i < idSize; i++) idHex += this.byte().toString(16).toUpperCase().padStart(2, '0')
            let ins = 1
            let outs = 1
            if (flags & 0x10) {
              ins = this.count()
              outs = this.count()
            }
            if (flags & 0x20) this.skip(this.count())
            inputs += ins
            folder.outputs += outs
            folder.coders.push(CODERS[idHex] || `method ${idHex}`)
          }
          const bindPairs = folder.outputs - 1
          for (let i = 0; i < bindPairs; i++) {
            this.number()
            this.number()
          }
          const packed = inputs - bindPairs
          if (packed > 1) for (let i = 0; i < packed; i++) this.number()
          info.folders.push(folder)
        }
        for (;;) {
          const sub = this.byte()
          if (sub === 0) break
          if (sub === 0x0C) {
            for (const folder of info.folders) for (let i = 0; i < folder.outputs; i++) folder.unpackSizes.push(this.number())
          } else if (sub === 0x0A) {
            this.digests(info.folders.length)
          } else {
            throw new SevenZipError(`unexpected property ${sub} in unpack info`)
          }
        }
      } else if (id === 0x08) {
        const folders = info.folders || []
        const perFolder = folders.map(() => 1)
        info.sizes = []
        let sub = this.byte()
        if (sub === 0x0D) {
          for (let i = 0; i < folders.length; i++) perFolder[i] = this.count()
          sub = this.byte()
        }
        if (sub === 0x09) {
          folders.forEach((folder, i) => {
            let sum = 0
            for (let j = 1; j < perFolder[i]; j++) {
              const size = this.number()
              info.sizes.push(size)
              sum += size
            }
            if (perFolder[i] > 0) info.sizes.push(Math.max(0, folderSize(folder) - sum))
          })
          sub = this.byte()
        } else {
          folders.forEach((folder, i) => { if (perFolder[i] === 1) info.sizes.push(folderSize(folder)) })
        }
        while (sub !== 0) {
          if (sub === 0x0A) {
            const count = perFolder.reduce((a, b) => a + b, 0)
            this.digests(count)
          } else {
            this.skip(this.number())
          }
          sub = this.byte()
        }
      } else {
        throw new SevenZipError(`unexpected property ${id} in streams info`)
      }
    }
  }

  filesInfo(files) {
    const count = this.count()
    files.count = count
    files.names = []
    files.emptyStream = []
    files.emptyFile = []
    files.attributes = []
    for (;;) {
      const type = this.byte()
      if (type === 0) return
      const size = this.number()
      const end = this.pos + size
      if (end > this.end) throw new SevenZipError('file property runs past the header')
      if (type === 0x11 && this.byte() === 0) {
        let start = this.pos
        for (let p = this.pos; p + 1 < end && files.names.length < count; p += 2) {
          if (this.bytes[p] === 0 && this.bytes[p + 1] === 0) {
            files.names.push(utf16(this.bytes, start, p - start, true))
            start = p + 2
          }
        }
      } else if (type === 0x0E) {
        files.emptyStream = this.rawBits(count)
      } else if (type === 0x0F) {
        const empties = files.emptyStream.filter(Boolean).length
        files.emptyFile = this.rawBits(empties)
      } else if (type === 0x15) {
        const defined = this.bits(count)
        if (this.byte() === 0) {
          for (let i = 0; i < count; i++) {
            if (!defined[i]) {
              files.attributes.push(null)
              continue
            }
            this.skip(4)
            const p = this.pos - 4
            files.attributes.push((this.bytes[p] | (this.bytes[p + 1] << 8) | (this.bytes[p + 2] << 16) | (this.bytes[p + 3] << 24)) >>> 0)
          }
        }
      }
      this.pos = end
    }
  }
}

function folderSize(folder) {
  return folder.unpackSizes.length ? folder.unpackSizes[folder.unpackSizes.length - 1] : 0
}

function parse7z(bytes) {
  const r = new ByteReader(bytes, true)
  const warnings = []
  const regions = []
  const summary = []
  const startCrc = r.u32(8)
  const nextOffset = r.u64(12)
  const nextSize = r.u64(20)
  const nextCrc = r.u32(28)
  const startCrcOk = bytes.length >= 32 && crc32(bytes, 12, 32) === startCrc
  const fields = [field('Signature header', 0, Math.min(32, bytes.length), undefined, 'Fixed 32-byte start of every 7z archive', 'header', [
    field('Signature', 0, 6, "7z\\xBC\\xAF'\\x1C", '7z signature', 'magic'),
    field('Version', 6, 2, `${r.u8(6)}.${r.u8(7)}`, 'Format version', 'magic'),
    field('Start header CRC', 8, 4, `${hex32(startCrc)}${bytes.length >= 32 ? (startCrcOk ? ' (valid)' : ' (mismatch)') : ''}`, 'CRC-32 of the next 20 bytes', 'checksum'),
    field('Next header offset', 12, 8, formatNumber(nextOffset), 'From the end of this 32-byte header', 'offset'),
    field('Next header size', 20, 8, formatNumber(nextSize), 'Bytes', 'size'),
    field('Next header CRC', 28, 4, hex32(nextCrc), 'CRC-32 of the next header', 'checksum')
  ])]
  if (bytes.length < 32) {
    warnings.push('File is truncated inside the signature header')
    return { summary, fields, warnings }
  }
  regions.push({ name: 'Signature header', offset: 0, length: 32, kind: 'header' })
  if (!startCrcOk) warnings.push('Start header CRC does not match')
  summary.push(item('Format Version', `${r.u8(6)}.${r.u8(7)}`))

  const headerStart = 32 + nextOffset
  const headerEnd = headerStart + nextSize
  if (nextSize === 0) {
    summary.push(item('Contents', 'Empty archive'))
    return { summary, fields, regions, warnings }
  }
  if (headerEnd > bytes.length) {
    warnings.push(`The header at offset ${formatNumber(headerStart)} lies past the end of the file (truncated or a multi-volume part)`)
    if (headerStart > 32) {
      fields.push(field('Packed streams', 32, bytes.length - 32, formatBytes(bytes.length - 32), 'Compressed file data', 'data'))
      regions.push({ name: 'Packed streams', offset: 32, length: bytes.length - 32, kind: 'data' })
    }
    summary.push(item('Packed Data', formatBytes(nextOffset)))
    return { summary, fields, regions, warnings }
  }
  const headerCrcOk = crc32(bytes, headerStart, headerEnd) === nextCrc
  if (!headerCrcOk) warnings.push('Next header CRC does not match')
  if (headerStart > 32) {
    fields.push(field('Packed streams', 32, headerStart - 32, formatBytes(headerStart - 32), 'Compressed file data (and a compressed header, if any)', 'data'))
    regions.push({ name: 'Packed streams', offset: 32, length: headerStart - 32, kind: 'data' })
  }
  const kind = bytes[headerStart]
  const reader = new HeaderReader(bytes, headerStart + 1, headerEnd)
  const info = {}
  const files = {}
  let headerValue
  try {
    if (kind === 0x17) {
      reader.streamsInfo(info)
      const coders = (info.folders && info.folders[0] && info.folders[0].coders) || []
      headerValue = `encoded with ${coders.join(' + ') || 'unknown method'}`
      summary.push(item('Header', `Compressed (${coders.join(' + ') || 'unknown method'})`, ['The file list is itself compressed and is not listed here']))
      if (coders.some(name => name.startsWith('AES'))) summary.push(item('Encrypted Header', 'Yes (file names are encrypted)'))
    } else if (kind === 0x01) {
      headerValue = 'plain'
      for (;;) {
        const id = reader.byte()
        if (id === 0) break
        if (id === 0x02) {
          for (;;) {
            const type = reader.byte()
            if (type === 0) break
            reader.skip(reader.number())
          }
        } else if (id === 0x03) {
          reader.streamsInfo({})
        } else if (id === 0x04) {
          reader.streamsInfo(info)
        } else if (id === 0x05) {
          reader.filesInfo(files)
        } else {
          throw new SevenZipError(`unexpected property ${id} in header`)
        }
      }
      summary.push(item('Header', 'Plain (not compressed)'))
    } else {
      headerValue = `unknown type 0x${kind.toString(16)}`
      warnings.push(`Unknown header type 0x${kind.toString(16)}`)
    }
  } catch (err) {
    if (!(err instanceof SevenZipError)) throw err
    warnings.push(`Could not read the header: ${err.message}`)
  }
  fields.push(field('Header', headerStart, nextSize, headerValue, kind === 0x17 ? 'Describes where the compressed header is' : 'Streams and file information', 'header', [
    field('Header type', headerStart, 1, kind === 0x17 ? '0x17 (encoded header)' : kind === 0x01 ? '0x01 (header)' : `0x${kind.toString(16)}`, 'Plain or compressed header', 'magic')
  ]))
  regions.push({ name: 'Header', offset: headerStart, length: nextSize, kind: 'metadata' })
  if (headerEnd < bytes.length) warnings.push(`${plural(bytes.length - headerEnd, 'byte')} of trailing data after the header`)

  const coders = new Set()
  for (const folder of info.folders || []) coders.add(folder.coders.join(' + '))
  if (coders.size && kind === 0x01) summary.push(item('Compression', [...coders].join(', ')))
  if (info.packSizes && kind === 0x01) summary.push(item('Packed Size', formatBytes(info.packSizes.reduce((a, b) => a + b, 0))))
  if (info.folders && kind === 0x01) summary.push(item('Solid Blocks', formatNumber(info.folders.length)))
  if (files.count !== undefined) {
    const directories = files.attributes.filter(attr => attr !== null && attr !== undefined && attr & 0x10).length
    summary.push(item('Entries', formatNumber(files.count), files.names.slice(0, 50).map(name => printable(name, 120)).concat(files.count > 50 ? [`… ${formatNumber(files.count - 50)} more`] : [])))
    if (directories) summary.push(item('Directories', formatNumber(directories)))
    if (info.sizes) summary.push(item('Uncompressed Size', formatBytes(info.sizes.reduce((a, b) => a + b, 0))))
  }
  return { summary, fields, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: '7z',
  name: '7z Archive',
  category: 'compressed',
  detect: bytes => bytes.length >= 8 && SIGNATURE.every((byte, i) => bytes[i] === byte),
  parse: fitted(parse7z)
}
