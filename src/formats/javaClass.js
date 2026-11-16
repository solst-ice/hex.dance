import { item } from './shared.js'

function javaRelease(major) {
  if (major >= 49) return `Java ${major - 44}`
  return { 45: 'Java 1.0 / 1.1', 46: 'Java 1.2', 47: 'Java 1.3', 48: 'Java 1.4' }[major] || null
}

const u16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1]

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'java-class',
  name: 'Java class file',
  category: 'executable',
  // 0xCAFEBABE starts both universal Mach-O binaries and Java class files. In a
  // universal binary the next u32 is the (small) architecture count; in a class
  // file it holds the minor and major version, and major versions start at 45.
  detect: bytes => bytes.length >= 8 &&
    bytes[0] === 0xCA && bytes[1] === 0xFE && bytes[2] === 0xBA && bytes[3] === 0xBE &&
    u16(bytes, 6) >= 45,
  parse(bytes) {
    const minor = u16(bytes, 4)
    const major = u16(bytes, 6)
    const release = javaRelease(major)
    const summary = [
      item('Format', 'Java class file'),
      item('Class File Version', `${major}.${minor}`)
    ]
    if (release) summary.push(item('Java Release', `${release}${minor === 0xFFFF ? ' (preview features)' : ''}`))
    return {
      summary,
      fields: [
        { name: 'magic', offset: 0, length: 4, value: '0xCAFEBABE', kind: 'magic', description: 'Java class file magic' },
        { name: 'minor_version', offset: 4, length: 2, value: String(minor), kind: 'header' },
        { name: 'major_version', offset: 6, length: 2, value: String(major), kind: 'header', description: release || undefined }
      ]
    }
  }
}
