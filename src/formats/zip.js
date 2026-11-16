import { dataView, formatBytes, item } from './shared.js'

const EOCD_SIGNATURE = 0x06054b50
const EOCD_SIZE = 22
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const CENTRAL_HEADER_SIZE = 46
const LOCAL_HEADER_SIGNATURE = 0x04034b50
const LOCAL_HEADER_SIZE = 30
const MAX_COMMENT_LENGTH = 0xFFFF

const FLAG_ENCRYPTED = 0x0001
const FLAG_DATA_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800

const COMPRESSION_METHODS = {
  0: 'stored',
  1: 'shrunk',
  6: 'imploded',
  8: 'deflated',
  9: 'deflate64',
  12: 'bzip2',
  14: 'LZMA',
  93: 'zstd',
  95: 'xz',
  98: 'PPMd',
  99: 'AES encrypted'
}

// Code page 437, bytes 0x80-0xFF: the encoding the ZIP specification assigns
// to names without the UTF-8 flag
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

const utf8Decoder = new TextDecoder('utf-8')
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true })

function decodeCP437(bytes) {
  let out = ''
  for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]
  return out
}

// Names flagged as UTF-8 are decoded as such. Unflagged names are decoded as
// UTF-8 when they are valid UTF-8 (pure ASCII always is, and many archivers
// write UTF-8 without setting the flag), and as CP437 otherwise.
export function decodeEntryName(bytes, flags) {
  if (flags & FLAG_UTF8) return utf8Decoder.decode(bytes)
  try {
    return strictUtf8Decoder.decode(bytes)
  } catch {
    return decodeCP437(bytes)
  }
}

// Keeps a hostile or broken name from breaking the one-line-per-entry tree
function sanitizeName(name) {
  let out = ''
  for (const ch of name) {
    const code = ch.codePointAt(0)
    out += code < 0x20 || code === 0x7F ? '�' : ch
  }
  return out
}

function readUint64(view, offset) {
  const low = view.getUint32(offset, true)
  const high = view.getUint32(offset + 4, true)
  const value = high * 0x100000000 + low
  return Number.isSafeInteger(value) ? value : Infinity
}

function findEndOfCentralDirectory(view) {
  const length = view.byteLength
  const lowest = Math.max(0, length - EOCD_SIZE - MAX_COMMENT_LENGTH)
  for (let offset = length - EOCD_SIZE; offset >= lowest; offset--) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue
    const commentLength = view.getUint16(offset + 20, true)
    if (offset + EOCD_SIZE + commentLength <= length) return offset
  }
  return -1
}

function readEndOfCentralDirectory(view, bytes) {
  const eocdOffset = findEndOfCentralDirectory(view)
  if (eocdOffset === -1) return null

  const record = {
    offset: eocdOffset,
    entryCount: view.getUint16(eocdOffset + 10, true),
    directorySize: view.getUint32(eocdOffset + 12, true),
    directoryOffset: view.getUint32(eocdOffset + 16, true),
    comment: '',
    zip64: false
  }
  const commentLength = view.getUint16(eocdOffset + 20, true)
  if (commentLength > 0) {
    record.comment = decodeEntryName(bytes.subarray(eocdOffset + EOCD_SIZE, eocdOffset + EOCD_SIZE + commentLength), 0)
  }

  const locatorOffset = eocdOffset - 20
  if (locatorOffset >= 0 && view.getUint32(locatorOffset, true) === ZIP64_LOCATOR_SIGNATURE) {
    const zip64Offset = readUint64(view, locatorOffset + 8)
    if (zip64Offset + 56 <= locatorOffset && view.getUint32(zip64Offset, true) === ZIP64_EOCD_SIGNATURE) {
      record.zip64 = true
      record.entryCount = readUint64(view, zip64Offset + 32)
      record.directorySize = readUint64(view, zip64Offset + 40)
      record.directoryOffset = readUint64(view, zip64Offset + 48)
      record.offset = zip64Offset
    } else if (record.entryCount === 0xFFFF || record.directoryOffset === 0xFFFFFFFF) {
      record.zip64 = true
      record.zip64Unreadable = true
    }
  }
  return record
}

function applyZip64Extra(view, start, end, entry) {
  let offset = start
  while (offset + 4 <= end) {
    const id = view.getUint16(offset, true)
    const size = view.getUint16(offset + 2, true)
    const dataEnd = Math.min(offset + 4 + size, end)
    if (id === 0x0001) {
      let field = offset + 4
      for (const key of ['size', 'compressedSize', 'localHeaderOffset']) {
        if (entry[key] !== 0xFFFFFFFF) continue
        if (field + 8 > dataEnd) break
        entry[key] = readUint64(view, field)
        field += 8
      }
      entry.zip64 = true
      return
    }
    offset += 4 + size
  }
}

function readCentralDirectory(view, bytes, eocd) {
  const entries = []
  let offset = eocd.directoryOffset
  // Data prepended to the archive shifts every stored offset
  if (offset + 4 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_HEADER_SIGNATURE) {
    const shifted = eocd.offset - eocd.directorySize
    if (shifted >= 0 && shifted + 4 <= view.byteLength && view.getUint32(shifted, true) === CENTRAL_HEADER_SIGNATURE) {
      offset = shifted
    }
  }

  const start = offset
  const expected = eocd.entryCount
  let complete = true
  while (entries.length < expected || expected === 0xFFFF) {
    if (offset + CENTRAL_HEADER_SIZE > view.byteLength || view.getUint32(offset, true) !== CENTRAL_HEADER_SIGNATURE) {
      complete = expected === 0xFFFF && entries.length > 0
      break
    }
    const flags = view.getUint16(offset + 8, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const nameStart = offset + CENTRAL_HEADER_SIZE
    const extraEnd = nameStart + nameLength + extraLength
    if (extraEnd > view.byteLength) {
      complete = false
      break
    }
    const entry = {
      name: sanitizeName(decodeEntryName(bytes.subarray(nameStart, nameStart + nameLength), flags)),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
      encrypted: (flags & FLAG_ENCRYPTED) !== 0,
      zip64: false
    }
    applyZip64Extra(view, nameStart + nameLength, extraEnd, entry)
    entries.push(entry)
    offset = extraEnd + commentLength
  }
  return { entries, complete, start, end: Math.min(offset, view.byteLength) }
}

// Fallback when the central directory is missing: follow local headers from
// the start of the file for as long as their sizes allow.
function readLocalHeaders(view, bytes) {
  const entries = []
  let offset = 0
  let complete = true
  while (offset + 4 <= view.byteLength && view.getUint32(offset, true) === LOCAL_HEADER_SIGNATURE) {
    if (offset + LOCAL_HEADER_SIZE > view.byteLength) {
      complete = false
      break
    }
    const flags = view.getUint16(offset + 6, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const nameStart = offset + LOCAL_HEADER_SIZE
    const dataStart = nameStart + nameLength + extraLength
    if (dataStart > view.byteLength) {
      complete = false
      break
    }
    const entry = {
      name: sanitizeName(decodeEntryName(bytes.subarray(nameStart, nameStart + nameLength), flags)),
      method: view.getUint16(offset + 8, true),
      compressedSize: view.getUint32(offset + 18, true),
      size: view.getUint32(offset + 22, true),
      encrypted: (flags & FLAG_ENCRYPTED) !== 0,
      zip64: false
    }
    applyZip64Extra(view, nameStart + nameLength, dataStart, entry)
    // With a data descriptor the sizes are only known after the data
    const sizeUnknown = (flags & FLAG_DATA_DESCRIPTOR) !== 0 && entry.compressedSize === 0 && !entry.name.endsWith('/')
    if (sizeUnknown) entry.size = null
    entries.push(entry)
    if (sizeUnknown || !Number.isFinite(entry.compressedSize)) {
      complete = false
      break
    }
    offset = dataStart + entry.compressedSize
    if (flags & FLAG_DATA_DESCRIPTOR) {
      if (offset + 4 <= view.byteLength && view.getUint32(offset, true) === 0x08074b50) offset += 4
      offset += entry.zip64 ? 20 : 12
    }
  }
  return { entries, complete }
}

// Distinct directories, explicit or implied by a file's path
function countDirectories(entries) {
  const directories = new Set()
  for (const entry of entries) {
    const parts = entry.name.split('/').filter(part => part !== '' && part !== '.')
    if (!entry.name.endsWith('/')) parts.pop()
    for (let i = 1; i <= parts.length; i++) directories.add(parts.slice(0, i).join('/'))
  }
  return directories.size
}

function toArchiveEntry(entry) {
  return {
    path: entry.name,
    isDirectory: entry.name.endsWith('/'),
    size: entry.size,
    compressedSize: entry.compressedSize,
    method: methodName(entry.method),
    encrypted: entry.encrypted
  }
}

function methodName(method) {
  return COMPRESSION_METHODS[method] || `method ${method}`
}

function parseZIP(bytes) {
  const view = dataView(bytes)
  const summary = []
  const warnings = []
  const regions = []
  const fields = []
  if (bytes.length >= 4) {
    const local = bytes[2] === 0x03
    fields.push({
      name: 'Signature',
      offset: 0,
      length: 4,
      value: local ? 'PK\\x03\\x04' : 'PK\\x05\\x06',
      kind: 'magic',
      description: local ? 'Local file header' : 'End of central directory (empty archive)'
    })
  }

  let entries = []
  let zip64 = false
  let comment = ''
  const eocd = view.byteLength >= EOCD_SIZE ? readEndOfCentralDirectory(view, bytes) : null
  if (eocd && !eocd.zip64Unreadable) {
    const result = readCentralDirectory(view, bytes, eocd)
    entries = result.entries
    if (!result.complete) {
      warnings.push(`Central directory is damaged or truncated; listed ${entries.length} of ${eocd.entryCount} entries`)
    }
    zip64 = eocd.zip64 || entries.some(entry => entry.zip64)
    if (eocd.comment) {
      const clean = sanitizeName(eocd.comment).replace(/�+/g, ' ').trim()
      if (clean) comment = clean.length > 200 ? clean.slice(0, 200) + '…' : clean
    }
    if (result.end > result.start) {
      regions.push({ name: 'Central directory', offset: result.start, length: result.end - result.start, kind: 'table' })
    }
    regions.push({ name: 'End of central directory', offset: eocd.offset, length: view.byteLength - eocd.offset, kind: 'metadata' })
    if (eocd.offset > 0) {
      fields.push({ name: 'End of central directory', offset: eocd.offset, length: view.byteLength - eocd.offset, kind: 'header' })
    }
  } else {
    const result = readLocalHeaders(view, bytes)
    entries = result.entries
    warnings.push(eocd
      ? 'ZIP64 end of central directory could not be read; entries recovered from local headers'
      : 'End of central directory not found (truncated archive?); entries recovered from local headers')
    if (!result.complete) warnings.push('Listing stops early because the archive is truncated or uses data descriptors')
  }

  const files = entries.filter(entry => !entry.name.endsWith('/'))
  const knownSizes = files.filter(file => file.size !== null)
  const totalSize = knownSizes.reduce((sum, file) => sum + file.size, 0)
  const totalCompressed = knownSizes.reduce((sum, file) => sum + file.compressedSize, 0)
  const methods = [...new Set(files.map(file => methodName(file.method)))].sort()
  const encrypted = files.filter(file => file.encrypted).length

  summary.push(item('Total Files', files.length))
  summary.push(item('Directories', countDirectories(entries)))
  summary.push(item('Uncompressed Size', formatBytes(totalSize)))
  summary.push(item('Compressed Size', formatBytes(totalCompressed)))
  if (methods.length > 0) summary.push(item('Compression', methods.join(', ')))
  if (encrypted > 0) summary.push(item('Encrypted Files', encrypted))
  if (zip64) summary.push(item('ZIP64', 'Yes'))
  if (comment) summary.push(item('Comment', comment))

  return { summary, fields, regions, entries: entries.map(toArchiveEntry), warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'zip',
  name: 'ZIP Archive',
  category: 'archive',
  detect: bytes => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06)),
  parse: parseZIP
}
