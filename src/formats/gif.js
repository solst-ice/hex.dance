import { ascii, dataView, item, startsWith } from './shared.js'

function parseGIF(bytes) {
  const view = dataView(bytes)
  const summary = []
  const warnings = []
  const fields = []
  const result = () => ({ summary, fields, warnings })

  if (bytes.length >= 6) {
    const version = ascii(bytes, 0, 6).replace(/[^\x20-\x7E]/g, '?')
    summary.push(item('Version', version))
    fields.push({ name: 'Signature', offset: 0, length: 6, value: version, kind: 'magic', description: 'GIF signature and version' })
  } else {
    fields.push({ name: 'Signature', offset: 0, length: Math.min(4, bytes.length), value: 'GIF8', kind: 'magic' })
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
  summary.push(item('Global Color Table', flags & 0x80 ? `Yes (${2 << (flags & 7)} colors)` : 'No'))
  summary.push(item('Color Resolution', `${((flags >> 4) & 7) + 1} bits`))
  if (flags & 0x80) summary.push(item('Background Color Index', bytes[11]))
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
