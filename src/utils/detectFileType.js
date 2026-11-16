import { formatBytes } from './formatBytes.js'

const MACHO_MAGICS = [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]
const FAT_MAGIC = 0xcafebabe

function startsWith(bytes, signature) {
  if (bytes.length < signature.length) return false
  return signature.every((byte, i) => bytes[i] === byte)
}

// 0xCAFEBABE starts both universal Mach-O binaries and Java class files. In a
// universal binary the next u32 is the (small) architecture count; in a class
// file it holds the minor and major version, and major versions start at 45.
function isJavaClass(view) {
  return view.byteLength >= 8 &&
    view.getUint32(0, false) === FAT_MAGIC &&
    view.getUint16(6, false) >= 45
}

/**
 * Identifies a file by its leading bytes. Returns one of 'png', 'jpeg', 'gif',
 * 'pe', 'macho', 'java-class', 'zip', 'elf', 'pdf' or 'unknown'.
 */
export function detectFileType(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  if (startsWith(bytes, [0x89, 0x50, 0x4E, 0x47])) return 'png'
  if (startsWith(bytes, [0xFF, 0xD8])) return 'jpeg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif'
  if (startsWith(bytes, [0x4D, 0x5A])) return 'pe'

  if (bytes.length >= 4) {
    const magic = view.getUint32(0, false)
    if (magic === FAT_MAGIC) {
      if (bytes.length < 8) return 'unknown'
      return isJavaClass(view) ? 'java-class' : 'macho'
    }
    if (MACHO_MAGICS.includes(magic)) return 'macho'
  }

  if (startsWith(bytes, [0x50, 0x4B, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4B, 0x05, 0x06])) return 'zip'
  if (startsWith(bytes, [0x7F, 0x45, 0x4C, 0x46])) return 'elf'
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2D])) return 'pdf'
  return 'unknown'
}

function javaRelease(major) {
  if (major >= 49) return `Java ${major - 44}`
  return { 45: 'Java 1.0 / 1.1', 46: 'Java 1.2', 47: 'Java 1.3', 48: 'Java 1.4' }[major] || null
}

export function parseJavaClass(buffer) {
  const view = new DataView(buffer)
  const metadata = new Set(['Format: Java class file'])
  if (!isJavaClass(view)) return metadata
  const minor = view.getUint16(4, false)
  const major = view.getUint16(6, false)
  metadata.add(`Class File Version: ${major}.${minor}`)
  const release = javaRelease(major)
  if (release) metadata.add(`Java Release: ${release}${minor === 0xFFFF ? ' (preview features)' : ''}`)
  return metadata
}

export function basicMetadata(buffer, mimeType) {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4))
  const metadata = new Set([
    `File Size: ${formatBytes(buffer.byteLength)}`,
    `File Type: ${mimeType || 'application/octet-stream'}`
  ])
  if (bytes.length > 0) {
    const hex = [...bytes].map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join('')
    metadata.add(`First Bytes: 0x${hex}`)
  }
  return metadata
}
