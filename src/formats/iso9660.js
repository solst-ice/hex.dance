import { ByteReader, capFields, field, fitted, formatNumber, latin1, plural, printable, utf16 } from './reader.js'
import { formatBytes, item } from './shared.js'

const SECTOR = 2048
const FIRST_DESCRIPTOR = 16 * SECTOR
const MAX_DESCRIPTORS = 64
const MAX_ENTRIES = 50000
const MAX_DEPTH = 16
const MAX_DIRECTORIES = 5000

const DESCRIPTOR_TYPES = { 0: 'Boot record', 1: 'Primary volume descriptor', 2: 'Supplementary volume descriptor', 3: 'Volume partition descriptor', 255: 'Volume descriptor set terminator' }

function both32(r, offset) {
  return r.u32(offset, true)
}

function descriptorDate(text) {
  if (!/^\d{16}/.test(text) || /^0+$/.test(text.slice(0, 16))) return null
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}`
}

function recordDate(r, offset) {
  const year = 1900 + r.u8(offset)
  if (year === 1900) return null
  const pad = n => String(n).padStart(2, '0')
  return `${year}-${pad(r.u8(offset + 1))}-${pad(r.u8(offset + 2))} ${pad(r.u8(offset + 3))}:${pad(r.u8(offset + 4))}:${pad(r.u8(offset + 5))}`
}

function readRecord(r, offset, joliet) {
  const length = r.u8(offset)
  if (length < 34 || !r.has(offset, length)) return null
  const nameLength = r.u8(offset + 32)
  if (33 + nameLength > length) return null
  const flags = r.u8(offset + 25)
  let name
  if (nameLength === 1 && (r.u8(offset + 33) === 0 || r.u8(offset + 33) === 1)) name = r.u8(offset + 33) === 0 ? '.' : '..'
  else name = joliet ? utf16(r.bytes, offset + 33, nameLength, false) : latin1(r.bytes, offset + 33, nameLength)
  name = name.replace(/;\d+$/, '')
  if (!joliet && !(flags & 2)) name = name.replace(/\.$/, '')
  return { length, extent: both32(r, offset + 2), size: both32(r, offset + 10), date: recordDate(r, offset + 18), flags, isDirectory: (flags & 2) !== 0, name }
}

function parseVolumeDescriptor(r, offset, ucs2) {
  // Joliet descriptors store their text as UCS-2 big-endian
  const text = (o, n) => printable((ucs2 ? utf16(r.bytes, offset + o, n, false) : latin1(r.bytes, offset + o, n)).replace(/\0+$/, '').trim(), 128)
  return {
    system: text(8, 32), volume: text(40, 32), blocks: both32(r, offset + 80), blockSize: r.u16(offset + 128, true),
    pathTableSize: both32(r, offset + 132), volumeSet: text(190, 128), publisher: text(318, 128), preparer: text(446, 128), application: text(574, 128),
    created: descriptorDate(latin1(r.bytes, offset + 813, 17)), modified: descriptorDate(latin1(r.bytes, offset + 830, 17)), root: offset + 156
  }
}

function walkTree(r, rootOffset, blockSize, joliet, warnings) {
  const entries = []
  const root = readRecord(r, rootOffset, joliet)
  if (!root) return entries
  const queue = [{ extent: root.extent, size: root.size, path: '', depth: 0 }]
  const seen = new Set()
  let directories = 0
  while (queue.length && entries.length < MAX_ENTRIES) {
    const dir = queue.shift()
    if (seen.has(dir.extent) || ++directories > MAX_DIRECTORIES) continue
    seen.add(dir.extent)
    const start = dir.extent * blockSize
    const end = Math.min(start + dir.size, r.length)
    if (start >= r.length) {
      warnings.add('A directory lies past the end of the image (truncated?)')
      continue
    }
    let pos = start
    while (pos < end && entries.length < MAX_ENTRIES) {
      const length = r.u8(pos)
      if (length === 0) {
        // Records never cross a sector boundary; zero means skip to the next sector
        pos = (Math.floor(pos / blockSize) + 1) * blockSize
        continue
      }
      const record = readRecord(r, pos, joliet)
      if (!record) break
      pos += record.length
      if (record.name === '.' || record.name === '..') continue
      const path = dir.path ? `${dir.path}/${record.name}` : record.name
      entries.push({ path: printable(path, 4096), isDirectory: record.isDirectory, size: record.isDirectory ? 0 : record.size, compressedSize: record.isDirectory ? 0 : record.size, method: 'stored', encrypted: false })
      if (record.isDirectory && dir.depth < MAX_DEPTH) queue.push({ extent: record.extent, size: record.size, path, depth: dir.depth + 1 })
    }
  }
  if (entries.length >= MAX_ENTRIES) warnings.add(`Listed the first ${formatNumber(MAX_ENTRIES)} entries only`)
  return entries
}

function parseISO(bytes) {
  const r = new ByteReader(bytes, true)
  const warnings = new Set()
  const summary = []
  const regions = [{ name: 'System area', offset: 0, length: FIRST_DESCRIPTOR, kind: 'padding' }]
  const fields = [field('System area', 0, Math.min(FIRST_DESCRIPTOR, bytes.length), undefined, 'Sectors 0-15, unused by ISO 9660 (boot code on hybrid images)', 'padding')]
  const descriptorFields = []
  let primary = null
  let joliet = null
  let bootCatalog = null
  let pos = FIRST_DESCRIPTOR
  for (let i = 0; i < MAX_DESCRIPTORS && r.has(pos, 7); i++, pos += SECTOR) {
    if (latin1(bytes, pos + 1, 5) !== 'CD001') {
      warnings.add(`Sector ${pos / SECTOR} does not hold a volume descriptor`)
      break
    }
    const type = r.u8(pos)
    const name = DESCRIPTOR_TYPES[type] || `Descriptor type ${type}`
    const children = [field('Type', pos, 1, `${type} (${name})`, 'Descriptor type', 'magic'), field('Identifier', pos + 1, 5, 'CD001', 'ISO 9660 signature', 'magic'), field('Version', pos + 6, 1, r.u8(pos + 6), 'Always 1')]
    let value
    if ((type === 1 || type === 2) && r.has(pos, SECTOR)) {
      const escape = latin1(bytes, pos + 88, 3)
      const isJoliet = type === 2 && /^%\/[@CE]$/.test(escape)
      const vd = parseVolumeDescriptor(r, pos, isJoliet)
      if (type === 1 && !primary) primary = vd
      if (isJoliet && !joliet) joliet = vd
      value = vd.volume || '(no label)'
      children.push(
        field('System identifier', pos + 8, 32, vd.system, 'System that can use sectors 0-15', 'string'),
        field('Volume identifier', pos + 40, 32, vd.volume, 'Volume label', 'string'),
        field('Volume space size', pos + 80, 8, `${formatNumber(vd.blocks)} blocks`, 'Both-endian block count', 'size'),
        ...(type === 2 ? [field('Escape sequences', pos + 88, 32, isJoliet ? `Joliet (UCS-2 level ${'@CE'.indexOf(escape[2]) + 1})` : printable(escape), 'Character set of this descriptor')] : []),
        field('Logical block size', pos + 128, 4, vd.blockSize, 'Both-endian, usually 2048', 'size'),
        field('Path table size', pos + 132, 8, formatNumber(vd.pathTableSize), 'Bytes', 'size'),
        field('Root directory record', pos + 156, 34, undefined, 'Where the directory tree starts', 'header'),
        field('Volume set identifier', pos + 190, 128, vd.volumeSet, 'Volume set name', 'string'),
        field('Publisher identifier', pos + 318, 128, vd.publisher, 'Publisher', 'string'),
        field('Data preparer identifier', pos + 446, 128, vd.preparer, 'Who prepared the data', 'string'),
        field('Application identifier', pos + 574, 128, vd.application, 'Program that wrote the image', 'string'),
        field('Creation date', pos + 813, 17, vd.created || 'not set', 'Volume creation time'),
        field('Modification date', pos + 830, 17, vd.modified || 'not set', 'Volume modification time')
      )
    } else if (type === 0) {
      const system = printable(latin1(bytes, pos + 7, 32).replace(/\0+$/, '').trim())
      value = system
      if (system.startsWith('EL TORITO')) {
        bootCatalog = r.u32(pos + 71)
        children.push(field('Boot system identifier', pos + 7, 32, system, 'El Torito bootable CD', 'string'), field('Boot catalog', pos + 71, 4, `sector ${formatNumber(bootCatalog)}`, 'Where the boot entries are', 'offset'))
      }
    }
    descriptorFields.push(field(name, pos, Math.min(SECTOR, bytes.length - pos), value, `Volume descriptor in sector ${pos / SECTOR}`, 'header', children))
    regions.push({ name, offset: pos, length: Math.min(SECTOR, bytes.length - pos), kind: 'metadata' })
    if (type === 255) break
  }
  fields.push(...capFields(descriptorFields, 32, 'more descriptors'))

  const vd = joliet || primary
  let entries = []
  if (vd) {
    const blockSize = vd.blockSize === 2048 || vd.blockSize === 512 || vd.blockSize === 1024 ? vd.blockSize : SECTOR
    entries = walkTree(r, vd.root, blockSize, vd === joliet, warnings)
    const imageSize = vd.blocks * blockSize
    if (imageSize > bytes.length) warnings.add(`Volume is ${formatBytes(imageSize)} but the file has ${formatBytes(bytes.length)} (truncated)`)
    else if (imageSize < bytes.length) {
      regions.push({ name: 'After the volume', offset: imageSize, length: bytes.length - imageSize, kind: 'other' })
      if (bytes.length - imageSize > 512 * 1024) warnings.add(`${formatBytes(bytes.length - imageSize)} after the end of the volume`)
    }
    if (pos + SECTOR < bytes.length) regions.push({ name: 'Directories and files', offset: pos + SECTOR, length: Math.min(imageSize, bytes.length) - pos - SECTOR, kind: 'data' })
  }
  const base = primary || joliet
  if (base) {
    summary.push(item('Volume Label', (joliet && joliet.volume) || base.volume || '(none)'))
    summary.push(item('Volume Size', `${formatBytes(base.blocks * base.blockSize)} (${plural(base.blocks, 'block')} of ${base.blockSize} bytes)`))
    if (base.system) summary.push(item('System', base.system))
    if (base.publisher) summary.push(item('Publisher', base.publisher))
    if (base.preparer) summary.push(item('Prepared By', base.preparer))
    if (base.application) summary.push(item('Application', base.application))
    if (base.created) summary.push(item('Created', base.created))
    if (base.modified && base.modified !== base.created) summary.push(item('Modified', base.modified))
  } else {
    warnings.add('No primary volume descriptor found')
  }
  summary.push(item('Extensions', [joliet ? 'Joliet (Unicode names)' : null, bootCatalog !== null ? 'El Torito (bootable)' : null].filter(Boolean).join(', ') || 'None'))
  const files = entries.filter(entry => !entry.isDirectory)
  summary.push(item('Total Files', formatNumber(files.length)))
  summary.push(item('Directories', formatNumber(entries.length - files.length)))
  summary.push(item('Total Size', formatBytes(files.reduce((sum, entry) => sum + entry.size, 0))))
  if (bytes[510] === 0x55 && bytes[511] === 0xAA) summary.push(item('Hybrid Image', 'Yes (also has an MBR, bootable from USB)'))
  return { formatName: 'ISO 9660 Disc Image', summary, fields, regions, entries, warnings: [...warnings] }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'iso9660',
  name: 'ISO 9660 Disc Image',
  category: 'archive',
  detect: bytes => bytes.length >= FIRST_DESCRIPTOR + 7 && latin1(bytes, FIRST_DESCRIPTOR + 1, 5) === 'CD001' && [0, 1, 2, 3, 255].includes(bytes[FIRST_DESCRIPTOR]),
  parse: fitted(parseISO)
}
