import { dataView, formatBytes, item } from './shared.js'
import { FieldList, MAX_CHILDREN, field, plural } from './fieldTree.js'
import { chargeText } from './budget.js'
import { pathWarnings } from './archivePaths.js'
import { pointAt, pointNamed, unusualNote } from './pointers.js'

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
  chargeText(bytes.length)
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
    eocdOffset,
    locatorOffset: -1,
    zip64Offset: -1,
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
    let zip64Offset = readUint64(view, locatorOffset + 8)
    record.locatorOffset = locatorOffset
    // With data prepended to the archive the stored offset is too small; the
    // record normally sits right before the locator
    const isRecord = at => at >= 0 && at + 56 <= locatorOffset && view.getUint32(at, true) === ZIP64_EOCD_SIGNATURE
    if (!isRecord(zip64Offset) && isRecord(locatorOffset - 56)) zip64Offset = locatorOffset - 56
    if (zip64Offset + 56 <= locatorOffset && view.getUint32(zip64Offset, true) === ZIP64_EOCD_SIGNATURE) {
      record.zip64 = true
      record.zip64Offset = zip64Offset
      record.entryCount = readUint64(view, zip64Offset + 32)
      record.directorySize = readUint64(view, zip64Offset + 40)
      record.directoryOffset = readUint64(view, zip64Offset + 48)
      record.offset = zip64Offset
    } else if (record.entryCount === 0xFFFF || record.directoryOffset === 0xFFFFFFFF) {
      record.zip64 = true
      record.zip64Unreadable = true
    } else {
      record.offset = locatorOffset
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
      zip64: false,
      flags,
      centralOffset: offset,
      centralEnd: Math.min(extraEnd + commentLength, view.byteLength)
    }
    applyZip64Extra(view, nameStart + nameLength, extraEnd, entry)
    entries.push(entry)
    offset = extraEnd + commentLength
  }
  return { entries, complete, start, end: Math.min(offset, view.byteLength), shift: start - eocd.directoryOffset }
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
      zip64: false,
      flags,
      localHeaderOffset: offset
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

// Directories deeper than this are not counted. Real archives stay well
// under a hundred levels; a crafted name can hold over 30,000
export const MAX_DIRECTORY_DEPTH = 1024

/**
 * Distinct directories, explicit or implied by a file's path. Each directory
 * is known by a number and looked up by its parent's number and its own name,
 * so the work grows with the length of the names rather than with the square
 * of their depth, as building every full prefix would.
 */
export function countDirectories(entries) {
  const ids = new Map()
  let tooDeep = 0
  for (const entry of entries) {
    const parts = entry.name.split('/').filter(part => part !== '' && part !== '.')
    if (!entry.name.endsWith('/')) parts.pop()
    if (parts.length > MAX_DIRECTORY_DEPTH) tooDeep++
    let parent = 0
    for (let i = 0; i < parts.length && i < MAX_DIRECTORY_DEPTH; i++) {
      const key = `${parent}/${parts[i]}`
      let id = ids.get(key)
      if (id === undefined) {
        id = ids.size + 1
        ids.set(key, id)
      }
      parent = id
    }
  }
  return { count: ids.size, tooDeep }
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

// ---- structure: field trees for every record in the archive ---------------

const HOST_SYSTEMS = { 0: 'MS-DOS (FAT)', 3: 'Unix', 7: 'Macintosh', 10: 'Windows NTFS', 19: 'OS X (Darwin)' }

const EXTRA_FIELD_NAMES = {
  0x0001: 'ZIP64 extended information',
  0x000A: 'NTFS timestamps',
  0x000D: 'Unix',
  0x5455: 'Extended timestamp',
  0x7875: 'Unix UID/GID',
  0x7075: 'Unicode path',
  0x6375: 'Unicode comment',
  0x9901: 'AES encryption',
  0xCAFE: 'JAR marker'
}

const GENERAL_FLAGS = [
  [0x0001, 'encrypted'],
  [0x0008, 'data descriptor'],
  [0x0040, 'strong encryption'],
  [0x0800, 'UTF-8 names'],
  [0x2000, 'central directory encrypted']
]

const MAX_EXTRA_RECORDS = 32

function dosTime(value) {
  const pad = n => String(n).padStart(2, '0')
  return `${pad(value >> 11)}:${pad((value >> 5) & 63)}:${pad((value & 31) * 2)}`
}

function dosDate(value) {
  const pad = n => String(n).padStart(2, '0')
  return `${(value >> 9) + 1980}-${pad((value >> 5) & 15)}-${pad(value & 31)}`
}

function flagsText(flags) {
  const names = GENERAL_FLAGS.filter(([bit]) => flags & bit).map(([, name]) => name)
  return `${hex(flags)}${names.length ? ` (${names.join(', ')})` : ''}`
}

function hex(value) {
  return `0x${value.toString(16).toUpperCase()}`
}

function versionText(value) {
  return `${Math.floor((value & 0xFF) / 10)}.${(value & 0xFF) % 10}`
}

function sizeText(value) {
  return value === 0xFFFFFFFF ? '0xFFFFFFFF (in ZIP64 extra field)' : `${value.toLocaleString('en-US')} bytes`
}

function extraFields(view, start, end) {
  const children = []
  let p = start
  while (p + 4 <= end && children.length < MAX_EXTRA_RECORDS) {
    const id = view.getUint16(p, true)
    const size = view.getUint16(p + 2, true)
    const stop = Math.min(end, p + 4 + size)
    const kids = [
      field('Header ID', p, 2, { value: `${hex(id)}${EXTRA_FIELD_NAMES[id] ? ` (${EXTRA_FIELD_NAMES[id]})` : ''}`, kind: 'header' }),
      field('Data size', p + 2, 2, { value: `${size} bytes`, kind: 'size' })
    ]
    if (stop > p + 4) kids.push(field('Data', p + 4, stop - p - 4, { kind: 'data' }))
    children.push(field(EXTRA_FIELD_NAMES[id] || `Extra field ${hex(id)}`, p, stop - p, { kind: 'header', children: kids }))
    p = stop
  }
  if (p < end) children.push(field('Unparsed', p, end - p, { kind: 'data' }))
  return children
}

function nameField(bytes, label, start, length, flags) {
  if (length <= 0) return null
  return field(label, start, length, {
    value: sanitizeName(decodeEntryName(bytes.subarray(start, start + Math.min(length, 1024)), flags)),
    kind: 'string',
    description: flags & FLAG_UTF8 ? 'Encoded as UTF-8 (flag bit 11 is set)' : 'Encoded as code page 437 unless flag bit 11 says UTF-8; many tools write UTF-8 anyway'
  })
}

/** Local file header, the file data and its data descriptor */
function localEntry(view, bytes, offset, central, light = false) {
  const limit = bytes.length
  if (offset + LOCAL_HEADER_SIZE > limit) {
    return { end: limit, field: field('Truncated local file header', offset, limit - offset, { kind: 'header' }), truncated: true }
  }
  const flags = view.getUint16(offset + 6, true)
  const method = view.getUint16(offset + 8, true)
  const localCompressed = view.getUint32(offset + 18, true)
  const nameLength = view.getUint16(offset + 26, true)
  const extraLength = view.getUint16(offset + 28, true)
  const nameStart = offset + LOCAL_HEADER_SIZE
  const dataStart = nameStart + nameLength + extraLength
  let compressed = central ? central.compressedSize : localCompressed
  let unknownSize = false
  if (!central && flags & FLAG_DATA_DESCRIPTOR && localCompressed === 0) unknownSize = true
  if (!Number.isFinite(compressed)) {
    unknownSize = true
    compressed = 0
  }
  const dataEnd = dataStart + compressed
  let end = Math.min(limit, dataEnd)
  let descriptor = null
  if (flags & FLAG_DATA_DESCRIPTOR && !unknownSize && dataEnd < limit) {
    const signed = dataEnd + 4 <= limit && view.getUint32(dataEnd, true) === 0x08074b50
    const wide = central && central.zip64
    const length = (signed ? 4 : 0) + 4 + (wide ? 16 : 8)
    const stop = Math.min(limit, dataEnd + length)
    const kids = []
    let p = dataEnd
    if (signed) {
      kids.push(field('Signature', p, 4, { value: 'PK\\x07\\x08', kind: 'magic', description: 'Optional signature of a data descriptor' }))
      p += 4
    }
    if (p + 4 <= stop) kids.push(field('CRC-32', p, 4, { value: hex(view.getUint32(p, true)), kind: 'checksum' }))
    p += 4
    const width = wide ? 8 : 4
    if (p + width * 2 <= stop) {
      kids.push(field('Compressed size', p, width, { value: `${(wide ? readUint64(view, p) : view.getUint32(p, true)).toLocaleString('en-US')} bytes`, kind: 'size' }))
      kids.push(field('Uncompressed size', p + width, width, { value: `${(wide ? readUint64(view, p + width) : view.getUint32(p + width, true)).toLocaleString('en-US')} bytes`, kind: 'size' }))
    }
    descriptor = field('Data descriptor', dataEnd, stop - dataEnd, {
      kind: 'header',
      description: 'CRC and sizes written after the data, for archivers that stream and cannot seek back to the header',
      children: kids
    })
    end = stop
  }

  const headerEnd = Math.min(limit, dataStart)
  if (light) return { end: Math.max(end, headerEnd) }
  const name = sanitizeName(decodeEntryName(bytes.subarray(nameStart, Math.min(limit, nameStart + nameLength)), flags))
  const header = [
    field('Signature', offset, 4, { value: 'PK\\x03\\x04', kind: 'magic', description: '0x04034B50 little-endian: "PK" for Phil Katz, then 3, 4' }),
    field('Version needed', offset + 4, 2, { value: versionText(view.getUint16(offset + 4, true)), kind: 'header', description: 'Minimum ZIP specification version needed to extract' }),
    field('General purpose flags', offset + 6, 2, { value: flagsText(flags), kind: 'flags', description: 'Bit 0: encrypted; bit 3: sizes in a data descriptor after the data; bit 11: UTF-8 names' }),
    field('Compression method', offset + 8, 2, { value: `${method} (${methodName(method)})`, kind: 'header' }),
    field('Last modified time', offset + 10, 2, { value: dosTime(view.getUint16(offset + 10, true)), kind: 'header', description: 'MS-DOS format: 2-second resolution, local time with no time zone' }),
    field('Last modified date', offset + 12, 2, { value: dosDate(view.getUint16(offset + 12, true)), kind: 'header', description: 'MS-DOS format: years since 1980, month, day' }),
    field('CRC-32', offset + 14, 4, { value: hex(view.getUint32(offset + 14, true)), kind: 'checksum', description: 'CRC-32 of the uncompressed data; 0 here when a data descriptor follows the data' }),
    field('Compressed size', offset + 18, 4, { value: sizeText(localCompressed), kind: 'size' }),
    field('Uncompressed size', offset + 22, 4, { value: sizeText(view.getUint32(offset + 22, true)), kind: 'size' }),
    field('File name length', offset + 26, 2, { value: nameLength, kind: 'size' }),
    field('Extra field length', offset + 28, 2, { value: extraLength, kind: 'size' }),
    nameField(bytes, 'File name', nameStart, Math.min(nameLength, limit - nameStart), flags)
  ]
  if (extraLength > 0 && nameStart + nameLength < limit) {
    const extraEnd = Math.min(limit, dataStart)
    header.push(field('Extra field', nameStart + nameLength, extraEnd - nameStart - nameLength, { kind: 'header', children: extraFields(view, nameStart + nameLength, extraEnd) }))
  }
  const children = [field('Local file header', offset, headerEnd - offset, {
    kind: 'header',
    description: 'Repeats most of the central directory entry so the file can be extracted while streaming',
    children: header.filter(Boolean)
  })]
  if (dataStart < limit && compressed > 0) {
    children.push(field('File data', dataStart, Math.min(limit, dataEnd) - dataStart, {
      value: `${plural(compressed, 'byte')}, ${methodName(method)}`,
      kind: 'data',
      description: flags & FLAG_ENCRYPTED ? 'Encrypted file contents' : 'The file contents as stored by the compression method'
    }))
  }
  if (descriptor) children.push(descriptor)
  return {
    end: Math.max(end, headerEnd),
    name,
    truncated: dataEnd > limit || dataStart > limit,
    unknownSize,
    field: field(`Local file: ${name || '(no name)'}`, offset, Math.max(end, headerEnd) - offset, { value: name.endsWith('/') ? 'directory' : methodName(method), kind: 'header', description: 'A local file header followed by the file data', children })
  }
}

function centralEntry(view, bytes, entry, localAt) {
  const offset = entry.centralOffset
  const flags = view.getUint16(offset + 8, true)
  const madeBy = view.getUint16(offset + 4, true)
  const host = madeBy >> 8
  const nameLength = view.getUint16(offset + 28, true)
  const extraLength = view.getUint16(offset + 30, true)
  const commentLength = view.getUint16(offset + 32, true)
  const external = view.getUint32(offset + 38, true)
  const nameStart = offset + CENTRAL_HEADER_SIZE
  const extraStart = nameStart + nameLength
  const commentStart = extraStart + extraLength
  const mode = external >>> 16
  const children = [
    field('Signature', offset, 4, { value: 'PK\\x01\\x02', kind: 'magic', description: 'Central directory file header' }),
    field('Version made by', offset + 4, 2, { value: `${versionText(madeBy)}, ${HOST_SYSTEMS[host] || `host ${host}`}`, kind: 'header', description: 'High byte: the system that wrote the entry, which decides how external attributes are read' }),
    field('Version needed', offset + 6, 2, { value: versionText(view.getUint16(offset + 6, true)), kind: 'header' }),
    field('General purpose flags', offset + 8, 2, { value: flagsText(flags), kind: 'flags' }),
    field('Compression method', offset + 10, 2, { value: `${entry.method} (${methodName(entry.method)})`, kind: 'header' }),
    field('Last modified time', offset + 12, 2, { value: dosTime(view.getUint16(offset + 12, true)), kind: 'header' }),
    field('Last modified date', offset + 14, 2, { value: dosDate(view.getUint16(offset + 14, true)), kind: 'header' }),
    field('CRC-32', offset + 16, 4, { value: hex(view.getUint32(offset + 16, true)), kind: 'checksum', description: 'CRC-32 of the uncompressed data' }),
    field('Compressed size', offset + 20, 4, { value: sizeText(view.getUint32(offset + 20, true)), kind: 'size' }),
    field('Uncompressed size', offset + 24, 4, { value: sizeText(view.getUint32(offset + 24, true)), kind: 'size' }),
    field('File name length', offset + 28, 2, { value: nameLength, kind: 'size' }),
    field('Extra field length', offset + 30, 2, { value: extraLength, kind: 'size' }),
    field('File comment length', offset + 32, 2, { value: commentLength, kind: 'size' }),
    field('Disk number start', offset + 34, 2, { value: view.getUint16(offset + 34, true), kind: 'header', description: 'For archives split over several disks' }),
    field('Internal attributes', offset + 36, 2, { value: view.getUint16(offset + 36, true) & 1 ? '0x1 (text file)' : hex(view.getUint16(offset + 36, true)), kind: 'flags' }),
    field('External attributes', offset + 38, 4, { value: host === 3 && mode ? `${hex(external)} (Unix mode 0${mode.toString(8)})` : hex(external), kind: 'flags', description: 'Host-specific: Unix permissions in the high 16 bits, or MS-DOS attributes in the low byte' }),
    pointAt(field('Local header offset', offset + 42, 4, { value: view.getUint32(offset + 42, true) === 0xFFFFFFFF ? '0xFFFFFFFF (in ZIP64 extra field)' : hex(view.getUint32(offset + 42, true)), kind: 'offset', description: 'Where this file\'s local header starts' }), localAt, bytes.length),
    nameField(bytes, 'File name', nameStart, nameLength, flags)
  ]
  if (extraLength > 0) children.push(field('Extra field', extraStart, extraLength, { kind: 'header', children: extraFields(view, extraStart, commentStart) }))
  if (commentLength > 0 && commentStart < entry.centralEnd) {
    children.push(field('File comment', commentStart, entry.centralEnd - commentStart, { value: sanitizeName(decodeEntryName(bytes.subarray(commentStart, Math.min(entry.centralEnd, commentStart + 200)), flags)), kind: 'string' }))
  }
  return pointAt(field(entry.name || '(no name)', offset, entry.centralEnd - offset, {
    value: `${entry.size === Infinity ? '?' : formatBytes(entry.size)}, ${methodName(entry.method)}`,
    kind: 'header',
    description: 'Central directory entry: the authoritative record of one file',
    children: children.filter(Boolean)
  }), localAt, bytes.length)
}

function endRecord(view, bytes, offset) {
  const commentLength = view.getUint16(offset + 20, true)
  const entries = view.getUint16(offset + 10, true)
  const end = Math.min(bytes.length, offset + EOCD_SIZE + commentLength)
  const children = [
    field('Signature', offset, 4, { value: 'PK\\x05\\x06', kind: 'magic', description: 'End of central directory signature; readers search backwards for it' }),
    field('Number of this disk', offset + 4, 2, { value: view.getUint16(offset + 4, true), kind: 'header' }),
    field('Disk with central directory', offset + 6, 2, { value: view.getUint16(offset + 6, true), kind: 'header' }),
    field('Entries on this disk', offset + 8, 2, { value: view.getUint16(offset + 8, true) === 0xFFFF ? '0xFFFF (see ZIP64 record)' : view.getUint16(offset + 8, true), kind: 'count' }),
    field('Total entries', offset + 10, 2, { value: entries === 0xFFFF ? '0xFFFF (see ZIP64 record)' : entries, kind: 'count' }),
    field('Central directory size', offset + 12, 4, { value: sizeText(view.getUint32(offset + 12, true)), kind: 'size' }),
    field('Central directory offset', offset + 16, 4, { value: view.getUint32(offset + 16, true) === 0xFFFFFFFF ? '0xFFFFFFFF (see ZIP64 record)' : hex(view.getUint32(offset + 16, true)), kind: 'offset', description: 'Where the central directory starts, counted from the start of the archive' }),
    field('Comment length', offset + 20, 2, { value: commentLength, kind: 'size', description: 'Up to 65,535 bytes, which is why the end record has to be searched for' })
  ]
  if (commentLength > 0 && offset + EOCD_SIZE < end) {
    children.push(field('Archive comment', offset + EOCD_SIZE, end - offset - EOCD_SIZE, { value: sanitizeName(decodeEntryName(bytes.subarray(offset + EOCD_SIZE, Math.min(end, offset + EOCD_SIZE + 200)), 0)), kind: 'string' }))
  }
  return field('End of central directory', offset, end - offset, {
    value: plural(entries, 'entry', 'entries'),
    kind: 'header',
    description: 'The starting point for a reader: says how many entries there are and where the central directory is',
    children
  })
}

function zip64Record(view, offset) {
  const size = readUint64(view, offset + 4)
  const end = Math.min(view.byteLength, Math.max(offset + 56, Number.isFinite(size) ? offset + 12 + size : 0))
  const u64 = (name, at, kind, description) => field(name, at, 8, { value: kind === 'offset' ? hex(readUint64(view, at)) : readUint64(view, at).toLocaleString('en-US'), kind, description })
  const children = [
    field('Signature', offset, 4, { value: 'PK\\x06\\x06', kind: 'magic' }),
    u64('Record size', offset + 4, 'size', 'Size of the rest of the record'),
    field('Version made by', offset + 12, 2, { value: versionText(view.getUint16(offset + 12, true)), kind: 'header' }),
    field('Version needed', offset + 14, 2, { value: versionText(view.getUint16(offset + 14, true)), kind: 'header' }),
    field('Number of this disk', offset + 16, 4, { value: view.getUint32(offset + 16, true), kind: 'header' }),
    field('Disk with central directory', offset + 20, 4, { value: view.getUint32(offset + 20, true), kind: 'header' }),
    u64('Entries on this disk', offset + 24, 'count'),
    u64('Total entries', offset + 32, 'count'),
    u64('Central directory size', offset + 40, 'size'),
    u64('Central directory offset', offset + 48, 'offset')
  ]
  if (end > offset + 56) children.push(field('Extensible data', offset + 56, end - offset - 56, { kind: 'data' }))
  return field('ZIP64 end of central directory', offset, end - offset, {
    kind: 'header',
    description: '64-bit version of the end record, for archives over 4 GB or with more than 65,535 entries',
    children
  })
}

function zip64Locator(view, offset) {
  return field('ZIP64 end of central directory locator', offset, 20, {
    kind: 'header',
    description: 'Sits just before the end record and points to the ZIP64 record',
    children: [
      field('Signature', offset, 4, { value: 'PK\\x06\\x07', kind: 'magic' }),
      field('Disk with ZIP64 record', offset + 4, 4, { value: view.getUint32(offset + 4, true), kind: 'header' }),
      field('ZIP64 record offset', offset + 8, 8, { value: hex(readUint64(view, offset + 8)), kind: 'offset' }),
      field('Total disks', offset + 16, 4, { value: view.getUint32(offset + 16, true), kind: 'count' })
    ]
  })
}

/**
 * Builds the field tree and regions in file order. Local entries come from
 * the central directory when there is one (it is authoritative), else from
 * walking local headers from the start.
 */
function buildStructure(view, bytes, entries, eocd, central, warnings, unusual) {
  const top = []
  const regions = []
  const locals = new FieldList(MAX_CHILDREN, 'local files')
  const shift = central ? Math.max(0, central.shift) : 0

  const starts = []
  for (const entry of entries) {
    if (!Number.isFinite(entry.localHeaderOffset)) continue
    let at = entry.localHeaderOffset + (central ? shift : 0)
    if (at + 4 > bytes.length || view.getUint32(at, true) !== LOCAL_HEADER_SIGNATURE) {
      if (entry.localHeaderOffset + 4 <= bytes.length && view.getUint32(entry.localHeaderOffset, true) === LOCAL_HEADER_SIGNATURE) at = entry.localHeaderOffset
      else continue
    }
    starts.push({ at, entry })
  }
  const localAt = new Map(starts.map(({ at, entry }) => [entry, at]))
  starts.sort((a, b) => a.at - b.at)

  let cursor = 0
  let overlaps = 0
  let localsStart = -1
  let localsEnd = -1
  const fileRegions = []
  const limit = central ? central.start : bytes.length
  const gap = (from, to, name, description) => {
    if (to <= from) return
    if (locals.full) locals.skip(from, to - from)
    else locals.push(field(name, from, to - from, { kind: 'data', description }))
  }

  for (const { at, entry } of starts) {
    if (at < cursor || (central && at >= central.start)) {
      overlaps++
      continue
    }
    if (at > cursor) {
      if (cursor === 0) {
        top.push(field('Data before the archive', 0, at, {
          kind: 'data',
          description: 'Bytes before the first local header, for example the program of a self-extracting archive. ZIP readers start from the end, so they still work'
        }))
        regions.push({ name: 'Prefix data', offset: 0, length: at, kind: 'other' })
        warnings.push(`${plural(at, 'byte')} of data before the first local header`)
        unusual.push(unusualNote(`The archive starts ${plural(at, 'byte')} into the file, after other data; ZIP readers start from the end, so they still work.`, 0, at))
      } else {
        gap(cursor, at, 'Unreferenced data', 'Bytes between entries that no central directory entry points to')
      }
    }
    let end
    if (locals.full) {
      end = localEntry(view, bytes, at, central ? entry : null, true).end
      locals.skip(at, end - at)
    } else {
      const result = localEntry(view, bytes, at, central ? entry : null)
      end = result.end
      locals.push(result.field)
    }
    if (localsStart === -1) localsStart = at
    localsEnd = end
    if (fileRegions.length <= 64) fileRegions.push({ name: entry.name || 'Local file', offset: at, length: end - at, kind: 'data' })
    cursor = end
  }
  if (overlaps) warnings.push(`${plural(overlaps, 'local file overlaps', 'local files overlap')} another entry (a damaged archive, or a "zip bomb" that reuses data)`)
  if (fileRegions.length > 0 && fileRegions.length <= 64) regions.push(...fileRegions)
  else if (localsStart !== -1) regions.push({ name: 'Local files', offset: localsStart, length: localsEnd - localsStart, kind: 'data' })

  if (central && cursor < limit) {
    gap(cursor, limit, 'Unreferenced data', localsStart === -1
      ? 'Bytes before the central directory that no entry points to'
      : 'Bytes between the last entry and the central directory')
  }
  top.push(...locals.toArray())
  if (!central) {
    if (cursor < bytes.length && cursor > 0) {
      top.push(field('Unparsed data', cursor, bytes.length - cursor, { kind: 'data', description: 'Not reached by following local headers' }))
    }
    return { fields: top, regions }
  }

  if (central.end > central.start) {
    const list = new FieldList(MAX_CHILDREN, 'entries')
    for (const entry of entries) {
      if (list.full) list.skip(entry.centralOffset, entry.centralEnd - entry.centralOffset)
      else list.push(centralEntry(view, bytes, entry, localAt.get(entry)))
    }
    top.push(field('Central directory', central.start, central.end - central.start, {
      value: plural(entries.length, 'entry', 'entries'),
      kind: 'header',
      description: 'The archive\'s table of contents: one record per file, with its name, sizes and the offset of its local header',
      children: list.toArray()
    }))
    regions.push({ name: 'Central directory', offset: central.start, length: central.end - central.start, kind: 'table' })
  }
  let after = Math.max(central.end, cursor)
  if (eocd.zip64Offset >= after) {
    if (eocd.zip64Offset > after) top.push(field('Unreferenced data', after, eocd.zip64Offset - after, { kind: 'data' }))
    const record = zip64Record(view, eocd.zip64Offset)
    pointNamed(record.children, { 'Central directory offset': central.end > central.start ? central.start : null }, bytes.length)
    if (record.offset + record.length <= eocd.locatorOffset) {
      top.push(record)
      after = record.offset + record.length
    }
  }
  if (eocd.locatorOffset >= after) {
    if (eocd.locatorOffset > after) top.push(field('Unreferenced data', after, eocd.locatorOffset - after, { kind: 'data' }))
    const locator = zip64Locator(view, eocd.locatorOffset)
    pointNamed(locator.children, { 'ZIP64 record offset': eocd.zip64Offset >= 0 ? eocd.zip64Offset : null }, bytes.length)
    top.push(locator)
    after = eocd.locatorOffset + 20
  }
  if (eocd.eocdOffset > after) top.push(field('Unreferenced data', after, eocd.eocdOffset - after, { kind: 'data' }))
  const record = endRecord(view, bytes, eocd.eocdOffset)
  pointNamed(record.children, { 'Central directory offset': central.end > central.start && view.getUint32(eocd.eocdOffset + 16, true) !== 0xFFFFFFFF ? central.start : null }, bytes.length)
  top.push(record)
  const endCount = view.getUint16(eocd.eocdOffset + 10, true)
  if (eocd.zip64Offset >= 0 && endCount !== 0xFFFF && Number.isFinite(eocd.entryCount) && endCount !== eocd.entryCount) {
    unusual.push(unusualNote(`The end record counts ${plural(endCount, 'entry', 'entries')} and the ZIP64 end record ${plural(eocd.entryCount, 'entry', 'entries')}; normally they agree.`, eocd.eocdOffset + 10, 2))
  }
  const recordsStart = eocd.zip64Offset >= 0 ? eocd.zip64Offset : eocd.locatorOffset >= 0 ? eocd.locatorOffset : eocd.eocdOffset
  regions.push({ name: 'End records', offset: recordsStart, length: record.offset + record.length - recordsStart, kind: 'metadata' })
  const tail = record.offset + record.length
  if (tail < bytes.length) {
    top.push(field('Data after the end record', tail, bytes.length - tail, { kind: 'data', description: 'Bytes after the end of central directory record and its comment; not part of the archive' }))
    regions.push({ name: 'Trailing data', offset: tail, length: bytes.length - tail, kind: 'other' })
    warnings.push(`${plural(bytes.length - tail, 'byte')} of data after the end of central directory record`)
    unusual.push(unusualNote(`${plural(bytes.length - tail, 'byte')} follow the end of central directory record, which normally ends the file.`, tail, bytes.length - tail))
  }
  return { fields: top, regions }
}

// ---- ZIP-based containers -------------------------------------------------

const MIMETYPES = {
  'application/epub+zip': ['EPUB e-book', 'An EPUB e-book: XHTML content, styles and images in a ZIP, described by an OPF package file'],
  'application/vnd.oasis.opendocument.text': ['OpenDocument text (ODT)', 'An OpenDocument text document: XML parts in a ZIP package'],
  'application/vnd.oasis.opendocument.spreadsheet': ['OpenDocument spreadsheet (ODS)', 'An OpenDocument spreadsheet: XML parts in a ZIP package'],
  'application/vnd.oasis.opendocument.presentation': ['OpenDocument presentation (ODP)', 'An OpenDocument presentation: XML parts in a ZIP package'],
  'application/vnd.oasis.opendocument.graphics': ['OpenDocument drawing (ODG)', 'An OpenDocument drawing: XML parts in a ZIP package']
}

const EXTENSION_HINTS = {
  xpi: ['Firefox add-on (XPI)', 'A Firefox extension: a WebExtension (manifest.json, scripts and assets) in a signed ZIP'],
  crx: ['Chrome extension (CRX)', 'A Chrome extension: a signed header followed by a ZIP with manifest.json, scripts and assets']
}

// The first stored entry named "mimetype" gives the type of ODF and EPUB files
function readMimetype(view, bytes, entries) {
  const entry = entries.find(e => e.name === 'mimetype')
  if (!entry || entry.method !== 0 || !Number.isFinite(entry.localHeaderOffset)) return null
  const at = entry.localHeaderOffset
  if (at + LOCAL_HEADER_SIZE > bytes.length || view.getUint32(at, true) !== LOCAL_HEADER_SIGNATURE) return null
  const start = at + LOCAL_HEADER_SIZE + view.getUint16(at + 26, true) + view.getUint16(at + 28, true)
  const size = Math.min(entry.compressedSize, 100)
  if (start + size > bytes.length) return null
  return String.fromCharCode(...bytes.subarray(start, start + size)).trim()
}

/**
 * Recognises formats that are ZIP archives with a known layout.
 * @returns {[string, string] | null} display name and a one-line description
 */
export function identifyContainer(entries, { mimetype = null, fileName = '' } = {}) {
  const names = new Set()
  for (const entry of entries) names.add(entry.name)
  const has = name => names.has(name)
  const any = test => entries.some(entry => test(entry.name))
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName || '') || [])[1]?.toLowerCase()

  if (mimetype && MIMETYPES[mimetype]) return MIMETYPES[mimetype]
  if (any(name => /^[^/]+\.nuspec$/i.test(name))) return ['NuGet package', 'A NuGet package: .NET assemblies and a .nuspec manifest in an Open Packaging Conventions ZIP']
  if (has('[Content_Types].xml')) {
    if (any(name => name.startsWith('word/'))) return ['Word document (DOCX)', 'An Office Open XML word-processing document: XML parts and media in a ZIP package']
    if (any(name => name.startsWith('xl/'))) return ['Excel workbook (XLSX)', 'An Office Open XML spreadsheet: XML parts and media in a ZIP package']
    if (any(name => name.startsWith('ppt/'))) return ['PowerPoint presentation (PPTX)', 'An Office Open XML presentation: XML parts and media in a ZIP package']
  }
  if (has('AndroidManifest.xml') && (has('classes.dex') || has('resources.arsc'))) return ['Android package (APK)', 'An Android app: compiled manifest, Dalvik bytecode (classes.dex) and resources in a signed ZIP']
  if (any(name => /^Payload\/[^/]+\.app\//.test(name))) return ['iOS app archive (IPA)', 'An iOS app bundle inside a Payload folder in a ZIP']
  if (any(name => /^[^/]+\.dist-info\/WHEEL$/.test(name))) return ['Python wheel', 'A built Python package: modules and a .dist-info metadata folder in a ZIP']
  if (has('META-INF/MANIFEST.MF')) {
    if (any(name => name.startsWith('WEB-INF/'))) return ['Web application archive (WAR)', 'A Java web application: classes, libraries and WEB-INF configuration in a ZIP']
    return ['Java archive (JAR)', 'Java classes and resources in a ZIP, described by META-INF/MANIFEST.MF']
  }
  if (has('manifest.json') && (ext === 'xpi' || any(name => name === 'META-INF/mozilla.rsa' || name === 'META-INF/cose.sig'))) return EXTENSION_HINTS.xpi
  return null
}

// CRX: "Cr24", a version, then either the public key and signature (v2) or a
// protobuf header (v3), followed by an ordinary ZIP archive
function crxHeader(view, bytes) {
  if (bytes.length < 16) return null
  const version = view.getUint32(4, true)
  if (version === 2) {
    const keyLength = view.getUint32(8, true)
    const sigLength = view.getUint32(12, true)
    const end = 16 + keyLength + sigLength
    if (end > bytes.length) return null
    return {
      end,
      field: field('CRX header', 0, end, {
        value: 'version 2',
        kind: 'magic',
        description: 'Chrome extension header: the developer\'s public key and a signature over the ZIP that follows',
        children: [
          field('Magic', 0, 4, { value: 'Cr24', kind: 'magic', description: 'Identifies a Chrome extension package' }),
          field('Version', 4, 4, { value: 2, kind: 'header' }),
          field('Public key length', 8, 4, { value: keyLength, kind: 'size' }),
          field('Signature length', 12, 4, { value: sigLength, kind: 'size' }),
          keyLength ? field('Public key', 16, keyLength, { kind: 'data' }) : null,
          sigLength ? field('Signature', 16 + keyLength, sigLength, { kind: 'checksum' }) : null
        ].filter(Boolean)
      })
    }
  }
  if (version === 3) {
    const headerLength = view.getUint32(8, true)
    const end = 12 + headerLength
    if (end > bytes.length) return null
    return {
      end,
      field: field('CRX header', 0, end, {
        value: 'version 3',
        kind: 'magic',
        description: 'Chrome extension header: a protocol buffer with keys and signatures over the ZIP that follows',
        children: [
          field('Magic', 0, 4, { value: 'Cr24', kind: 'magic', description: 'Identifies a Chrome extension package' }),
          field('Version', 4, 4, { value: 3, kind: 'header' }),
          field('Header length', 8, 4, { value: headerLength, kind: 'size' }),
          headerLength ? field('Signed header', 12, headerLength, { kind: 'data', description: 'Protocol buffer with proofs (public keys and signatures)' }) : null
        ].filter(Boolean)
      })
    }
  }
  return null
}

// Hostile archives can point records into each other; keep the tree's
// top level in file order without overlaps
function dropOverlaps(fields, warnings) {
  const sorted = [...fields].sort((a, b) => a.offset - b.offset)
  const out = []
  let end = 0
  let dropped = 0
  for (const f of sorted) {
    if (f.offset < end) {
      dropped++
      continue
    }
    out.push(f)
    end = f.offset + f.length
  }
  if (dropped) warnings.push(`${plural(dropped, 'record overlaps', 'records overlap')} other records and ${dropped === 1 ? 'is' : 'are'} not shown in the structure`)
  return out
}

// The record at offset 0 carries the file signature
function markSignatureRecord(fields) {
  const first = fields[0]
  if (first && first.offset === 0 && first.children) {
    first.kind = 'magic'
    first.description = `${first.description}. Its "PK" signature is what identifies the file as a ZIP archive`
  }
}

function shiftTree(fields, by) {
  for (const f of fields) {
    f.offset += by
    if (f.children) shiftTree(f.children, by)
  }
}

function parseZIP(bytes, meta = {}) {
  const isCrx = bytes.length >= 4 && bytes[0] === 0x43 && bytes[1] === 0x72 && bytes[2] === 0x32 && bytes[3] === 0x34
  if (isCrx) {
    const header = crxHeader(dataView(bytes), bytes)
    if (!header) return { summary: [item('Container', 'Chrome extension (CRX) with an unreadable header')], fields: [field('Magic', 0, 4, { value: 'Cr24', kind: 'magic' })], warnings: ['CRX header is truncated or of an unknown version'] }
    const inner = parseArchive(bytes.subarray(header.end), meta)
    shiftTree(inner.fields, header.end)
    for (const region of inner.regions) region.offset += header.end
    for (const note of inner.unusual) if (note.offset !== undefined) note.offset += header.end
    if (inner.fields[0] && inner.fields[0].kind === 'magic') inner.fields[0].kind = 'header'
    inner.fields.unshift(header.field)
    inner.regions.unshift({ name: 'CRX header', offset: 0, length: header.end, kind: 'header' })
    inner.formatName = EXTENSION_HINTS.crx[0]
    inner.summary.unshift(item('Container', EXTENSION_HINTS.crx[1]))
    return inner
  }
  return parseArchive(bytes, meta)
}

function parseArchive(bytes, meta) {
  const view = dataView(bytes)
  const summary = []
  const warnings = []
  let fields = []
  let regions = []

  let entries = []
  let zip64 = false
  let comment = ''
  let central = null
  const eocd = view.byteLength >= EOCD_SIZE ? readEndOfCentralDirectory(view, bytes) : null
  if (eocd && !eocd.zip64Unreadable) {
    central = readCentralDirectory(view, bytes, eocd)
    entries = central.entries
    if (!central.complete) {
      warnings.push(`Central directory is damaged or truncated; listed ${entries.length} of ${eocd.entryCount} entries`)
    }
    zip64 = eocd.zip64 || entries.some(entry => entry.zip64)
    if (eocd.comment) {
      const clean = sanitizeName(eocd.comment).replace(/�+/g, ' ').trim()
      if (clean) comment = clean.length > 200 ? clean.slice(0, 200) + '…' : clean
    }
  } else {
    const result = readLocalHeaders(view, bytes)
    entries = result.entries
    warnings.push(eocd
      ? 'ZIP64 end of central directory could not be read; entries recovered from local headers'
      : 'End of central directory not found (truncated archive?); entries recovered from local headers')
    if (!result.complete) warnings.push('Listing stops early because the archive is truncated or uses data descriptors')
  }

  const unusual = []
  const structure = buildStructure(view, bytes, entries, eocd, central, warnings, unusual)
  fields = dropOverlaps(structure.fields, warnings)
  regions = structure.regions

  const container = identifyContainer(entries, { mimetype: readMimetype(view, bytes, entries), fileName: meta.fileName })
  if (container) summary.push(item('Container', container[1]))

  const files = entries.filter(entry => !entry.name.endsWith('/'))
  const knownSizes = files.filter(file => file.size !== null)
  const totalSize = knownSizes.reduce((sum, file) => sum + file.size, 0)
  const totalCompressed = knownSizes.reduce((sum, file) => sum + file.compressedSize, 0)
  const methods = [...new Set(files.map(file => methodName(file.method)))].sort()
  const encrypted = files.filter(file => file.encrypted).length

  summary.push(item('Total Files', files.length))
  const directories = countDirectories(entries)
  summary.push(item('Directories', directories.tooDeep ? `${directories.count} or more` : directories.count))
  if (directories.tooDeep) {
    warnings.push(`${plural(directories.tooDeep, 'entry has a path', 'entries have paths')} more than ${MAX_DIRECTORY_DEPTH.toLocaleString('en-US')} folders deep; deeper folders are not counted`)
  }
  summary.push(item('Uncompressed Size', formatBytes(totalSize)))
  summary.push(item('Compressed Size', formatBytes(totalCompressed)))
  if (methods.length > 0) summary.push(item('Compression', methods.join(', ')))
  if (encrypted > 0) summary.push(item('Encrypted Files', encrypted))
  if (zip64) summary.push(item('ZIP64', 'Yes'))
  if (comment) summary.push(item('Comment', comment))

  warnings.push(...pathWarnings(entries.map(entry => entry.name)))

  markSignatureRecord(fields)
  const result = { summary, fields, regions, entries: entries.map(toArchiveEntry), warnings, unusual }
  if (container) result.formatName = container[0]
  return result
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'zip',
  name: 'ZIP Archive',
  category: 'archive',
  detect: bytes => bytes.length >= 4 && (
    (bytes[0] === 0x50 && bytes[1] === 0x4B &&
      ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))) ||
    (bytes[0] === 0x43 && bytes[1] === 0x72 && bytes[2] === 0x32 && bytes[3] === 0x34)),
  parse: parseZIP
}
