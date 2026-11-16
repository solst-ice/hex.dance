import { ascii, dataView, item, startsWith } from './shared.js'
import { FieldList, field, hexOffset, plural, printable } from './fieldTree.js'

const DISPOSAL = ['unspecified', 'leave in place', 'restore to background', 'restore to previous']

// Data sub-blocks: a size byte (1-255) followed by that many bytes, ending
// with a zero size byte. Returns the offset after the terminator.
function skipSubBlocks(bytes, offset) {
  let p = offset
  let blocks = 0
  while (p < bytes.length) {
    const size = bytes[p]
    if (size === 0) return { end: p + 1, blocks, complete: true }
    p += 1 + size
    blocks++
  }
  return { end: Math.min(p, bytes.length), blocks, complete: false }
}

function subBlocksField(name, bytes, offset, description) {
  const { end, blocks, complete } = skipSubBlocks(bytes, offset)
  return {
    end,
    complete,
    field: end <= offset ? null : field(name, offset, end - offset, {
      value: `${plural(blocks, 'sub-block')}, ${plural(end - offset, 'byte')}`,
      kind: 'data',
      description: `${description}. Stored as sub-blocks of up to 255 bytes, each preceded by its size, ending with a zero byte`
    })
  }
}

function colorTableField(name, offset, entries, bytes) {
  const length = Math.min(entries * 3, bytes.length - offset)
  if (length <= 0) return null
  return field(name, offset, length, {
    value: plural(entries, 'colour'),
    kind: 'data',
    description: 'RGB triplets, one byte per channel; pixels refer to colours by index'
  })
}

function readExtension(view, bytes, offset) {
  const label = bytes[offset + 1]
  const children = [
    field('Introducer', offset, 1, { value: '0x21 (!)', kind: 'magic', description: 'Starts an extension block' }),
    field('Label', offset + 1, 1, { value: hexOffset(label), kind: 'header' })
  ]
  let p = offset + 2
  if (label === 0xF9 && p + 6 <= bytes.length && bytes[p] === 4) {
    const packed = bytes[p + 1]
    const delay = view.getUint16(p + 2, true)
    const transparent = (packed & 1) !== 0
    children.push(
      field('Block size', p, 1, { value: 4, kind: 'size' }),
      field('Packed fields', p + 1, 1, {
        value: `disposal: ${DISPOSAL[(packed >> 2) & 7] || (packed >> 2) & 7}${packed & 2 ? ', wait for input' : ''}${transparent ? ', transparent colour' : ''}`,
        kind: 'flags',
        description: 'Bits 2-4: what happens to the frame before the next one; bit 1: wait for user input; bit 0: transparency'
      }),
      field('Delay', p + 2, 2, { value: `${delay / 100} s`, kind: 'header', description: 'Time before the next frame, in hundredths of a second (little-endian)' }),
      field('Transparent colour index', p + 4, 1, { value: transparent ? bytes[p + 4] : `${bytes[p + 4]} (unused)`, kind: 'header' }),
      field('Terminator', p + 5, 1, { value: '0x00', kind: 'padding' })
    )
    return { name: 'Graphic control extension', end: p + 6, children, value: `delay ${delay / 100} s`, description: 'Timing, disposal and transparency for the next image' }
  }
  if (label === 0xFF && p + 12 <= bytes.length && bytes[p] === 11) {
    const app = printable(bytes, p + 1, 11)
    children.push(
      field('Block size', p, 1, { value: 11, kind: 'size' }),
      field('Application identifier', p + 1, 8, { value: printable(bytes, p + 1, 8), kind: 'string' }),
      field('Authentication code', p + 9, 3, { value: printable(bytes, p + 9, 3), kind: 'string' })
    )
    p += 12
    let value = app
    const isLoop = (app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') && p + 5 <= bytes.length && bytes[p] === 3 && bytes[p + 1] === 1
    if (isLoop) {
      const loops = view.getUint16(p + 2, true)
      value = loops === 0 ? 'loops forever' : `loops ${plural(loops, 'time')}`
      children.push(
        field('Sub-block size', p, 1, { value: 3, kind: 'size' }),
        field('Sub-block ID', p + 1, 1, { value: 1, kind: 'header' }),
        field('Loop count', p + 2, 2, { value: loops === 0 ? '0 (forever)' : loops, kind: 'count', description: 'How many times the animation repeats; 0 means forever' })
      )
      p += 4
    }
    const data = subBlocksField(isLoop ? 'Terminator' : 'Application data', bytes, p, 'Application-defined data')
    children.push(isLoop && data.end === p + 1 ? field('Terminator', p, 1, { value: '0x00', kind: 'padding' }) : data.field)
    if (!children[children.length - 1]) children.pop()
    return { name: 'Application extension', end: data.end, children, value, description: 'Data for a specific application; NETSCAPE2.0 holds the animation loop count', complete: data.complete }
  }
  const names = { 0xFE: 'Comment extension', 0x01: 'Plain text extension', 0xF9: 'Graphic control extension', 0xFF: 'Application extension' }
  let value
  if (label === 0x01 && p + 13 <= bytes.length && bytes[p] === 12) {
    children.push(field('Header', p, 13, { kind: 'header', description: 'Text grid position, size and colours' }))
    p += 13
  }
  if (label === 0xFE && p < bytes.length && bytes[p] > 0) value = printable(bytes, p + 1, Math.min(bytes[p], bytes.length - p - 1), 60)
  const data = subBlocksField(label === 0xFE ? 'Comment' : 'Data', bytes, p, label === 0xFE ? 'Comment text' : 'Extension data')
  if (data.field) children.push(data.field)
  return { name: names[label] || `Extension ${hexOffset(label)}`, end: data.end, children, value, description: label === 0xFE ? 'A text comment, not displayed' : 'Extension block', complete: data.complete }
}

function readImage(view, bytes, offset, frame) {
  const p = offset
  const packed = bytes[p + 9]
  const local = (packed & 0x80) !== 0
  const width = view.getUint16(p + 5, true)
  const height = view.getUint16(p + 7, true)
  const descriptor = field('Image descriptor', p, 10, {
    value: `${width} × ${height} at ${view.getUint16(p + 1, true)}, ${view.getUint16(p + 3, true)}`,
    kind: 'header',
    description: 'Position and size of this image within the logical screen',
    children: [
      field('Separator', p, 1, { value: '0x2C (,)', kind: 'magic', description: 'Starts an image' }),
      field('Left', p + 1, 2, { value: view.getUint16(p + 1, true), kind: 'offset' }),
      field('Top', p + 3, 2, { value: view.getUint16(p + 3, true), kind: 'offset' }),
      field('Width', p + 5, 2, { value: `${width} px`, kind: 'size' }),
      field('Height', p + 7, 2, { value: `${height} px`, kind: 'size' }),
      field('Packed fields', p + 9, 1, {
        value: [local ? `local colour table, ${2 << (packed & 7)} colours` : 'no local colour table', packed & 0x40 ? 'interlaced' : null, packed & 0x20 ? 'sorted' : null].filter(Boolean).join(', '),
        kind: 'flags',
        description: 'Bit 7: local colour table; bit 6: interlaced; bit 5: sorted; bits 0-2: table size N, for 2^(N+1) colours'
      })
    ]
  })
  const children = [descriptor]
  let q = p + 10
  if (local) {
    const entries = 2 << (packed & 7)
    const table = colorTableField('Local colour table', q, entries, bytes)
    if (table) children.push(table)
    q += entries * 3
  }
  let complete = false
  if (q < bytes.length) {
    children.push(field('LZW minimum code size', q, 1, { value: bytes[q], kind: 'header', description: 'Starting code size for the LZW decompressor' }))
    q++
    if (q < bytes.length) {
      const data = subBlocksField('Image data', bytes, q, 'LZW-compressed colour indexes')
      if (data.field) children.push(data.field)
      q = data.end
      complete = data.complete
    }
  }
  const end = Math.min(q, bytes.length)
  return { end, complete, field: field(`Frame ${frame}`, offset, end - offset, { value: `${width} × ${height}`, kind: 'header', description: 'One image: descriptor, optional local colour table and compressed pixels', children }) }
}

function parseGIF(bytes) {
  const view = dataView(bytes)
  const summary = []
  const warnings = []
  const fields = []
  const regions = []
  const result = () => ({ summary, fields, regions, warnings })

  if (bytes.length >= 6) {
    const version = ascii(bytes, 0, 6).replace(/[^\x20-\x7E]/g, '?')
    summary.push(item('Version', version))
    fields.push(field('Header', 0, 6, {
      value: version,
      kind: 'magic',
      description: 'GIF signature and version',
      children: [
        field('Signature', 0, 3, { value: 'GIF', kind: 'magic', description: 'Identifies the file as GIF' }),
        field('Version', 3, 3, { value: version.slice(3), kind: 'magic', description: '87a or 89a; 89a added extensions such as animation timing and transparency' })
      ]
    }))
    regions.push({ name: 'Header', offset: 0, length: 6, kind: 'header' })
  } else if (bytes.length > 0) {
    fields.push(field('Signature', 0, Math.min(4, bytes.length), { value: 'GIF8', kind: 'magic' }))
  }
  if (bytes.length < 10) {
    warnings.push('File is truncated before the logical screen descriptor')
    return result()
  }
  summary.push(item('Width', `${view.getUint16(6, true)}px`))
  summary.push(item('Height', `${view.getUint16(8, true)}px`))
  if (bytes.length < 13) {
    warnings.push('File is truncated inside the logical screen descriptor')
    return result()
  }

  const flags = bytes[10]
  const hasGlobal = (flags & 0x80) !== 0
  summary.push(item('Global Color Table', hasGlobal ? `Yes (${2 << (flags & 7)} colors)` : 'No'))
  summary.push(item('Color Resolution', `${((flags >> 4) & 7) + 1} bits`))
  if (hasGlobal) summary.push(item('Background Color Index', bytes[11]))

  fields.push(field('Logical screen descriptor', 6, 7, {
    value: `${view.getUint16(6, true)} × ${view.getUint16(8, true)}`,
    kind: 'header',
    description: 'Size of the canvas every frame is drawn on, and the global colour table settings',
    children: [
      field('Width', 6, 2, { value: `${view.getUint16(6, true)} px`, kind: 'size', description: 'Little-endian, like every GIF integer' }),
      field('Height', 8, 2, { value: `${view.getUint16(8, true)} px`, kind: 'size' }),
      field('Packed fields', 10, 1, {
        value: `${hasGlobal ? `global colour table, ${2 << (flags & 7)} colours` : 'no global colour table'}, ${((flags >> 4) & 7) + 1}-bit colour resolution${flags & 8 ? ', sorted' : ''}`,
        kind: 'flags',
        description: 'Bit 7: global colour table present; bits 4-6: colour resolution - 1; bit 3: sorted; bits 0-2: table size N, for 2^(N+1) colours'
      }),
      field('Background colour index', 11, 1, { value: bytes[11], kind: 'header' }),
      field('Pixel aspect ratio', 12, 1, { value: bytes[12] === 0 ? '0 (not given)' : `${((bytes[12] + 15) / 64).toFixed(3)}`, kind: 'header' })
    ]
  }))
  regions.push({ name: 'Logical screen descriptor', offset: 6, length: 7, kind: 'header' })

  let offset = 13
  if (hasGlobal) {
    const entries = 2 << (flags & 7)
    const table = colorTableField('Global colour table', offset, entries, bytes)
    if (table) fields.push(table)
    if (table) regions.push({ name: 'Global colour table', offset, length: table.length, kind: 'table' })
    offset += entries * 3
    if (offset > bytes.length) {
      warnings.push('File is truncated inside the global colour table')
      return result()
    }
  }

  const blocks = new FieldList(2000, 'blocks')
  let frames = 0
  let trailerAt = -1
  let loop = null
  let truncated = false
  let invalidAt = -1
  const addRegion = (name, start, length, kind) => {
    const last = regions[regions.length - 1]
    if (last && last.name === name && last.offset + last.length === start) last.length += length
    else if (regions.length < 500) regions.push({ name, offset: start, length, kind })
  }

  while (offset < bytes.length) {
    const introducer = bytes[offset]
    if (introducer === 0x3B) {
      blocks.push(field('Trailer', offset, 1, { value: '0x3B (;)', kind: 'magic', description: 'Marks the end of the GIF data stream' }))
      addRegion('Trailer', offset, 1, 'header')
      trailerAt = offset + 1
      break
    }
    if (introducer === 0x21) {
      if (offset + 2 > bytes.length) {
        truncated = true
        break
      }
      const ext = readExtension(view, bytes, offset)
      if (ext.name === 'Application extension' && ext.value && ext.value.startsWith('loops')) loop = ext.value
      blocks.push(field(ext.name, offset, ext.end - offset, { value: ext.value, kind: 'header', description: ext.description, children: ext.children }))
      addRegion('Extensions', offset, ext.end - offset, 'metadata')
      if (ext.complete === false) truncated = true
      offset = ext.end
      continue
    }
    if (introducer === 0x2C) {
      if (offset + 10 > bytes.length) {
        truncated = true
        break
      }
      frames++
      const image = readImage(view, bytes, offset, frames)
      blocks.push(image.field)
      addRegion('Frames', offset, image.end - offset, 'data')
      if (!image.complete) truncated = true
      offset = image.end
      continue
    }
    invalidAt = offset
    break
  }

  fields.push(...blocks.toArray())
  if (truncated && offset < bytes.length) {
    fields.push(field('Truncated block', offset, bytes.length - offset, { kind: 'data', description: 'A block cut off by the end of the file' }))
  }
  if (invalidAt !== -1) {
    fields.push(field('Unparsed data', invalidAt, bytes.length - invalidAt, { kind: 'data', description: 'Expected an image (0x2C), extension (0x21) or trailer (0x3B) here' }))
    addRegion('Unparsed data', invalidAt, bytes.length - invalidAt, 'other')
    warnings.push(`Unexpected byte ${hexOffset(bytes[invalidAt])} at offset ${hexOffset(invalidAt)}`)
  }
  if (trailerAt !== -1 && trailerAt < bytes.length) {
    fields.push(field('Trailing data', trailerAt, bytes.length - trailerAt, { kind: 'data', description: 'Bytes after the trailer are ignored by decoders' }))
    addRegion('Trailing data', trailerAt, bytes.length - trailerAt, 'other')
    warnings.push(`${plural(bytes.length - trailerAt, 'byte')} of data after the GIF trailer`)
  }
  if (trailerAt === -1 && invalidAt === -1) warnings.push('No trailer: the file is truncated')
  if (frames > 0) summary.push(item('Frames', frames))
  if (loop && frames > 1) summary.push(item('Animation', loop))
  return result()
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'gif',
  name: 'GIF Image',
  category: 'image',
  detect: bytes => startsWith(bytes, [0x47, 0x49, 0x46, 0x38]),
  parse: parseGIF
}
