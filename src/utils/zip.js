import { formatBytes } from './formatBytes.js'

const EOCD_SIGNATURE = 0x06054b50
const EOCD_SIZE = 22
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const CENTRAL_HEADER_SIZE = 46
const LOCAL_HEADER_SIGNATURE = 0x04034b50
const LOCAL_HEADER_SIZE = 30
const MAX_COMMENT_LENGTH = 0xFFFF

export const MAX_TREE_ENTRIES = 1000

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
  return { entries, complete }
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

function newDirectory() {
  return { dirs: new Map(), files: [] }
}

export function buildTree(entries) {
  const root = newDirectory()
  root.directoryCount = 0
  root.fileCount = 0
  for (const entry of entries) {
    const isDirectory = entry.name.endsWith('/')
    const parts = entry.name.split('/').filter(part => part !== '' && part !== '.')
    if (parts.length === 0) continue
    const fileName = isDirectory ? null : parts.pop()
    let node = root
    for (const part of parts) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, newDirectory())
        root.directoryCount++
      }
      node = node.dirs.get(part)
    }
    if (fileName !== null) {
      node.files.push({ ...entry, baseName: fileName })
      root.fileCount++
    }
  }
  return root
}

// Code-unit order, so the listing does not depend on the browser's locale
function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function describeFile(file) {
  const details = [file.size === null ? 'size unknown' : formatBytes(file.size)]
  if (file.method !== 0) details.push(COMPRESSION_METHODS[file.method] || `method ${file.method}`)
  if (file.encrypted) details.push('encrypted')
  return `${file.baseName} (${details.join(', ')})`
}

export function renderTree(root, maxEntries = MAX_TREE_ENTRIES) {
  const lines = ['.']
  let rendered = 0

  function walk(node, prefix) {
    const children = [
      ...[...node.dirs.keys()].sort(compareNames).map(name => ({ name, dir: node.dirs.get(name) })),
      ...[...node.files].sort((a, b) => compareNames(a.baseName, b.baseName)).map(file => ({ file }))
    ]
    children.forEach((child, index) => {
      if (rendered >= maxEntries) return
      const last = index === children.length - 1
      rendered++
      if (child.dir) {
        lines.push(`${prefix}${last ? '└── ' : '├── '}${child.name}/`)
        walk(child.dir, prefix + (last ? '    ' : '│   '))
      } else {
        lines.push(`${prefix}${last ? '└── ' : '├── '}${describeFile(child.file)}`)
      }
    })
  }

  walk(root, '')
  const total = root.directoryCount + root.fileCount
  if (total > rendered) lines.push(`… and ${total - rendered} more`)
  return lines.join('\n')
}

export function parseZIP(buffer) {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const metadata = new Set()
  const warnings = []

  let entries = []
  const eocd = view.byteLength >= EOCD_SIZE ? readEndOfCentralDirectory(view, bytes) : null
  if (eocd && !eocd.zip64Unreadable) {
    const result = readCentralDirectory(view, bytes, eocd)
    entries = result.entries
    if (!result.complete) {
      warnings.push(`Central directory is damaged or truncated; listed ${entries.length} of ${eocd.entryCount} entries`)
    }
    if (eocd.zip64 || entries.some(entry => entry.zip64)) metadata.add('ZIP64: Yes')
    if (eocd.comment) {
      const comment = sanitizeName(eocd.comment).replace(/�+/g, ' ').trim()
      if (comment) metadata.add(`Comment: ${comment.length > 200 ? comment.slice(0, 200) + '…' : comment}`)
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
  const tree = buildTree(entries)
  const knownSizes = files.filter(file => file.size !== null)
  const totalSize = knownSizes.reduce((sum, file) => sum + file.size, 0)
  const totalCompressed = knownSizes.reduce((sum, file) => sum + file.compressedSize, 0)
  const methods = [...new Set(files.map(file => COMPRESSION_METHODS[file.method] || `method ${file.method}`))].sort()
  const encrypted = files.filter(file => file.encrypted).length

  metadata.add(`Total Files: ${files.length}`)
  metadata.add(`Directories: ${tree.directoryCount}`)
  metadata.add(`Uncompressed Size: ${formatBytes(totalSize)}`)
  metadata.add(`Compressed Size: ${formatBytes(totalCompressed)}`)
  if (methods.length > 0) metadata.add(`Compression: ${methods.join(', ')}`)
  if (encrypted > 0) metadata.add(`Encrypted Files: ${encrypted}`)
  if (warnings.length > 0) metadata.add(`Warning: ${warnings.join('. ')}`)

  const contents = new Set([renderTree(tree)])
  return { metadata, contents }
}
