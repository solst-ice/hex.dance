import { capFields, field, fitted, formatNumber, latin1, plural, printable, unixDate } from './reader.js'
import { formatBytes, item } from './shared.js'
import { chargeText } from './budget.js'

const BLOCK = 512
const MAX_ENTRIES = 100000
const MAX_ENTRY_FIELDS = 100
const MAX_PAX_RECORDS = 256

const TYPES = {
  '0': 'regular file', '\0': 'regular file', '1': 'hard link', '2': 'symbolic link', '3': 'character device',
  '4': 'block device', '5': 'directory', '6': 'FIFO', '7': 'contiguous file', 'x': 'pax extended header',
  'g': 'pax global header', 'L': 'GNU long name', 'K': 'GNU long link name', 'D': 'GNU directory dump',
  'M': 'GNU multi-volume continuation', 'S': 'GNU sparse file', 'V': 'volume label'
}

const utf8 = new TextDecoder('utf-8')

function cString(bytes, offset, length) {
  let end = offset
  while (end < offset + length && bytes[end] !== 0) end++
  chargeText(end - offset)
  return utf8.decode(bytes.subarray(offset, end))
}

/** Octal (or GNU base-256) number field; NaN when malformed */
export function readNumber(bytes, offset, length) {
  if (bytes[offset] & 0x80) {
    if (bytes[offset] === 0xFF) return NaN
    let value = bytes[offset] & 0x7F
    for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]
    return value
  }
  let i = offset
  const end = offset + length
  while (i < end && bytes[i] === 0x20) i++
  let value = 0
  let digits = 0
  for (; i < end; i++) {
    const c = bytes[i]
    if (c >= 0x30 && c <= 0x37) {
      value = value * 8 + (c - 0x30)
      digits++
    } else if (c === 0 || c === 0x20) {
      break
    } else {
      return NaN
    }
  }
  return digits > 0 ? value : NaN
}

function checksums(bytes, offset) {
  let unsigned = 0
  let signed = 0
  for (let i = offset; i < offset + BLOCK; i++) {
    const byte = i >= offset + 148 && i < offset + 156 ? 0x20 : bytes[i]
    unsigned += byte
    signed += byte > 127 ? byte - 256 : byte
  }
  return { unsigned, signed }
}

export function isTarHeader(bytes, offset) {
  if (offset + BLOCK > bytes.length) return false
  const stored = readNumber(bytes, offset + 148, 8)
  if (!Number.isFinite(stored)) return false
  const { unsigned, signed } = checksums(bytes, offset)
  return stored === unsigned || stored === signed
}

function isZeroBlock(bytes, offset) {
  for (let i = offset; i < offset + BLOCK; i++) if (bytes[i] !== 0) return false
  return true
}

function parsePax(bytes, start, end) {
  const records = {}
  let pos = start
  let count = 0
  while (pos < end && count < MAX_PAX_RECORDS) {
    let space = pos
    while (space < end && space < pos + 20 && bytes[space] !== 0x20) space++
    const length = Number(latin1(bytes, pos, space - pos))
    if (!Number.isSafeInteger(length) || length <= space - pos || pos + length > end) break
    const record = utf8.decode(bytes.subarray(space + 1, pos + length - 1))
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    pos += length
    count++
  }
  return records
}

function variantOf(bytes, offset) {
  const magic = latin1(bytes, offset + 257, 6)
  if (magic === 'ustar\0') return 'ustar'
  if (magic === 'ustar ') return 'gnu'
  return 'v7'
}

function headerFields(bytes, offset, variant, checksumOk) {
  const text = (name, start, length, description) => field(name, offset + start, length, printable(cString(bytes, offset + start, length)), description, 'string')
  const octal = (name, start, length, description, format = String, kind) => {
    const value = readNumber(bytes, offset + start, length)
    return field(name, offset + start, length, Number.isFinite(value) ? format(value) : 'not set', description, kind)
  }
  const type = String.fromCharCode(bytes[offset + 156])
  const list = [
    text('Name', 0, 100, 'Path, or its last part when a prefix is used'),
    octal('Mode', 100, 8, 'Permission bits (octal)', value => value.toString(8).padStart(4, '0'), 'flags'),
    octal('Owner ID', 108, 8, 'Numeric user id'),
    octal('Group ID', 116, 8, 'Numeric group id'),
    octal('Size', 124, 12, 'Bytes of data that follow the header', formatNumber, 'size'),
    octal('Modified', 136, 12, 'Unix time', unixDate),
    octal('Checksum', 148, 8, 'Sum of the header bytes with this field as spaces', value => `${value} (${checksumOk ? 'valid' : 'mismatch'})`, 'checksum'),
    field('Type', offset + 156, 1, `${type === '\0' ? '\\0' : printable(type)} (${TYPES[type] || 'unknown'})`, 'Entry type flag', 'flags'),
    text('Link target', 157, 100, 'Target of a hard or symbolic link')
  ]
  if (variant !== 'v7') {
    list.push(
      field('Magic', offset + 257, 8, printable(latin1(bytes, offset + 257, 8).replace(/\0/g, ' ').trim()), variant === 'gnu' ? 'GNU tar format' : 'POSIX ustar format', 'magic'),
      text('Owner name', 265, 32, 'User name'),
      text('Group name', 297, 32, 'Group name')
    )
    if (type === '3' || type === '4') {
      list.push(octal('Device major', 329, 8, 'Device number'), octal('Device minor', 337, 8, 'Device number'))
    }
    if (variant === 'ustar' && bytes[offset + 345] !== 0) list.push(text('Prefix', 345, 155, 'Leading directories of the path'))
  }
  return list
}

function parseTar(bytes) {
  const warnings = []
  const regions = []
  const entryFields = []
  const entries = []
  const variants = new Set()
  let offset = 0
  let pending = {}
  let global = {}
  let files = 0
  let directories = 0
  let links = 0
  let totalSize = 0
  let latest = 0
  let endFound = false
  let hiddenCount = 0

  while (offset + BLOCK <= bytes.length) {
    if (isZeroBlock(bytes, offset)) {
      const second = offset + 2 * BLOCK <= bytes.length && isZeroBlock(bytes, offset + BLOCK)
      if (!second) warnings.push('Only one zero block marks the end of the archive (two are expected)')
      const markerLength = second ? 2 * BLOCK : BLOCK
      entryFields.push(field('End of archive', offset, markerLength, undefined, 'Zero blocks marking the end', 'padding'))
      regions.push({ name: 'End of archive', offset, length: markerLength, kind: 'padding' })
      offset += markerLength
      endFound = true
      break
    }
    const checksumOk = isTarHeader(bytes, offset)
    if (!checksumOk) {
      warnings.push(`Invalid header checksum at offset ${offset}; listing stops here`)
      break
    }
    const variant = variantOf(bytes, offset)
    variants.add(variant)
    const type = String.fromCharCode(bytes[offset + 156])
    let size = readNumber(bytes, offset + 124, 12)
    if (!Number.isFinite(size)) size = 0
    const dataStart = offset + BLOCK
    const dataBlocks = Math.ceil(size / BLOCK)
    const next = dataStart + dataBlocks * BLOCK
    const dataEnd = Math.min(dataStart + size, bytes.length)

    let name = cString(bytes, offset, 100)
    if (variant === 'ustar' && bytes[offset + 345] !== 0) name = `${cString(bytes, offset + 345, 155)}/${name}`
    let label = TYPES[type] || `type ${printable(type)}`

    if (type === 'x' || type === 'g') {
      const records = parsePax(bytes, dataStart, dataEnd)
      if (type === 'x') pending = { ...pending, ...records }
      else global = { ...global, ...records }
      variants.add('pax')
      label = `${label}${Object.keys(records).length ? `: ${Object.keys(records).slice(0, 4).join(', ')}` : ''}`
    } else if (type === 'L' || type === 'K') {
      const text = cString(bytes, dataStart, Math.max(0, dataEnd - dataStart))
      pending[type === 'L' ? 'path' : 'linkpath'] = text
    } else {
      const merged = { ...global, ...pending }
      if (merged.path) name = merged.path
      if (merged.size && Number.isSafeInteger(Number(merged.size))) size = Number(merged.size)
      const mtime = merged.mtime ? Number(merged.mtime) : readNumber(bytes, offset + 136, 12)
      if (Number.isFinite(mtime) && mtime > latest) latest = mtime
      pending = {}
      const isDirectory = type === '5' || name.endsWith('/')
      if (isDirectory) directories++
      else if (type === '1' || type === '2') links++
      else {
        files++
        totalSize += size
      }
      if (entries.length < MAX_ENTRIES) {
        entries.push({ path: printable(name, 4096), isDirectory, size: isDirectory ? 0 : size, compressedSize: size, method: type === '2' ? 'symlink' : type === '1' ? 'hard link' : 'stored', encrypted: false })
      } else {
        hiddenCount++
      }
    }

    const children = [field('Header', offset, BLOCK, label, 'tar header block', 'header', headerFields(bytes, offset, variant, true))]
    if (size > 0 && dataStart < bytes.length) {
      children.push(field('Data', dataStart, Math.min(size, bytes.length - dataStart), formatBytes(size), 'Entry contents', 'data'))
      const padding = Math.min(next, bytes.length) - (dataStart + size)
      if (padding > 0) children.push(field('Padding', dataStart + size, padding, undefined, 'Zero fill to a 512-byte boundary', 'padding'))
    }
    if (entryFields.length <= MAX_ENTRY_FIELDS) {
      entryFields.push(field(printable(name || '(no name)', 120), offset, Math.min(next, bytes.length) - offset, label, `tar entry (${label})`, 'header', children))
    } else {
      entryFields.push({ name: '', offset, length: Math.min(next, bytes.length) - offset })
    }
    regions.push({ name: 'Header', offset, length: BLOCK, kind: 'header' })
    if (size > 0) regions.push({ name: 'Data', offset: dataStart, length: Math.min(dataBlocks * BLOCK, bytes.length - dataStart), kind: 'data' })
    if (next > bytes.length) warnings.push(`Data of "${printable(name, 80)}" is truncated`)
    offset = next
    if (entryFields.length > MAX_ENTRIES * 2) {
      warnings.push(`Stopped after ${formatNumber(MAX_ENTRIES * 2)} headers`)
      break
    }
  }

  if (!endFound && offset >= bytes.length) warnings.push('No end-of-archive marker; the archive may be truncated')
  if (endFound && offset < bytes.length) {
    let zeros = true
    for (let i = offset; i < bytes.length && zeros; i++) zeros = bytes[i] === 0
    if (zeros) {
      entryFields.push(field('Record padding', offset, bytes.length - offset, formatBytes(bytes.length - offset), 'Zero fill to the tar record size', 'padding'))
      regions.push({ name: 'Record padding', offset, length: bytes.length - offset, kind: 'padding' })
    } else {
      warnings.push(`${plural(bytes.length - offset, 'byte')} of data after the end-of-archive marker`)
      regions.push({ name: 'Trailing data', offset, length: bytes.length - offset, kind: 'other' })
    }
  }
  if (hiddenCount > 0) warnings.push(`Listed the first ${formatNumber(MAX_ENTRIES)} entries; ${formatNumber(hiddenCount)} more not listed`)

  // Keep the end marker and padding visible even when entries are folded
  const tail = entryFields.filter(entry => entry.kind === 'padding')
  const body = entryFields.filter(entry => entry.kind !== 'padding')
  const fields = [...capFields(body, MAX_ENTRY_FIELDS, 'more entries'), ...tail]

  const summary = []
  const variantName = variants.has('pax') ? 'POSIX pax' : variants.has('gnu') ? 'GNU tar' : variants.has('ustar') ? 'POSIX ustar' : 'Unix V7 tar'
  summary.push(item('Format', variantName))
  summary.push(item('Total Files', formatNumber(files)))
  summary.push(item('Directories', formatNumber(directories)))
  if (links) summary.push(item('Links', formatNumber(links)))
  summary.push(item('Total Size', `${formatBytes(totalSize)} (${formatNumber(totalSize)} bytes)`))
  if (latest > 0) summary.push(item('Latest Modification', unixDate(latest)))

  return { summary, fields, regions: regions.length > 5000 ? coarse(regions, bytes.length) : regions, entries, warnings }
}

// Many small entries would flood the map; merge them into one region
function coarse(regions, size) {
  const end = regions.filter(region => region.kind !== 'padding').reduce((max, region) => Math.max(max, region.offset + region.length), 0)
  return [{ name: 'Entries', offset: 0, length: Math.min(end, size), kind: 'data' }, ...regions.filter(region => region.kind === 'padding' || region.kind === 'other')]
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'tar',
  name: 'tar Archive',
  category: 'archive',
  // tar has no magic at offset 0: the first header's checksum must match
  detect: bytes => bytes.length >= BLOCK && bytes[0] !== 0 && isTarHeader(bytes, 0),
  parse: fitted(parseTar)
}
