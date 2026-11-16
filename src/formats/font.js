import { ByteReader, capFields, field, fitted, formatDate, formatNumber, fourcc, latin1, nonOverlapping, plural, printable, utf16 } from './reader.js'
import { formatBytes, item } from './shared.js'

const MAX_TABLES = 512
const MAX_FONTS = 64
const MAC_EPOCH = 2082844800

const TABLES = {
  head: 'Font header', hhea: 'Horizontal header', hmtx: 'Horizontal metrics', maxp: 'Maximum profile', name: 'Naming table', 'OS/2': 'OS/2 and Windows metrics',
  post: 'PostScript information', cmap: 'Character to glyph mapping', glyf: 'Glyph outlines (TrueType)', loca: 'Glyph locations', 'CFF ': 'Glyph outlines (CFF)',
  CFF2: 'Glyph outlines (CFF2)', kern: 'Kerning', GPOS: 'Glyph positioning', GSUB: 'Glyph substitution', GDEF: 'Glyph definitions', fpgm: 'Font program',
  prep: 'Control value program', 'cvt ': 'Control values', gasp: 'Grid-fitting and scan conversion', DSIG: 'Digital signature', fvar: 'Font variations',
  gvar: 'Glyph variations', avar: 'Axis variations', STAT: 'Style attributes', COLR: 'Colour glyphs', CPAL: 'Colour palettes', SVG: 'SVG glyphs',
  sbix: 'Bitmap glyphs (Apple)', CBDT: 'Colour bitmap data', CBLC: 'Colour bitmap locations', vhea: 'Vertical header', vmtx: 'Vertical metrics', VORG: 'Vertical origins',
  hdmx: 'Device metrics', LTSH: 'Linear threshold', VDMX: 'Vertical device metrics', meta: 'Metadata', MATH: 'Math layout', BASE: 'Baseline data', JSTF: 'Justification',
  HVAR: 'Horizontal metric variations', MVAR: 'Metric variations', bsln: 'Baseline (Apple)', morx: 'Glyph metamorphosis (Apple)', kerx: 'Extended kerning (Apple)', feat: 'Features (Apple)'
}
const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill']
const NAME_IDS = { 0: 'Copyright', 1: 'Family', 2: 'Subfamily', 3: 'Unique ID', 4: 'Full Name', 5: 'Version', 6: 'PostScript Name', 7: 'Trademark', 8: 'Manufacturer', 9: 'Designer', 11: 'Vendor URL', 13: 'License', 16: 'Typographic Family' }
const WEIGHTS = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' }
const FLAVORS = { 0x00010000: 'TrueType', 0x4F54544F: 'OpenType (CFF)', 0x74727565: 'TrueType (Apple)', 0x74797031: 'PostScript Type 1 (sfnt)' }

function flavorName(value) {
  return FLAVORS[value] || `unknown (0x${value.toString(16)})`
}

function checksum(r, offset, length) {
  let sum = 0
  const end = Math.min(offset + length, r.length)
  for (let p = offset; p < end; p += 4) {
    const word = p + 4 <= end ? r.u32(p) : ((r.u8(p) << 24) | (r.u8(p + 1) << 16) | (r.u8(p + 2) << 8) | r.u8(p + 3)) >>> 0
    sum = (sum + word) >>> 0
  }
  return sum
}

// Reads names, metrics and dates from uncompressed sfnt tables
function readTables(r, tables, info) {
  const get = tag => tables.find(table => table.tag === tag && r.has(table.offset, table.length))
  const head = get('head')
  if (head && head.length >= 54) {
    info.unitsPerEm = r.u16(head.offset + 18)
    info.created = r.u64(head.offset + 20)
    info.modified = r.u64(head.offset + 28)
    info.revision = r.u32(head.offset + 4) / 65536
  }
  const maxp = get('maxp')
  if (maxp && maxp.length >= 6) info.glyphs = r.u16(maxp.offset + 4)
  const os2 = get('OS/2')
  if (os2 && os2.length >= 10) {
    info.weight = r.u16(os2.offset + 4)
    info.width = r.u16(os2.offset + 6)
    if (os2.length >= 12) info.embedding = r.u16(os2.offset + 8)
  }
  const name = get('name')
  if (name && name.length >= 6) {
    const count = Math.min(r.u16(name.offset + 2), 1000)
    const storage = name.offset + r.u16(name.offset + 4)
    const names = {}
    for (let i = 0; i < count; i++) {
      const at = name.offset + 6 + i * 12
      if (at + 12 > name.offset + name.length) break
      const platform = r.u16(at)
      const encoding = r.u16(at + 2)
      const language = r.u16(at + 4)
      const id = r.u16(at + 6)
      const length = r.u16(at + 8)
      const start = storage + r.u16(at + 10)
      if (!NAME_IDS[id] || !r.has(start, length)) continue
      // Prefer Windows Unicode English names, then Mac Roman ones
      const rank = platform === 3 && (language === 0x409) ? 3 : platform === 3 || platform === 0 ? 2 : platform === 1 && language === 0 ? 1 : 0
      if (names[id] && names[id].rank >= rank) continue
      const text = platform === 3 || platform === 0 ? utf16(r.bytes, start, Math.min(length, 2048), false) : platform === 1 && encoding === 0 ? latin1(r.bytes, start, Math.min(length, 1024)) : ''
      if (text) names[id] = { rank, text: printable(text.trim(), 200) }
    }
    info.names = names
  }
}

function parseSfnt(r, base, label, info, warnings) {
  const flavor = r.u32(base)
  const numTables = r.u16(base + 4)
  const children = [
    field('sfnt version', base, 4, flavorName(flavor), 'Outline format', 'magic'),
    field('Table count', base + 4, 2, numTables, 'Entries in the table directory', 'count'),
    field('Search range', base + 6, 2, r.u16(base + 6), '16 × largest power of two ≤ table count'),
    field('Entry selector', base + 8, 2, r.u16(base + 8), 'log2 of that power of two'),
    field('Range shift', base + 10, 2, r.u16(base + 10), 'Table count × 16 − search range')
  ]
  const tables = []
  const records = []
  const count = Math.min(numTables, MAX_TABLES)
  for (let i = 0; i < count; i++) {
    const at = base + 12 + i * 16
    if (!r.has(at, 16)) {
      warnings.add(`${label}table directory is truncated`)
      break
    }
    const tag = fourcc(r.bytes, at)
    const sum = r.u32(at + 4)
    const offset = r.u32(at + 8)
    const length = r.u32(at + 12)
    tables.push({ tag, offset, length, checksum: sum })
    if (offset + length > r.length) warnings.add(`${label}table "${printable(tag)}" runs past the end of the file`)
    const valid = tag === 'head' || !r.has(offset, length) ? null : checksum(r, offset, length) === sum
    if (valid === false) info.badChecksums.push(tag)
    records.push(field(printable(tag), at, 16, `${formatBytes(length)} at offset ${formatNumber(offset)}${valid === false ? ', checksum mismatch' : ''}`, TABLES[tag.trim()] || TABLES[tag] || 'Table record', 'header'))
  }
  if (records.length) children.push(field('Table records', base + 12, records.length * 16, plural(records.length, 'table'), 'Tag, checksum, offset and length per table', 'table', capFields(records, 100, 'more tables')))
  readTables(r, tables, info)
  return { flavor, tables, header: field(`${label}Offset table`, base, 12 + records.length * 16, flavorName(flavor), 'sfnt header and table directory', 'header', children) }
}

function tableFields(tables, size) {
  return tables
    .filter(table => table.offset < size && table.length > 0)
    .map(table => field(`${printable(table.tag)} table`, table.offset, Math.min(table.length, size - table.offset), formatBytes(table.length), TABLES[table.tag] || 'Font table', 'data'))
}

function readBase128(bytes, pos, end) {
  let value = 0
  for (let i = 0; i < 5; i++) {
    if (pos + i >= end) return null
    const byte = bytes[pos + i]
    if (i === 0 && byte === 0x80) return null
    value = value * 128 + (byte & 0x7F)
    if (!(byte & 0x80)) return { value, next: pos + i + 1 }
  }
  return null
}

function parseFont(bytes) {
  const r = new ByteReader(bytes, false)
  const warnings = new Set()
  const regions = []
  const summary = []
  const fields = []
  const info = { badChecksums: [] }
  const magic = latin1(bytes, 0, 4)
  let formatName = 'TrueType Font'
  let tables = []
  let flavor = r.u32(0)

  if (magic === 'wOFF') {
    formatName = 'WOFF Font'
    flavor = r.u32(4)
    const numTables = r.u16(12)
    const headerFields = [
      field('Signature', 0, 4, 'wOFF', 'WOFF 1.0 signature', 'magic'), field('Flavor', 4, 4, flavorName(flavor), 'Outline format of the wrapped font', 'magic'),
      field('Length', 8, 4, formatNumber(r.u32(8)), 'Whole WOFF file', 'size'), field('Table count', 12, 2, numTables, 'Tables in the font', 'count'),
      field('Reserved', 14, 2, r.u16(14), 'Zero', 'padding'), field('sfnt size', 16, 4, formatNumber(r.u32(16)), 'Size once decompressed', 'size'),
      field('Version', 20, 4, `${r.u16(20)}.${r.u16(22)}`, 'Font version'), field('Metadata offset', 24, 4, formatNumber(r.u32(24)), 'Optional XML metadata', 'offset'),
      field('Metadata length', 28, 4, formatNumber(r.u32(28)), 'Compressed', 'size'), field('Metadata original length', 32, 4, formatNumber(r.u32(32)), 'Uncompressed', 'size'),
      field('Private data offset', 36, 4, formatNumber(r.u32(36)), 'Optional vendor data', 'offset'), field('Private data length', 40, 4, formatNumber(r.u32(40)), 'Bytes', 'size')
    ]
    fields.push(field('WOFF header', 0, Math.min(44, bytes.length), undefined, 'WOFF 1.0 header', 'header', headerFields))
    const records = []
    for (let i = 0; i < Math.min(numTables, MAX_TABLES); i++) {
      const at = 44 + i * 20
      if (!r.has(at, 20)) {
        warnings.add('Table directory is truncated')
        break
      }
      const table = { tag: fourcc(bytes, at), offset: r.u32(at + 4), length: r.u32(at + 8), original: r.u32(at + 12) }
      tables.push(table)
      records.push(field(printable(table.tag), at, 20, `${formatBytes(table.length)} → ${formatBytes(table.original)}${table.length < table.original ? ' (zlib)' : ''}`, TABLES[table.tag] || 'Table record', 'header'))
    }
    if (records.length) fields.push(field('Table directory', 44, records.length * 20, plural(records.length, 'table'), 'Per table: tag, offset, compressed and original length, checksum', 'table', capFields(records, 100, 'more tables')))
    // Uncompressed tables can still be read
    readTables(r, tables.filter(table => table.length === table.original), info)
    fields.push(...nonOverlapping(tableFields(tables, bytes.length)).filter(f => f.offset >= 44 + records.length * 20))
    summary.push(item('Compressed Size', `${formatBytes(bytes.length)} (${formatBytes(r.u32(16))} uncompressed)`))
  } else if (magic === 'wOF2') {
    formatName = 'WOFF2 Font'
    flavor = r.u32(4)
    const numTables = r.u16(12)
    const compressed = r.u32(20)
    fields.push(field('WOFF2 header', 0, Math.min(48, bytes.length), undefined, 'WOFF 2.0 header', 'header', [
      field('Signature', 0, 4, 'wOF2', 'WOFF 2.0 signature', 'magic'), field('Flavor', 4, 4, flavorName(flavor), 'Outline format of the wrapped font', 'magic'),
      field('Length', 8, 4, formatNumber(r.u32(8)), 'Whole WOFF2 file', 'size'), field('Table count', 12, 2, numTables, 'Tables in the font', 'count'),
      field('Reserved', 14, 2, r.u16(14), 'Zero', 'padding'), field('sfnt size', 16, 4, formatNumber(r.u32(16)), 'Size once decoded', 'size'),
      field('Compressed size', 20, 4, formatNumber(compressed), 'Brotli stream holding every table', 'size'), field('Version', 24, 4, `${r.u16(24)}.${r.u16(26)}`, 'Font version'),
      field('Metadata and private data', 28, 20, undefined, 'Offsets and lengths of optional blocks', 'offset')
    ]))
    let pos = 48
    const records = []
    for (let i = 0; i < Math.min(numTables, MAX_TABLES); i++) {
      const start = pos
      if (pos >= bytes.length) break
      const flags = bytes[pos++]
      const index = flags & 0x3F
      let tag = WOFF2_TAGS[index]
      if (index === 63) {
        tag = fourcc(bytes, pos)
        pos += 4
      }
      const version = flags >> 6
      const original = readBase128(bytes, pos, bytes.length)
      if (!original) {
        warnings.add('Table directory is truncated or malformed')
        break
      }
      pos = original.next
      const transformed = (tag === 'glyf' || tag === 'loca') ? version === 0 : version !== 0
      let transformLength = null
      if (transformed) {
        const value = readBase128(bytes, pos, bytes.length)
        if (!value) {
          warnings.add('Table directory is truncated or malformed')
          break
        }
        transformLength = value.value
        pos = value.next
      }
      tables.push({ tag: tag || '????', offset: 0, length: 0, original: original.value })
      records.push(field(printable(tag || `#${index}`), start, pos - start, `${formatBytes(original.value)}${transformed ? `, transformed to ${formatBytes(transformLength)}` : ''}`, TABLES[tag] || 'Table entry', 'header'))
    }
    if (records.length) fields.push(field('Table directory', 48, pos - 48, plural(records.length, 'table'), 'Variable-length entries: flags, tag, lengths', 'table', capFields(records, 100, 'more tables')))
    if (flavor === 0x74746366) warnings.add('Font collections in WOFF2 are listed as a single table directory')
    if (pos < bytes.length) {
      const length = Math.min(compressed, bytes.length - pos)
      fields.push(field('Compressed font data', pos, length, formatBytes(compressed), 'Brotli-compressed tables (names and metrics are inside)', 'data'))
      regions.push({ name: 'Compressed font data', offset: pos, length, kind: 'data' })
    }
    summary.push(item('Compressed Size', `${formatBytes(compressed)} Brotli (${formatBytes(r.u32(16))} decoded)`))
  } else if (magic === 'ttcf') {
    formatName = 'TrueType Font Collection'
    const count = r.u32(8)
    const offsets = []
    for (let i = 0; i < Math.min(count, MAX_FONTS); i++) if (r.has(12 + i * 4, 4)) offsets.push(r.u32(12 + i * 4))
    fields.push(field('Collection header', 0, 12 + offsets.length * 4, plural(count, 'font'), 'TTC header', 'header', [
      field('Tag', 0, 4, 'ttcf', 'Font collection signature', 'magic'), field('Version', 4, 4, `${r.u16(4)}.${r.u16(6)}`, 'Collection version'),
      field('Font count', 8, 4, count, 'Fonts in the collection', 'count'), field('Offsets', 12, offsets.length * 4, offsets.join(', '), 'Offset table of each font', 'offset')
    ]))
    const names = []
    const directories = []
    offsets.forEach((offset, index) => {
      const fontInfo = { badChecksums: [] }
      if (!r.has(offset, 12)) return
      const font = parseSfnt(r, offset, `Font ${index + 1} `, fontInfo, warnings)
      directories.push(font.header)
      tables.push(...font.tables)
      if (fontInfo.names && fontInfo.names[4]) names.push(fontInfo.names[4].text)
      if (index === 0) Object.assign(info, fontInfo)
    })
    fields.push(...nonOverlapping([...directories, ...tableFields(tables, bytes.length)]).filter(f => f.offset >= 12 + offsets.length * 4))
    summary.push(item('Fonts', formatNumber(count), names.slice(0, 20)))
  } else {
    const font = parseSfnt(r, 0, '', info, warnings)
    tables = font.tables
    if (flavor === 0x4F54544F) formatName = 'OpenType Font'
    fields.push(font.header)
    fields.push(...nonOverlapping(tableFields(tables, bytes.length)).filter(f => f.offset >= font.header.offset + font.header.length))
  }

  for (const f of fields) if (f.name.endsWith(' table')) regions.push({ name: f.name, offset: f.offset, length: f.length, kind: 'table' })
  regions.push({ name: 'Header', offset: 0, length: Math.min(12, bytes.length), kind: 'header' })

  const names = info.names || {}
  if (names[4]) summary.push(item('Full Name', names[4].text))
  if (names[1]) summary.push(item('Family', names[16] ? names[16].text : names[1].text))
  if (names[2]) summary.push(item('Style', names[2].text))
  if (names[5]) summary.push(item('Version', names[5].text))
  summary.push(item('Outlines', flavor === 0x4F54544F || tables.some(t => t.tag === 'CFF ' || t.tag === 'CFF2') ? 'CFF (PostScript)' : 'TrueType (quadratic)'))
  if (info.glyphs !== undefined) summary.push(item('Glyphs', formatNumber(info.glyphs)))
  if (info.unitsPerEm) summary.push(item('Units per Em', info.unitsPerEm))
  if (info.weight) summary.push(item('Weight', `${info.weight}${WEIGHTS[info.weight] ? ` (${WEIGHTS[info.weight]})` : ''}`))
  if (tables.some(t => t.tag === 'fvar')) summary.push(item('Variable Font', 'Yes'))
  if (tables.some(t => ['COLR', 'CBDT', 'sbix', 'SVG '].includes(t.tag))) summary.push(item('Colour Glyphs', tables.filter(t => ['COLR', 'CBDT', 'sbix', 'SVG '].includes(t.tag)).map(t => t.tag.trim()).join(', ')))
  if (info.created) summary.push(item('Created', formatDate(new Date((info.created - MAC_EPOCH) * 1000))))
  if (info.modified) summary.push(item('Modified', formatDate(new Date((info.modified - MAC_EPOCH) * 1000))))
  if (info.embedding !== undefined) summary.push(item('Embedding', info.embedding === 0 ? 'Installable' : info.embedding & 2 ? 'Restricted' : info.embedding & 8 ? 'Editable' : info.embedding & 4 ? 'Preview and print' : `0x${info.embedding.toString(16)}`))
  summary.push(item('Tables', formatNumber(tables.length), [tables.map(t => printable(t.tag.trim())).slice(0, 80).join(', ')]))
  for (const [id, label] of [[0, 'Copyright'], [8, 'Manufacturer'], [9, 'Designer'], [13, 'License']]) {
    if (names[id]) summary.push(item(label, names[id].text, null, 'Names'))
  }
  if (info.badChecksums.length) warnings.add(`Table checksum mismatch: ${info.badChecksums.map(tag => printable(tag)).join(', ')}`)
  return { formatName, summary, fields, regions, warnings: [...warnings] }
}

// 0x00010000 is a weak signature, so the binary-search fields must agree with the table count
function detectFont(bytes) {
  if (bytes.length < 12) return false
  const magic = latin1(bytes, 0, 4)
  if (magic === 'wOFF' || magic === 'wOF2') return true
  if (magic === 'ttcf') return bytes[4] === 0 && (bytes[5] === 1 || bytes[5] === 2) && bytes[6] === 0 && bytes[7] === 0
  const tag = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  if (!FLAVORS[tag]) return false
  const numTables = (bytes[4] << 8) | bytes[5]
  if (numTables === 0 || numTables > 1024) return false
  const power = 2 ** Math.floor(Math.log2(numTables))
  const searchRange = (bytes[6] << 8) | bytes[7]
  const entrySelector = (bytes[8] << 8) | bytes[9]
  return searchRange === power * 16 && entrySelector === Math.log2(power)
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'font',
  name: 'Font',
  category: 'font',
  detect: detectFont,
  parse: fitted(parseFont)
}
