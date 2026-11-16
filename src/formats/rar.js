import { ByteReader, capFields, crc32, field, fitted, formatNumber, latin1, plural, printable, readULEB, unixDate, utf8 } from './reader.js'
import { formatBytes, item } from './shared.js'

const RAR4 = [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00]
const RAR5 = [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00]
const MAX_BLOCKS = 100000
const MAX_BLOCK_FIELDS = 100

const RAR5_TYPES = { 1: 'Main archive header', 2: 'File header', 3: 'Service header', 4: 'Archive encryption header', 5: 'End of archive' }
const RAR4_TYPES = { 0x72: 'Marker block', 0x73: 'Archive header', 0x74: 'File header', 0x75: 'Old comment', 0x76: 'Old authenticity', 0x77: 'Old subblock', 0x78: 'Old recovery record', 0x79: 'Old authenticity', 0x7A: 'Service block', 0x7B: 'End of archive' }
const RAR4_METHODS = { 0x30: 'stored', 0x31: 'fastest', 0x32: 'fast', 0x33: 'normal', 0x34: 'good', 0x35: 'best' }
const RAR5_METHODS = ['stored', 'fastest', 'fast', 'normal', 'good', 'best']
const HOSTS = ['Windows', 'Unix']
const RAR4_HOSTS = ['MS-DOS', 'OS/2', 'Windows', 'Unix', 'Mac OS', 'BeOS']

const startsWith = (bytes, signature) => signature.every((byte, i) => bytes[i] === byte)

// RAR5 variable-length integers are little-endian base-128, like LEB128
function vint(bytes, pos, end) {
  return readULEB(bytes, pos, end, 10)
}

function parseRar5(r, warnings, out) {
  const { bytes } = r
  let pos = RAR5.length
  let blocks = 0
  while (pos + 6 <= bytes.length && blocks < MAX_BLOCKS) {
    blocks++
    const crc = r.u32(pos)
    const sizeField = vint(bytes, pos + 4, bytes.length)
    if (!sizeField) break
    const headerSize = sizeField.value
    const headerStart = sizeField.next
    const headerEnd = headerStart + headerSize
    if (headerEnd > bytes.length || headerSize === 0 || headerSize > 2 * 1024 * 1024) {
      warnings.add(`Block header at offset ${pos} is truncated or invalid`)
      break
    }
    const crcOk = crc32(bytes, pos + 4, headerEnd) === crc
    if (!crcOk) warnings.add(`Header CRC mismatch at offset ${pos}`)
    let p = headerStart
    const read = () => {
      const v = vint(bytes, p, headerEnd)
      if (!v) return 0
      p = v.next
      return v.value
    }
    const type = read()
    const flags = read()
    const extraSize = flags & 1 ? read() : 0
    const dataSize = flags & 2 ? read() : 0
    const blockEnd = headerEnd + dataSize
    const typeName = RAR5_TYPES[type] || `Unknown type ${type}`
    const children = [
      field('Header CRC32', pos, 4, crcOk ? 'valid' : 'mismatch', 'CRC-32 of the rest of the header', 'checksum'),
      field('Header size', pos + 4, headerStart - pos - 4, formatNumber(headerSize), 'Variable-length integer', 'size'),
      field('Header fields', headerStart, headerSize, typeName, 'Type, flags, sizes and type-specific fields', 'header')
    ]
    let value = typeName
    if (type === 1) {
      const archiveFlags = read()
      out.solid = (archiveFlags & 4) !== 0
      out.volume = (archiveFlags & 1) !== 0
      out.recovery = (archiveFlags & 8) !== 0
      out.locked = (archiveFlags & 16) !== 0
    } else if (type === 2 || type === 3) {
      const fileFlags = read()
      const unpacked = read()
      read()
      let mtime = null
      if (fileFlags & 2) {
        mtime = r.u32(p)
        p += 4
      }
      if (fileFlags & 4) p += 4
      const compression = read()
      const host = read()
      const nameLength = read()
      const name = printable(utf8(bytes, p, Math.min(nameLength, 4096)), 4096)
      p += nameLength
      // Extra records: type 1 marks an encrypted file
      let encrypted = false
      let e = headerEnd - extraSize
      while (e < headerEnd) {
        const size = vint(bytes, e, headerEnd)
        if (!size || size.value === 0) break
        const recordType = vint(bytes, size.next, headerEnd)
        if (recordType && recordType.value === 1) encrypted = true
        e = size.next + size.value
      }
      const method = RAR5_METHODS[(compression >> 7) & 7] || 'unknown'
      value = `${name}${type === 3 ? ' (service)' : ''}`
      if (type === 2 && out.entries.length < MAX_BLOCKS) {
        const isDirectory = (fileFlags & 1) !== 0
        out.entries.push({ path: name, isDirectory, size: fileFlags & 8 ? null : unpacked, compressedSize: dataSize, method: isDirectory ? 'stored' : method, encrypted })
        if (mtime && mtime > out.latest) out.latest = mtime
        out.hosts.add(HOSTS[host] || `host ${host}`)
      } else if (type === 3) {
        out.services.push(name)
      }
      if (encrypted) out.encryptedFiles++
    } else if (type === 4) {
      out.headersEncrypted = true
    } else if (type === 5) {
      out.end = blockEnd
    }
    if (blockEnd > headerEnd && blockEnd <= bytes.length) children.push(field('Data', headerEnd, dataSize, formatBytes(dataSize), 'Packed file data', 'data'))
    out.blockFields.push(field(typeName, pos, Math.min(blockEnd, bytes.length) - pos, value, `RAR 5 block (type ${type})`, 'header', children))
    if (blockEnd > bytes.length) {
      warnings.add(`Data of a block at offset ${pos} runs past the end of the file`)
      break
    }
    pos = blockEnd
    if (type === 4 || type === 5) break
  }
  return pos
}

function parseRar4(r, warnings, out) {
  const { bytes } = r
  let pos = 0
  let blocks = 0
  while (pos + 7 <= bytes.length && blocks < MAX_BLOCKS) {
    blocks++
    const crc = r.u16(pos)
    const type = r.u8(pos + 2)
    const flags = r.u16(pos + 3)
    const headerSize = r.u16(pos + 5)
    if (headerSize < 7 || pos + headerSize > bytes.length) {
      warnings.add(`Block header at offset ${pos} is truncated or invalid`)
      break
    }
    const addSize = flags & 0x8000 && headerSize >= 11 ? r.u32(pos + 7) : 0
    let dataSize = addSize
    const typeName = RAR4_TYPES[type] || `Unknown type 0x${type.toString(16)}`
    let value = typeName
    const crcOk = type === 0x72 || (crc32(bytes, pos + 2, pos + headerSize) & 0xFFFF) === crc
    if (!crcOk) warnings.add(`Header CRC mismatch at offset ${pos}`)
    if (type === 0x73) {
      out.volume = (flags & 0x01) !== 0
      out.solid = (flags & 0x08) !== 0
      out.locked = (flags & 0x04) !== 0
      out.recovery = (flags & 0x40) !== 0
      if (flags & 0x80) out.headersEncrypted = true
    } else if (type === 0x74 && headerSize >= 32) {
      const packed = r.u32(pos + 7)
      let unpacked = r.u32(pos + 11)
      const host = r.u8(pos + 15)
      const time = r.u32(pos + 20)
      const methodByte = r.u8(pos + 25)
      const nameLength = r.u16(pos + 26)
      let nameStart = pos + 32
      dataSize = packed
      if (flags & 0x100) {
        dataSize += r.u32(pos + 32) * 0x100000000
        unpacked += r.u32(pos + 36) * 0x100000000
        nameStart += 8
      }
      const nameBytes = bytes.subarray(nameStart, Math.min(nameStart + nameLength, pos + headerSize))
      const name = printable(decodeRar4Name(nameBytes, (flags & 0x200) !== 0).replace(/\\/g, '/'), 4096)
      const isDirectory = (flags & 0xE0) === 0xE0
      out.entries.push({ path: name, isDirectory, size: unpacked, compressedSize: dataSize, method: isDirectory ? 'stored' : RAR4_METHODS[methodByte] || `method 0x${methodByte.toString(16)}`, encrypted: (flags & 0x04) !== 0 })
      if (flags & 0x04) out.encryptedFiles++
      out.hosts.add(RAR4_HOSTS[host] || `host ${host}`)
      out.latestDos = Math.max(out.latestDos, time)
      value = name
    } else if (type === 0x7B) {
      out.end = pos + headerSize
    }
    const blockEnd = pos + headerSize + dataSize
    const children = [
      field('Header CRC', pos, 2, type === 0x72 ? 'fixed' : crcOk ? 'valid' : 'mismatch', 'Low 16 bits of the CRC-32 of the header', 'checksum'),
      field('Header type', pos + 2, 1, `0x${type.toString(16)} (${typeName})`, 'Block type', 'magic'),
      field('Flags', pos + 3, 2, `0x${flags.toString(16).padStart(4, '0')}`, 'Block flags', 'flags'),
      field('Header size', pos + 5, 2, headerSize, 'Bytes in this header', 'size')
    ]
    if (headerSize > 7) children.push(field('Header fields', pos + 7, headerSize - 7, undefined, 'Type-specific fields', 'header'))
    if (dataSize > 0 && pos + headerSize < bytes.length) children.push(field('Data', pos + headerSize, Math.min(dataSize, bytes.length - pos - headerSize), formatBytes(dataSize), 'Packed data', 'data'))
    out.blockFields.push(field(typeName, pos, Math.min(blockEnd, bytes.length) - pos, value, 'RAR 4 block', 'header', children))
    if (blockEnd > bytes.length) {
      warnings.add(`Data of a block at offset ${pos} runs past the end of the file`)
      break
    }
    pos = blockEnd
    if (type === 0x7B || out.headersEncrypted) break
  }
  return pos
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

// RAR 4 names are UTF-8 or a legacy code page; with the Unicode flag an
// 8-bit name is followed by a NUL and a compact UTF-16 encoding of it
export function decodeRar4Name(raw, unicode) {
  const zero = raw.indexOf(0)
  const std = zero >= 0 ? raw.subarray(0, zero) : raw
  if (unicode && zero >= 0 && zero + 1 < raw.length) {
    const enc = raw.subarray(zero + 1)
    const out = []
    let pos = 0
    const get = () => (pos < enc.length ? enc[pos++] : 0)
    const high = get()
    let flags = 0
    let flagBits = 0
    while (pos < enc.length && out.length < 4096) {
      if (flagBits === 0) {
        flags = get()
        flagBits = 8
      }
      flagBits -= 2
      const type = (flags >> flagBits) & 3
      if (type === 0) out.push(get())
      else if (type === 1) out.push(get() | (high << 8))
      else if (type === 2) out.push(get() | (get() << 8))
      else {
        const n = get()
        const correction = n & 0x80 ? get() : 0
        const count = (n & 0x7F) + 2
        for (let i = 0; i < count && out.length < std.length + count; i++) {
          const base = std[out.length] || 0
          out.push(n & 0x80 ? ((base + correction) & 0xFF) | (high << 8) : base)
        }
      }
    }
    return String.fromCharCode(...out)
  }
  try {
    return strictUtf8.decode(std)
  } catch {
    return latin1(std, 0, std.length)
  }
}

function dosDate(value) {
  if (!value) return null
  const year = 1980 + (value >>> 25)
  const month = (value >>> 21) & 15
  const day = (value >>> 16) & 31
  const hour = (value >>> 11) & 31
  const minute = (value >>> 5) & 63
  const second = (value & 31) * 2
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
}

function parseRAR(bytes) {
  const r = new ByteReader(bytes, true)
  const warnings = new Set()
  const summary = []
  const regions = []
  const v5 = startsWith(bytes, RAR5)
  const out = { entries: [], blockFields: [], hosts: new Set(), services: [], latest: 0, latestDos: 0, encryptedFiles: 0, end: -1 }
  const fields = []
  let end
  if (v5) {
    fields.push(field('Signature', 0, Math.min(8, bytes.length), 'Rar!\\x1A\\x07\\x01\\x00', 'RAR 5 signature', 'magic'))
    end = parseRar5(r, warnings, out)
  } else {
    end = parseRar4(r, warnings, out)
  }
  fields.push(...capFields(out.blockFields, MAX_BLOCK_FIELDS, 'more blocks'))
  if (end > 0) regions.push({ name: 'Blocks', offset: 0, length: Math.min(end, bytes.length), kind: 'data' })
  if (out.end < 0 && !out.headersEncrypted) warnings.add('No end-of-archive block (truncated, or more volumes follow)')
  if (out.end > 0 && out.end < bytes.length) warnings.add(`${plural(bytes.length - out.end, 'byte')} of data after the end-of-archive block`)

  const files = out.entries.filter(entry => !entry.isDirectory)
  summary.push(item('RAR Version', v5 ? '5.0' : '1.5–4.x'))
  if (out.headersEncrypted) summary.push(item('Encrypted Headers', 'Yes (the file list needs the password)'))
  if (out.entries.length || !out.headersEncrypted) {
    summary.push(item('Total Files', formatNumber(files.length)))
    summary.push(item('Directories', formatNumber(out.entries.length - files.length)))
    const known = files.filter(file => file.size !== null)
    summary.push(item('Uncompressed Size', formatBytes(known.reduce((sum, file) => sum + file.size, 0))))
    summary.push(item('Compressed Size', formatBytes(files.reduce((sum, file) => sum + file.compressedSize, 0))))
  }
  const methods = [...new Set(files.map(file => file.method))]
  if (methods.length) summary.push(item('Compression', methods.join(', ')))
  if (out.encryptedFiles) summary.push(item('Encrypted Files', formatNumber(out.encryptedFiles)))
  if (out.solid) summary.push(item('Solid', 'Yes'))
  if (out.volume) summary.push(item('Multi-volume', 'Yes (part of a set)'))
  if (out.recovery) summary.push(item('Recovery Record', 'Yes'))
  if (out.locked) summary.push(item('Locked', 'Yes'))
  if (out.hosts.size) summary.push(item('Created On', [...out.hosts].join(', ')))
  if (out.latest) summary.push(item('Latest Modification', unixDate(out.latest)))
  if (out.latestDos) summary.push(item('Latest Modification', dosDate(out.latestDos)))
  if (out.services.length) summary.push(item('Service Headers', out.services.slice(0, 10).join(', ')))
  return { formatName: v5 ? 'RAR 5 Archive' : 'RAR Archive', summary, fields, regions, entries: out.entries, warnings: [...warnings] }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'rar',
  name: 'RAR Archive',
  category: 'archive',
  detect: bytes => startsWith(bytes, RAR5) || startsWith(bytes, RAR4),
  parse: fitted(parseRAR)
}
