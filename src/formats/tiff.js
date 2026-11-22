import { ByteReader, capFields, field, fitted, formatNumber, latin1, nonOverlapping, plural, printable } from './reader.js'
import { formatBytes, item } from './shared.js'
import { pointAt } from './pointers.js'

const MAX_IFDS = 128
const MAX_ENTRIES_SHOWN = 200
const MAX_VALUES = 100000
const MAX_PREVIEW_VALUES = 8

// [size, name] per TIFF field type
const TYPES = {
  1: [1, 'BYTE'], 2: [1, 'ASCII'], 3: [2, 'SHORT'], 4: [4, 'LONG'], 5: [8, 'RATIONAL'], 6: [1, 'SBYTE'], 7: [1, 'UNDEFINED'],
  8: [2, 'SSHORT'], 9: [4, 'SLONG'], 10: [8, 'SRATIONAL'], 11: [4, 'FLOAT'], 12: [8, 'DOUBLE'], 13: [4, 'IFD'],
  16: [8, 'LONG8'], 17: [8, 'SLONG8'], 18: [8, 'IFD8']
}

const TAGS = {
  254: 'NewSubfileType', 255: 'SubfileType', 256: 'ImageWidth', 257: 'ImageLength', 258: 'BitsPerSample', 259: 'Compression',
  262: 'PhotometricInterpretation', 266: 'FillOrder', 269: 'DocumentName', 270: 'ImageDescription', 271: 'Make', 272: 'Model',
  273: 'StripOffsets', 274: 'Orientation', 277: 'SamplesPerPixel', 278: 'RowsPerStrip', 279: 'StripByteCounts',
  282: 'XResolution', 283: 'YResolution', 284: 'PlanarConfiguration', 296: 'ResolutionUnit', 297: 'PageNumber', 305: 'Software',
  306: 'DateTime', 315: 'Artist', 316: 'HostComputer', 317: 'Predictor', 318: 'WhitePoint', 319: 'PrimaryChromaticities',
  320: 'ColorMap', 322: 'TileWidth', 323: 'TileLength', 324: 'TileOffsets', 325: 'TileByteCounts', 330: 'SubIFDs',
  338: 'ExtraSamples', 339: 'SampleFormat', 347: 'JPEGTables', 513: 'JPEGInterchangeFormat', 514: 'JPEGInterchangeFormatLength',
  529: 'YCbCrCoefficients', 530: 'YCbCrSubSampling', 531: 'YCbCrPositioning', 532: 'ReferenceBlackWhite', 700: 'XMP',
  33432: 'Copyright', 33434: 'ExposureTime', 33437: 'FNumber', 33723: 'IPTC', 34377: 'Photoshop', 34665: 'ExifIFD',
  34675: 'ICCProfile', 34850: 'ExposureProgram', 34853: 'GPSIFD', 34855: 'ISOSpeedRatings', 36864: 'ExifVersion',
  36867: 'DateTimeOriginal', 36868: 'DateTimeDigitized', 37121: 'ComponentsConfiguration', 37377: 'ShutterSpeedValue',
  37378: 'ApertureValue', 37380: 'ExposureBiasValue', 37383: 'MeteringMode', 37385: 'Flash', 37386: 'FocalLength',
  37500: 'MakerNote', 37510: 'UserComment', 40960: 'FlashpixVersion', 40961: 'ColorSpace', 40962: 'PixelXDimension',
  40963: 'PixelYDimension', 40965: 'InteroperabilityIFD', 41986: 'ExposureMode', 41987: 'WhiteBalance', 42016: 'ImageUniqueID',
  42033: 'BodySerialNumber', 42035: 'LensMake', 42036: 'LensModel', 50706: 'DNGVersion', 50708: 'UniqueCameraModel'
}

const GPS_TAGS = {
  0: 'GPSVersionID', 1: 'GPSLatitudeRef', 2: 'GPSLatitude', 3: 'GPSLongitudeRef', 4: 'GPSLongitude', 5: 'GPSAltitudeRef',
  6: 'GPSAltitude', 7: 'GPSTimeStamp', 12: 'GPSSpeedRef', 13: 'GPSSpeed', 16: 'GPSImgDirectionRef', 17: 'GPSImgDirection',
  18: 'GPSMapDatum', 29: 'GPSDateStamp'
}

const COMPRESSION = {
  1: 'None', 2: 'CCITT RLE', 3: 'CCITT Group 3', 4: 'CCITT Group 4', 5: 'LZW', 6: 'JPEG (old style)', 7: 'JPEG', 8: 'Deflate',
  32773: 'PackBits', 32946: 'Deflate', 34712: 'JPEG 2000', 34887: 'LERC', 34892: 'Lossy JPEG (DNG)', 50000: 'Zstandard', 50001: 'WebP', 52546: 'JPEG XL'
}

const PHOTOMETRIC = {
  0: 'WhiteIsZero', 1: 'BlackIsZero', 2: 'RGB', 3: 'Palette', 4: 'Transparency mask', 5: 'CMYK', 6: 'YCbCr', 8: 'CIE L*a*b*',
  9: 'ICC L*a*b*', 32803: 'Colour filter array (raw)', 34892: 'Linear raw', 32844: 'LogL', 32845: 'LogLuv'
}

const ORIENTATION = { 1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Flipped', 5: 'Mirrored, rotated 90° CCW', 6: 'Rotated 90° CW', 7: 'Mirrored, rotated 90° CW', 8: 'Rotated 90° CCW' }
const RESOLUTION_UNIT = { 1: '', 2: 'DPI', 3: 'dots/cm' }

// Tags whose every value matters: strip and tile locations, SubIFD pointers
const ARRAY_TAGS = new Set([273, 279, 324, 325, 330])

const POINTER_TAGS = { 34665: 'EXIF', 34853: 'GPS', 40965: 'Interoperability', 330: 'SubIFD' }

function readValue(r, type, offset) {
  switch (type) {
    case 1: case 7: case 2: return r.u8(offset)
    case 6: return (r.u8(offset) << 24) >> 24
    case 3: return r.u16(offset)
    case 8: return r.i16(offset)
    case 4: case 13: return r.u32(offset)
    case 9: return r.i32(offset)
    case 5: { const d = r.u32(offset + 4); return d ? r.u32(offset) / d : NaN }
    case 10: { const d = r.i32(offset + 4); return d ? r.i32(offset) / d : NaN }
    case 11: return r.has(offset, 4) ? r.view.getFloat32(offset, r.little) : 0
    case 12: return r.has(offset, 8) ? r.view.getFloat64(offset, r.little) : 0
    case 16: case 18: return r.u64(offset)
    case 17: return r.has(offset, 8) ? Number(r.view.getBigInt64(offset, r.little)) : 0
    default: return 0
  }
}

function formatRational(r, type, offset) {
  const n = type === 10 ? r.i32(offset) : r.u32(offset)
  const d = type === 10 ? r.i32(offset + 4) : r.u32(offset + 4)
  if (d === 0) return `${n}/0`
  const value = n / d
  return Number.isInteger(value) ? String(value) : `${n}/${d} (${+value.toFixed(4)})`
}

// Exif, GPS and interoperability directories, and sub-images
const IFD_POINTER_TAGS = new Set([330, 34665, 34853, 40965])

function parseTIFF(bytes) {
  const little = bytes[0] === 0x49
  const r = new ByteReader(bytes, little)
  const warnings = new Set()
  const regions = []
  const summary = []
  const big = r.u16(2) === 43
  const entrySize = big ? 20 : 12
  const countSize = big ? 8 : 2
  const offsetSize = big ? 8 : 4
  const inlineSize = big ? 8 : 4
  const headerLength = big ? 16 : 8

  const headerChildren = [
    field('Byte order', 0, 2, little ? 'II (little-endian)' : 'MM (big-endian)', 'Applies to every number in the file', 'magic'),
    field('Magic', 2, 2, big ? '43 (BigTIFF)' : '42', 'TIFF version marker', 'magic')
  ]
  if (big) {
    headerChildren.push(field('Offset size', 4, 2, r.u16(4), 'Always 8', 'size'), field('Reserved', 6, 2, undefined, 'Zero', 'padding'))
  }
  const firstIFD = big ? r.u64(8) : r.u32(4)
  headerChildren.push(pointAt(field('First IFD offset', big ? 8 : 4, offsetSize, formatNumber(firstIFD), 'Where the first image directory starts', 'offset'), firstIFD, bytes.length))
  const fields = [field('Header', 0, Math.min(headerLength, bytes.length), big ? 'BigTIFF' : 'TIFF', 'Image file header', 'header', headerChildren)]
  if (!r.has(0, headerLength)) {
    warnings.add('File is truncated inside the header')
    return { summary, fields, warnings: [...warnings] }
  }
  regions.push({ name: 'Header', offset: 0, length: headerLength, kind: 'header' })

  const visited = new Set()
  const ifds = []
  let valueBudget = 1000000
  const dataFields = []

  // Reads one IFD; returns { tags: Map(tag -> {type, count, values, text}), next }
  const readIFD = (offset, kind, label) => {
    if (visited.has(offset)) {
      warnings.add(`IFD at offset ${offset} is referenced more than once (loop)`)
      return null
    }
    if (ifds.length >= MAX_IFDS) {
      warnings.add(`Stopped after ${MAX_IFDS} IFDs`)
      return null
    }
    if (!r.has(offset, countSize)) {
      warnings.add(`${label} offset ${formatNumber(offset)} is past the end of the file`)
      return null
    }
    visited.add(offset)
    const count = big ? r.u64(offset) : r.u16(offset)
    const entriesStart = offset + countSize
    const available = Math.floor((bytes.length - entriesStart) / entrySize)
    const readable = Math.min(count, available, 65535)
    if (readable < count) warnings.add(`${label} is truncated: ${formatNumber(readable)} of ${formatNumber(count)} entries present`)
    const tags = new Map()
    const entryFields = []
    for (let i = 0; i < readable; i++) {
      const at = entriesStart + i * entrySize
      const tag = r.u16(at)
      const type = r.u16(at + 2)
      const valueCount = big ? r.u64(at + 4) : r.u32(at + 4)
      const [size, typeName] = TYPES[type] || [0, `type ${type}`]
      const total = size * valueCount
      const valueField = at + 4 + (big ? 8 : 4)
      const dataOffset = total <= inlineSize ? valueField : (big ? r.u64(valueField) : r.u32(valueField))
      const name = (kind === 'GPS' ? GPS_TAGS[tag] : TAGS[tag]) || `Tag ${tag}`
      const entry = { type, count: valueCount, offset: dataOffset, values: [], text: null }
      if (size > 0 && r.has(dataOffset, Math.min(total, bytes.length))) {
        if (type === 2) {
          entry.text = latin1(bytes, dataOffset, Math.min(valueCount, 1024)).replace(/\0[\s\S]*$/, '')
        } else {
          const limit = Math.min(valueCount, ARRAY_TAGS.has(tag) && kind !== 'GPS' ? Math.min(MAX_VALUES, valueBudget) : 16)
          valueBudget -= limit
          for (let v = 0; v < limit; v++) entry.values.push(readValue(r, type, dataOffset + v * size))
        }
      } else if (size > 0) {
        warnings.add(`${name} in ${label} points past the end of the file`)
      }
      tags.set(tag, entry)
      if (entryFields.length >= MAX_ENTRIES_SHOWN) continue
      let shown
      if (entry.text !== null) shown = `"${printable(entry.text, 80)}"`
      else if (type === 5 || type === 10) shown = entry.values.slice(0, MAX_PREVIEW_VALUES).map((_, v) => formatRational(r, type, dataOffset + v * 8)).join(', ')
      else if (type === 7 && valueCount > 8) shown = formatBytes(valueCount)
      else shown = entry.values.slice(0, MAX_PREVIEW_VALUES).map(v => (typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(6) : v)).join(', ')
      if (valueCount > MAX_PREVIEW_VALUES && entry.text === null && type !== 7) shown += `, … (${formatNumber(valueCount)} values)`
      const decoded = describeTag(kind, tag, entry)
      if (decoded) shown = `${decoded} (${shown})`
      // Out-of-line values, and the tags whose value is the offset of another directory
      const pointsTo = total > inlineSize && size > 0 ? dataOffset : IFD_POINTER_TAGS.has(tag) && entry.values.length === 1 ? entry.values[0] : null
      entryFields.push(pointAt(field(name, at, entrySize, shown, `Tag ${tag}, ${typeName} × ${formatNumber(valueCount)}${total > inlineSize ? `, data at offset ${formatNumber(dataOffset)}` : ''}`, 'header'), pointsTo, bytes.length))
      if (total > inlineSize && size > 0 && total >= 16 && r.has(dataOffset, 1) && type !== 13 && type !== 18 && dataFields.length < 512) {
        dataFields.push(field(`${name} data (${label})`, dataOffset, Math.min(total, bytes.length - dataOffset), formatBytes(total), `Out-of-line value of ${name}`, 'data'))
      }
    }
    const end = entriesStart + readable * entrySize
    const next = r.has(end, offsetSize) ? (big ? r.u64(end) : r.u32(end)) : 0
    const children = [field('Entry count', offset, countSize, formatNumber(count), 'Number of 12-byte tag entries', 'count')]
    children.push(...capFields(entryFields, MAX_ENTRIES_SHOWN, 'more entries', readable - entryFields.length, end))
    let length = end - offset
    if (r.has(end, offsetSize)) {
      children.push(pointAt(field('Next IFD offset', end, offsetSize, next ? formatNumber(next) : '0 (last)', 'Links to the next image', 'offset'), next || null, bytes.length))
      length += offsetSize
    }
    const ifd = { offset, kind, label, tags, next, field: field(label, offset, length, plural(count, 'entry', 'entries'), `${kind === 'main' ? 'Image' : kind} file directory`, 'table', children) }
    ifds.push(ifd)
    regions.push({ name: label, offset, length, kind: 'table' })
    return ifd
  }

  const pages = []
  let offset = firstIFD
  while (offset && ifds.length < MAX_IFDS) {
    const ifd = readIFD(offset, 'main', `IFD${pages.length}`)
    if (!ifd) break
    pages.push(ifd)
    offset = ifd.next
  }

  // Follow EXIF, GPS, interoperability and SubIFD pointers (two levels)
  const followPointers = (ifd, depth) => {
    for (const [tag, kind] of Object.entries(POINTER_TAGS)) {
      const entry = ifd.tags.get(Number(tag))
      if (!entry) continue
      const targets = entry.values.length ? entry.values.slice(0, 16) : [entry.offset]
      targets.forEach((target, index) => {
        const child = readIFD(target, kind, `${kind} IFD${targets.length > 1 ? ` ${index}` : ''} (from ${ifd.label})`)
        if (child) {
          ifd[kind] = ifd[kind] || child
          if (depth < 2) followPointers(child, depth + 1)
        }
      })
    }
  }
  pages.forEach(page => followPointers(page, 1))

  // Image data from strip or tile offsets
  for (const ifd of ifds) {
    const offsets = (ifd.tags.get(273) || ifd.tags.get(324) || {}).values || []
    const counts = (ifd.tags.get(279) || ifd.tags.get(325) || {}).values || []
    let start = Infinity
    let end = 0
    for (let i = 0; i < Math.min(offsets.length, counts.length); i++) {
      if (offsets[i] >= bytes.length) continue
      start = Math.min(start, offsets[i])
      end = Math.max(end, offsets[i] + counts[i])
      if (offsets[i] + counts[i] > bytes.length) warnings.add(`Image data of ${ifd.label} runs past the end of the file`)
    }
    if (end > start) {
      const length = Math.min(end, bytes.length) - start
      const chunks = ifd.tags.has(324) ? plural(offsets.length, 'tile') : plural(offsets.length, 'strip')
      dataFields.push(field(`Image data (${ifd.label})`, start, length, `${chunks}, ${formatBytes(length)}`, 'Strips or tiles as located by the offset tags', 'data'))
      regions.push({ name: `Image data (${ifd.label})`, offset: start, length, kind: 'data' })
    }
  }

  fields.push(...nonOverlapping([...ifds.map(ifd => ifd.field), ...dataFields]).filter(f => f.offset >= headerLength))

  const first = pages[0]
  const text = (ifd, tag) => {
    const entry = ifd && ifd.tags.get(tag)
    return entry && entry.text ? printable(entry.text.trim(), 120) : null
  }
  const number = (ifd, tag) => {
    const entry = ifd && ifd.tags.get(tag)
    return entry && entry.values.length ? entry.values[0] : undefined
  }
  summary.push(item('Byte Order', little ? 'Little-endian (II)' : 'Big-endian (MM)'))
  if (big) summary.push(item('Variant', 'BigTIFF (64-bit offsets)'))
  summary.push(item('Images', formatNumber(pages.length)))
  if (first) {
    const width = number(first, 256)
    const height = number(first, 257)
    if (width !== undefined) summary.push(item('Width', `${width}px`))
    if (height !== undefined) summary.push(item('Height', `${height}px`))
    const bits = first.tags.get(258)
    if (bits && bits.values.length) summary.push(item('Bits per Sample', bits.values.slice(0, 8).join(', ')))
    if (number(first, 277) !== undefined) summary.push(item('Samples per Pixel', number(first, 277)))
    summary.push(item('Compression', COMPRESSION[number(first, 259) ?? 1] || `Unknown (${number(first, 259)})`))
    if (number(first, 262) !== undefined) summary.push(item('Colour Model', PHOTOMETRIC[number(first, 262)] || `Unknown (${number(first, 262)})`))
    if (number(first, 274) !== undefined) summary.push(item('Orientation', ORIENTATION[number(first, 274)] || number(first, 274)))
    const xres = number(first, 282)
    if (xres) summary.push(item('Resolution', `${+xres.toFixed(2)} × ${+(number(first, 283) || xres).toFixed(2)} ${RESOLUTION_UNIT[number(first, 296) ?? 2] || ''}`.trim()))
    summary.push(item('Layout', first.tags.has(324) ? 'Tiled' : 'Strips'))
    for (const [tag, label] of [[271, 'Make'], [272, 'Model'], [305, 'Software'], [306, 'Date'], [315, 'Artist'], [270, 'Description'], [33432, 'Copyright']]) {
      const value = text(first, tag)
      if (value) summary.push(item(label, value))
    }
    if (first.tags.has(50706)) summary.push(item('DNG', 'Yes (raw camera image)'))
    if (first.tags.has(34675)) summary.push(item('ICC Profile', 'Present'))
    if (first.tags.has(700)) summary.push(item('XMP Metadata', 'Present'))
  }
  pages.slice(1, 32).forEach((page, index) => {
    const width = number(page, 256)
    const height = number(page, 257)
    summary.push(item(`Image ${index + 2}`, `${width ?? '?'}×${height ?? '?'}, ${COMPRESSION[number(page, 259) ?? 1] || 'unknown compression'}`, null, 'Images'))
  })

  const exif = ifds.find(ifd => ifd.kind === 'EXIF')
  const gps = ifds.find(ifd => ifd.kind === 'GPS')
  summary.push(item('EXIF', exif ? `Present (${plural(exif.tags.size, 'tag')})` : 'None'))
  if (exif) {
    const exposure = exif.tags.get(33434)
    if (exposure && exposure.values.length) {
      const seconds = exposure.values[0]
      summary.push(item('Exposure', seconds > 0 && seconds < 1 ? `1/${Math.round(1 / seconds)} s` : `${seconds} s`, null, 'EXIF'))
    }
    if (number(exif, 33437)) summary.push(item('Aperture', `f/${+number(exif, 33437).toFixed(1)}`, null, 'EXIF'))
    if (number(exif, 34855)) summary.push(item('ISO', number(exif, 34855), null, 'EXIF'))
    if (number(exif, 37386)) summary.push(item('Focal Length', `${+number(exif, 37386).toFixed(1)} mm`, null, 'EXIF'))
    const taken = text(exif, 36867)
    if (taken) summary.push(item('Taken', taken, null, 'EXIF'))
    const lens = text(exif, 42036)
    if (lens) summary.push(item('Lens', lens, null, 'EXIF'))
  }
  summary.push(item('GPS', gps ? 'Present' : 'None'))
  if (gps) {
    const coordinate = (tag, refTag) => {
      const entry = gps.tags.get(tag)
      if (!entry || entry.values.length < 3) return null
      const [d, m, s] = entry.values
      const ref = text(gps, refTag) || ''
      const value = (d + m / 60 + s / 3600) * (ref === 'S' || ref === 'W' ? -1 : 1)
      return Number.isFinite(value) ? value : null
    }
    const lat = coordinate(2, 1)
    const lon = coordinate(4, 3)
    if (lat !== null && lon !== null) {
      summary.push(item('Coordinates', `${lat.toFixed(6)}, ${lon.toFixed(6)}`, ['The image records where it was taken'], 'GPS'))
      warnings.add('The image contains GPS coordinates')
    }
    const altitude = number(gps, 6)
    if (altitude !== undefined) summary.push(item('Altitude', `${+altitude.toFixed(1)} m${number(gps, 5) === 1 ? ' below sea level' : ''}`, null, 'GPS'))
  }

  return { formatName: big ? 'BigTIFF Image' : 'TIFF Image', summary, fields, regions, warnings: [...warnings] }
}

function describeTag(kind, tag, entry) {
  const value = entry.values[0]
  if (kind === 'GPS' || value === undefined) return null
  if (tag === 259) return COMPRESSION[value] || null
  if (tag === 262) return PHOTOMETRIC[value] || null
  if (tag === 274) return ORIENTATION[value] || null
  if (tag === 296) return { 1: 'none', 2: 'inch', 3: 'centimetre' }[value] || null
  if (tag === 284) return { 1: 'chunky', 2: 'planar' }[value] || null
  return null
}

/** Whether the bytes at `offset` start a TIFF header (also used inside EXIF blocks) */
export function isTiffHeader(bytes, offset = 0) {
  if (offset + 8 > bytes.length) return false
  const a = bytes[offset]
  const b = bytes[offset + 1]
  if (a === 0x49 && b === 0x49) return (bytes[offset + 2] === 42 || bytes[offset + 2] === 43) && bytes[offset + 3] === 0
  if (a === 0x4D && b === 0x4D) return bytes[offset + 2] === 0 && (bytes[offset + 3] === 42 || bytes[offset + 3] === 43)
  return false
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'tiff',
  name: 'TIFF Image',
  category: 'image',
  detect: bytes => isTiffHeader(bytes, 0),
  parse: fitted(parseTIFF)
}
