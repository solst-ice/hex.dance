import { ByteReader, field, fitted, formatNumber, hex32, plural, printable, utf16, utf8 } from './reader.js'
import { item } from './shared.js'

const MAGIC = 'SQLite format 3\0'
const MAX_SCHEMA_ROWS = 2000
const MAX_INTERIOR_CHILDREN = 512

const APPLICATIONS = { 0x0F055112: 'Fossil repository', 0x0F055113: 'Fossil checkout', 0x0F055111: 'Fossil global config', 0x47504B47: 'GeoPackage', 0x47503130: 'GeoPackage 1.0', 0x47503131: 'GeoPackage 1.1', 0x4D504258: 'MBTiles' }
const ENCODINGS = { 1: 'UTF-8', 2: 'UTF-16le', 3: 'UTF-16be' }

function readVarint(bytes, pos, end) {
  let value = 0
  for (let i = 0; i < 9; i++) {
    if (pos + i >= end) return null
    const byte = bytes[pos + i]
    if (i === 8) return { value: value * 256 + byte, next: pos + 9 }
    value = value * 128 + (byte & 0x7F)
    if (!(byte & 0x80)) return { value, next: pos + i + 1 }
  }
  return null
}

// Reads the first columns of a sqlite_schema row: type, name, tbl_name, rootpage, sql
function readSchemaRecord(bytes, start, end, encoding) {
  const header = readVarint(bytes, start, end)
  if (!header) return null
  const headerEnd = start + header.value
  if (headerEnd > end) return null
  const types = []
  let pos = header.next
  while (pos < headerEnd && types.length < 5) {
    const type = readVarint(bytes, pos, headerEnd)
    if (!type) return null
    types.push(type.value)
    pos = type.next
  }
  const values = []
  let body = headerEnd
  for (const type of types) {
    let length = 0
    if (type >= 12) length = type % 2 === 0 ? (type - 12) / 2 : (type - 13) / 2
    else length = [0, 1, 2, 3, 4, 6, 8, 8, 0, 0, 0, 0][type] || 0
    const available = Math.max(0, Math.min(length, end - body))
    if (type >= 13 && type % 2 === 1) {
      values.push(encoding === 1 ? utf8(bytes, body, Math.min(available, 512)) : utf16(bytes, body, Math.min(available, 1024), encoding === 2))
    } else if (type >= 1 && type <= 6) {
      let value = 0
      for (let i = 0; i < length && body + i < end; i++) value = value * 256 + bytes[body + i]
      values.push(value)
    } else {
      values.push(type === 8 ? 0 : type === 9 ? 1 : null)
    }
    body += length
  }
  return values
}

function parseSQLite(bytes) {
  const r = new ByteReader(bytes, false)
  const warnings = []
  const summary = []
  const regions = []
  const headerFields = [field('Magic', 0, 16, 'SQLite format 3\\0', 'Database signature', 'magic')]
  if (!r.has(0, 100)) {
    warnings.push('File is truncated inside the 100-byte header')
    return { summary, fields: [field('Header', 0, bytes.length, undefined, 'Database header', 'header', headerFields)], warnings }
  }
  const rawPageSize = r.u16(16)
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize
  const writeVersion = r.u8(18)
  const readVersion = r.u8(19)
  const reserved = r.u8(20)
  const changeCounter = r.u32(24)
  const pageCount = r.u32(28)
  const freelistTrunk = r.u32(32)
  const freelistCount = r.u32(36)
  const schemaCookie = r.u32(40)
  const schemaFormat = r.u32(44)
  const cacheSize = r.i32(48)
  const autovacuum = r.u32(52)
  const encoding = r.u32(56)
  const userVersion = r.u32(60)
  const incremental = r.u32(64)
  const applicationId = r.u32(68)
  const validFor = r.u32(92)
  const sqliteVersion = r.u32(96)
  const versionText = sqliteVersion ? `${Math.floor(sqliteVersion / 1000000)}.${Math.floor(sqliteVersion / 1000) % 1000}.${sqliteVersion % 1000}` : 'unknown'
  const journal = v => (v === 1 ? 'legacy (rollback journal)' : v === 2 ? 'WAL' : `unknown (${v})`)
  headerFields.push(
    field('Page size', 16, 2, `${formatNumber(pageSize)} bytes`, '1 means 65536', 'size'),
    field('Write version', 18, 1, journal(writeVersion), 'File format write version', 'flags'),
    field('Read version', 19, 1, journal(readVersion), 'File format read version', 'flags'),
    field('Reserved space', 20, 1, reserved, 'Bytes reserved at the end of each page (e.g. for encryption)', 'size'),
    field('Max embedded payload fraction', 21, 1, r.u8(21), 'Must be 64'),
    field('Min embedded payload fraction', 22, 1, r.u8(22), 'Must be 32'),
    field('Leaf payload fraction', 23, 1, r.u8(23), 'Must be 32'),
    field('File change counter', 24, 4, formatNumber(changeCounter), 'Incremented on every committed change', 'count'),
    field('Database size', 28, 4, plural(pageCount, 'page'), 'In pages; valid when the version-valid-for number matches', 'count'),
    field('First freelist trunk page', 32, 4, freelistTrunk || 'none', 'Start of the free-page list', 'offset'),
    field('Freelist pages', 36, 4, formatNumber(freelistCount), 'Unused pages', 'count'),
    field('Schema cookie', 40, 4, schemaCookie, 'Incremented when the schema changes', 'count'),
    field('Schema format', 44, 4, schemaFormat, '1 to 4', 'flags'),
    field('Default cache size', 48, 4, cacheSize, 'Suggested page cache size'),
    field('Largest root page', 52, 4, autovacuum || '0 (no auto-vacuum)', 'Non-zero in auto-vacuum mode'),
    field('Text encoding', 56, 4, ENCODINGS[encoding] || `unknown (${encoding})`, 'Encoding of all text'),
    field('User version', 60, 4, userVersion, 'Set by PRAGMA user_version'),
    field('Incremental vacuum', 64, 4, incremental ? 'on' : 'off', 'Incremental auto-vacuum mode', 'flags'),
    field('Application ID', 68, 4, applicationId ? `${hex32(applicationId)}${APPLICATIONS[applicationId] ? ` (${APPLICATIONS[applicationId]})` : ''}` : '0', 'Set by PRAGMA application_id'),
    field('Reserved', 72, 20, undefined, 'Must be zero', 'padding'),
    field('Version-valid-for', 92, 4, formatNumber(validFor), 'Change counter when the version below was stored', 'count'),
    field('SQLite version', 96, 4, versionText, 'Library that last wrote the file')
  )
  const fields = [field('Database header', 0, 100, undefined, 'First 100 bytes of page 1', 'header', headerFields)]
  regions.push({ name: 'Database header', offset: 0, length: 100, kind: 'header' })

  const validPageSize = pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0
  if (!validPageSize) warnings.push(`Invalid page size ${pageSize}`)
  const actualPages = validPageSize ? Math.floor(bytes.length / pageSize) : 0
  const sizeValid = validFor === changeCounter && pageCount > 0
  if (validPageSize && bytes.length % pageSize !== 0) warnings.push(`File size is not a multiple of the page size (${formatNumber(bytes.length % pageSize)} extra bytes)`)
  if (sizeValid && pageCount !== actualPages) warnings.push(`Header says ${plural(pageCount, 'page')} but the file holds ${formatNumber(actualPages)}`)

  // Schema: page 1 holds the sqlite_schema table's root
  const schema = []
  if (validPageSize && r.has(100, 8)) {
    const btree = readSchemaPage(r, 1, pageSize, reserved, encoding, schema, fields)
    if (btree) regions.push({ name: 'Page 1 (schema)', offset: 100, length: Math.min(pageSize, bytes.length) - 100, kind: 'table' })
    if (pageSize < bytes.length) regions.push({ name: 'Pages', offset: pageSize, length: bytes.length - pageSize, kind: 'data' })
  }

  summary.push(item('SQLite Version', versionText))
  summary.push(item('Page Size', `${formatNumber(pageSize)} bytes`))
  summary.push(item('Pages', sizeValid ? formatNumber(pageCount) : `${formatNumber(actualPages)} (from the file size)`))
  summary.push(item('Text Encoding', ENCODINGS[encoding] || `Unknown (${encoding})`))
  summary.push(item('Journal Mode', writeVersion === 2 ? 'WAL' : 'Rollback journal'))
  summary.push(item('Free Pages', formatNumber(freelistCount)))
  if (autovacuum) summary.push(item('Auto-vacuum', incremental ? 'Incremental' : 'Full'))
  summary.push(item('Schema Format', schemaFormat))
  summary.push(item('File Change Counter', formatNumber(changeCounter)))
  if (userVersion) summary.push(item('User Version', userVersion))
  if (applicationId) summary.push(item('Application', APPLICATIONS[applicationId] || hex32(applicationId)))
  if (reserved) summary.push(item('Reserved Bytes per Page', reserved, ['Often used by encryption extensions']))
  const kinds = {}
  for (const row of schema) kinds[row.type] = (kinds[row.type] || 0) + 1
  if (schema.length) {
    summary.push(item('Schema Objects', Object.entries(kinds).map(([type, count]) => plural(count, type)).join(', ')))
    schema.filter(row => row.type === 'table').slice(0, 200).forEach(row => summary.push(item(row.name, `table, root page ${row.rootpage}`, row.sql ? [row.sql] : null, 'Tables')))
    const others = schema.filter(row => row.type !== 'table').slice(0, 200)
    others.forEach(row => summary.push(item(row.name, `${row.type} on ${row.table}`, row.sql ? [row.sql] : null, 'Indexes, views and triggers')))
  }
  const symbols = schema.slice(0, MAX_SCHEMA_ROWS).map(row => ({ name: row.name, type: row.type === 'table' ? 'D' : row.type === 'index' ? 'd' : 'T', note: `${row.type}${row.type !== 'table' ? ` on ${row.table}` : ''}, root page ${row.rootpage}` }))
  return { formatName: 'SQLite Database', summary, fields, regions, symbols, warnings }
}

// Reads sqlite_schema rows from page 1 and, if it is an interior page, one level of children
function readSchemaPage(r, pageNumber, pageSize, reserved, encoding, schema, fields, depth = 0) {
  const pageStart = (pageNumber - 1) * pageSize
  const headerStart = pageNumber === 1 ? 100 : pageStart
  const usableEnd = Math.min(pageStart + pageSize - reserved, r.length)
  if (!r.has(headerStart, 8)) return false
  const type = r.u8(headerStart)
  const cellCount = r.u16(headerStart + 3)
  const interior = type === 0x05
  if (type !== 0x0D && type !== 0x05) return false
  const headerLength = interior ? 12 : 8
  if (depth === 0) {
    const typeName = interior ? 'interior table b-tree' : 'leaf table b-tree'
    fields.push(field('Schema page header', headerStart, headerLength, typeName, 'B-tree page header of sqlite_schema', 'header', [
      field('Page type', headerStart, 1, `0x${type.toString(16).toUpperCase()} (${typeName})`, '0x0D leaf, 0x05 interior', 'flags'),
      field('First freeblock', headerStart + 1, 2, r.u16(headerStart + 1), 'Offset of the first free block, 0 if none', 'offset'),
      field('Cell count', headerStart + 3, 2, cellCount, 'Rows (leaf) or child pointers (interior)', 'count'),
      field('Cell content start', headerStart + 5, 2, r.u16(headerStart + 5) || 65536, 'Where cell content begins', 'offset'),
      field('Fragmented bytes', headerStart + 7, 1, r.u8(headerStart + 7), 'Free bytes in fragments', 'count'),
      ...(interior ? [field('Right-most pointer', headerStart + 8, 4, r.u32(headerStart + 8), 'Child page for the largest keys', 'offset')] : [])
    ]))
    if (r.has(headerStart + headerLength, cellCount * 2)) {
      fields.push(field('Cell pointers', headerStart + headerLength, cellCount * 2, plural(cellCount, 'cell'), 'Offsets of each cell within the page', 'table'))
    }
  }
  const pointers = headerStart + headerLength
  const children = []
  for (let i = 0; i < cellCount && schema.length < MAX_SCHEMA_ROWS; i++) {
    if (!r.has(pointers + i * 2, 2)) break
    const cell = pageStart + r.u16(pointers + i * 2)
    if (cell >= usableEnd) continue
    if (interior) {
      if (children.length < MAX_INTERIOR_CHILDREN) children.push(r.u32(cell))
      continue
    }
    const payload = readVarint(r.bytes, cell, usableEnd)
    if (!payload) continue
    const rowid = readVarint(r.bytes, payload.next, usableEnd)
    if (!rowid) continue
    const values = readSchemaRecord(r.bytes, rowid.next, Math.min(usableEnd, rowid.next + payload.value), encoding)
    if (!values || typeof values[0] !== 'string') continue
    schema.push({ type: printable(values[0], 20), name: printable(String(values[1] ?? ''), 120), table: printable(String(values[2] ?? ''), 120), rootpage: values[3], sql: typeof values[4] === 'string' ? printable(values[4], 300) : '' })
  }
  if (interior && depth === 0) {
    children.push(r.u32(headerStart + 8))
    for (const child of children) {
      if (child > 1 && child <= Math.floor(r.length / pageSize)) readSchemaPage(r, child, pageSize, reserved, encoding, schema, fields, 1)
    }
  }
  return true
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'sqlite',
  name: 'SQLite Database',
  category: 'database',
  detect: bytes => bytes.length >= 16 && MAGIC.split('').every((c, i) => bytes[i] === c.charCodeAt(0)),
  parse: fitted(parseSQLite)
}
