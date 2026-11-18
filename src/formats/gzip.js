import { walkDeflate } from './deflate.js'
import { ByteReader, capFields, field, fitted, formatNumber, hex32, latin1, plural, printable, unixDate } from './reader.js'
import { crc32 } from '../lib/crc32.js'
import { formatBytes, item } from './shared.js'
import { refundRows } from './budget.js'

const FTEXT = 1
const FHCRC = 2
const FEXTRA = 4
const FNAME = 8
const FCOMMENT = 16

// How much compressed input is walked to find member boundaries; past this
// the rest of the file is assumed to be one member.
const SCAN_LIMIT = 32 * 1024 * 1024
const MAX_MEMBERS = 100000
const MAX_MEMBER_FIELDS = 64
const MAX_STRING = 1024

const OPERATING_SYSTEMS = {
  0: 'FAT (MS-DOS, Windows)', 1: 'Amiga', 2: 'VMS', 3: 'Unix', 4: 'VM/CMS', 5: 'Atari TOS', 6: 'HPFS (OS/2)',
  7: 'Macintosh', 8: 'Z-System', 9: 'CP/M', 10: 'TOPS-20', 11: 'NTFS', 12: 'QDOS', 13: 'Acorn RISC OS', 255: 'Unknown'
}

const isMember = (bytes, offset) => bytes[offset] === 0x1F && bytes[offset + 1] === 0x8B && bytes[offset + 2] === 0x08

function readZeroTerminated(bytes, start) {
  let end = start
  const limit = Math.min(bytes.length, start + 64 * 1024)
  while (end < limit && bytes[end] !== 0) end++
  if (end >= limit) return null
  return { text: latin1(bytes, start, Math.min(end - start, MAX_STRING)), end: end + 1 }
}

// Header of one member; returns null if it is cut off
function readHeader(r, start) {
  const { bytes } = r
  if (!r.has(start, 10)) return null
  const flags = bytes[start + 3]
  const mtime = r.u32(start + 4)
  const xfl = bytes[start + 8]
  const os = bytes[start + 9]
  const info = { flags, mtime, xfl, os, name: null, comment: null, extra: [], headerCrc: null, headerCrcOk: null }
  const children = [
    field('Magic', start, 2, '1F 8B', 'gzip member signature', 'magic'),
    field('Compression method', start + 2, 1, '8 (deflate)', 'The only method gzip defines'),
    field('Flags', start + 3, 1, describeFlags(flags), 'Which optional header parts follow', 'flags'),
    field('Modification time', start + 4, 4, mtime ? unixDate(mtime) : 'not set', 'Of the original file, Unix seconds'),
    field('Extra flags', start + 8, 1, xfl === 2 ? '2 (maximum compression)' : xfl === 4 ? '4 (fastest compression)' : String(xfl), 'Compression level hint'),
    field('Operating system', start + 9, 1, OPERATING_SYSTEMS[os] || `${os} (unknown)`, 'Where the file was compressed')
  ]
  let pos = start + 10
  if (flags & FEXTRA) {
    if (!r.has(pos, 2)) return null
    const xlen = r.u16(pos)
    if (!r.has(pos + 2, xlen)) return null
    const subfields = []
    let sub = pos + 2
    const subEnd = pos + 2 + xlen
    while (sub + 4 <= subEnd && subfields.length < 32) {
      const id = latin1(bytes, sub, 2)
      const size = r.u16(sub + 2)
      if (sub + 4 + size > subEnd) break
      let value = `${size} bytes`
      if (id === 'BC' && size === 2) value = `BGZF block, ${formatNumber(r.u16(sub + 4) + 1)} bytes compressed`
      info.extra.push(printable(id))
      subfields.push(field(`Subfield ${printable(id)}`, sub, 4 + size, value, id === 'BC' ? 'Blocked gzip (bgzip/BAM) block size' : 'Extra subfield'))
      sub += 4 + size
    }
    children.push(field('Extra field', pos, 2 + xlen, `${xlen} bytes`, 'Length-prefixed subfields', 'data',
      [field('Extra length', pos, 2, xlen, 'Bytes of extra data', 'size'), ...subfields]))
    pos += 2 + xlen
  }
  if (flags & FNAME) {
    const name = readZeroTerminated(bytes, pos)
    if (!name) return null
    info.name = name.text
    children.push(field('Original name', pos, name.end - pos, printable(name.text), 'File name before compression, NUL-terminated', 'string'))
    pos = name.end
  }
  if (flags & FCOMMENT) {
    const comment = readZeroTerminated(bytes, pos)
    if (!comment) return null
    info.comment = comment.text
    children.push(field('Comment', pos, comment.end - pos, printable(comment.text), 'NUL-terminated comment', 'string'))
    pos = comment.end
  }
  if (flags & FHCRC) {
    if (!r.has(pos, 2)) return null
    info.headerCrc = r.u16(pos)
    info.headerCrcOk = (crc32(bytes, start, pos) & 0xFFFF) === info.headerCrc
    children.push(field('Header CRC16', pos, 2, `0x${info.headerCrc.toString(16).toUpperCase().padStart(4, '0')}${info.headerCrcOk ? ' (valid)' : ' (mismatch)'}`, 'Low 16 bits of the CRC-32 of the header', 'checksum'))
    pos += 2
  }
  return { start, end: pos, info, children }
}

function describeFlags(flags) {
  const names = []
  if (flags & FTEXT) names.push('text')
  if (flags & FHCRC) names.push('header CRC')
  if (flags & FEXTRA) names.push('extra')
  if (flags & FNAME) names.push('name')
  if (flags & FCOMMENT) names.push('comment')
  if (flags & 0xE0) names.push('reserved bits set')
  return `0x${flags.toString(16).toUpperCase().padStart(2, '0')}${names.length ? ` (${names.join(', ')})` : ''}`
}

function parseGzip(bytes) {
  const r = new ByteReader(bytes, true)
  const warnings = []
  const regions = []
  const members = []
  let pos = 0
  let budget = SCAN_LIMIT
  let scannedAll = true

  while (pos < bytes.length && members.length < MAX_MEMBERS && isMember(bytes, pos)) {
    const header = readHeader(r, pos)
    if (!header) {
      warnings.push(`gzip header at offset ${pos} is truncated`)
      members.push({ header: null, start: pos, end: bytes.length })
      pos = bytes.length
      break
    }
    const walk = walkDeflate(bytes, header.end, budget)
    const member = { header, start: pos, dataStart: header.end, size: walk.size, blocks: walk.blocks, status: walk.status }
    members.push(member)
    // Only the first members get a tree, so the others' header fields are let go
    if (members.length > MAX_MEMBER_FIELDS) {
      refundRows(header.children.length)
      header.children = []
    }
    if (walk.status === 'limit') {
      // Not scanned to the end: assume the trailer is the last 8 bytes
      scannedAll = false
      member.dataEnd = Math.max(header.end, bytes.length - 8)
      member.size = null
      pos = bytes.length
    } else if (walk.status === 'truncated') {
      warnings.push('Compressed data is truncated; the file ends before the last deflate block')
      member.dataEnd = bytes.length
      member.end = bytes.length
      pos = bytes.length
      break
    } else if (walk.status === 'error') {
      warnings.push(`Deflate data is corrupt near offset ${walk.end} (${walk.message})`)
      member.dataEnd = Math.max(header.end, bytes.length - 8)
      member.size = null
      pos = bytes.length
    } else {
      member.dataEnd = walk.end
      budget -= walk.end - header.end
      pos = walk.end + 8
    }
    if (member.dataEnd + 8 <= bytes.length) {
      member.crc = r.u32(member.dataEnd)
      member.isize = r.u32(member.dataEnd + 4)
      member.end = member.dataEnd + 8
    } else {
      if (walk.status === 'ok') warnings.push('File ends inside the gzip trailer')
      member.end = bytes.length
      pos = bytes.length
    }
    if (member.isize !== undefined && member.size !== null && member.size !== undefined && member.size % 0x100000000 !== member.isize) {
      warnings.push(`Trailer says ${formatNumber(member.isize)} bytes uncompressed but the data expands to ${formatNumber(member.size)}`)
    }
  }
  if (members.length >= MAX_MEMBERS && pos < bytes.length) {
    warnings.push(`Stopped after ${formatNumber(MAX_MEMBERS)} members`)
  } else if (pos < bytes.length) {
    const trailing = bytes.length - pos
    let zeros = true
    for (let i = pos; i < bytes.length && zeros; i++) zeros = bytes[i] === 0
    warnings.push(zeros
      ? `${plural(trailing, 'byte')} of zero padding after the last member`
      : `${plural(trailing, 'byte')} of trailing data after the last gzip member`)
    regions.push({ name: 'Trailing data', offset: pos, length: trailing, kind: 'other' })
  }

  const memberFields = members.map((member, index) => {
    const children = []
    if (member.header) {
      children.push(field('Header', member.start, member.header.end - member.start, undefined, 'Fixed 10 bytes plus optional parts', 'header', member.header.children))
      if (member.dataEnd > member.dataStart) {
        const sizeNote = member.size === null || member.size === undefined ? '' : `, expands to ${formatBytes(member.size)}`
        children.push(field('Deflate data', member.dataStart, member.dataEnd - member.dataStart,
          member.blocks ? `${plural(member.blocks, 'block')}${sizeNote}` : undefined, 'Compressed stream (RFC 1951)', 'data'))
      }
      if (member.crc !== undefined) {
        children.push(field('Trailer', member.dataEnd, 8, undefined, 'Checks for the uncompressed data', 'header', [
          field('CRC-32', member.dataEnd, 4, hex32(member.crc), 'Of the uncompressed data', 'checksum'),
          field('Size', member.dataEnd + 4, 4, formatNumber(member.isize), 'Uncompressed size modulo 2^32', 'size')
        ]))
      }
    }
    return { field: field(`Member ${index + 1}`, member.start, member.end - member.start, undefined, 'One gzip member', 'header', children), children }
  })
  const fields = members.length === 1 ? memberFields[0].children : capFields(memberFields.map(m => m.field), MAX_MEMBER_FIELDS, 'more members')

  for (const member of members) {
    if (!member.header) continue
    regions.push({ name: 'Header', offset: member.start, length: member.header.end - member.start, kind: 'header' })
    if (member.dataEnd > member.dataStart) regions.push({ name: 'Compressed data', offset: member.dataStart, length: member.dataEnd - member.dataStart, kind: 'data' })
    if (member.crc !== undefined) regions.push({ name: 'Trailer', offset: member.dataEnd, length: 8, kind: 'metadata' })
    if (regions.length > 3000) break
  }

  const summary = []
  const first = members[0] && members[0].header ? members[0].header.info : null
  summary.push(item('Compression', 'Deflate'))
  if (first) {
    if (first.name !== null) summary.push(item('Original Name', printable(first.name)))
    summary.push(item('Modified', first.mtime ? unixDate(first.mtime) : 'Not set'))
    summary.push(item('Operating System', OPERATING_SYSTEMS[first.os] || `Unknown (${first.os})`))
    if (first.xfl === 2 || first.xfl === 4) summary.push(item('Compression Level', first.xfl === 2 ? 'Maximum' : 'Fastest'))
    if (first.comment) summary.push(item('Comment', printable(first.comment)))
    if (first.extra.length) summary.push(item('Extra Field', first.extra.includes('BC') ? 'BGZF (blocked gzip)' : first.extra.join(', ')))
    if (first.headerCrc !== null) summary.push(item('Header CRC', first.headerCrcOk ? 'Present, valid' : 'Present, mismatch'))
    if (first.headerCrcOk === false) warnings.push('Header CRC16 does not match the header')
  }
  const complete = members.filter(member => member.crc !== undefined)
  summary.push(item('Members', scannedAll ? formatNumber(members.length) : `${formatNumber(members.length)}+ (stopped scanning after ${formatBytes(SCAN_LIMIT)})`))
  const known = members.every(member => member.size !== null && member.size !== undefined)
  const total = known ? members.reduce((sum, member) => sum + member.size, 0) : complete.reduce((sum, member) => sum + member.isize, 0)
  if (complete.length > 0 || known) {
    summary.push(item('Uncompressed Size', `${formatBytes(total)} (${formatNumber(total)} bytes)`,
      known ? ['Counted by walking the deflate data'] : ['From the trailer, which stores the size modulo 4 GB']))
    if (total > 0) summary.push(item('Compression Ratio', `${((bytes.length / total) * 100).toFixed(1)}%`))
  }
  if (members.length === 1 && complete.length === 1) summary.push(item('CRC-32', hex32(complete[0].crc)))
  if (first && first.name && /\.tar$/i.test(first.name)) summary.push(item('Contents', 'Probably a tar archive (from the original name)'))

  return { summary, fields, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'gzip',
  name: 'gzip Compressed Data',
  category: 'compressed',
  detect: bytes => bytes.length >= 10 && isMember(bytes, 0) && (bytes[3] & 0xE0) === 0,
  parse: fitted(parseGzip)
}
