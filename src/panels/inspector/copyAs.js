// Text renderings of a byte range for the clipboard

/** Clipboard formats refuse selections larger than this. */
export const CLIPBOARD_LIMIT = 1024 * 1024

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function join(bytes, map, separator) {
  const parts = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) parts[i] = map(bytes[i])
  return parts.join(separator)
}

export function toHex(bytes) {
  return join(bytes, b => HEX[b], ' ')
}

export function toHexList(bytes) {
  return join(bytes, b => `0x${HEX[b]}`, ', ')
}

export function toCArray(bytes, name = 'data') {
  const lines = []
  for (let i = 0; i < bytes.length; i += 12) {
    lines.push(`  ${join(bytes.subarray(i, i + 12), b => `0x${HEX[b]}`, ', ')}`)
  }
  return `unsigned char ${name}[${bytes.length}] = {\n${lines.join(',\n')}${lines.length ? '\n' : ''}};`
}

const PY_ESCAPES = { 0x09: '\\t', 0x0a: '\\n', 0x0d: '\\r', 0x27: "\\'", 0x5c: '\\\\' }

export function toPythonBytes(bytes) {
  return `b'${join(bytes, b => PY_ESCAPES[b] || (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${HEX[b]}`), '')}'`
}

// \xHH is always exactly two digits in JavaScript, Python and JSON-like
// readers, so the output is unambiguous whatever follows an escape
const STRING_ESCAPES = { 0x00: '\\0', 0x09: '\\t', 0x0a: '\\n', 0x0d: '\\r', 0x22: '\\"', 0x5c: '\\\\' }

export function toEscapedString(bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    let piece = STRING_ESCAPES[b]
    // "\0" followed by a digit would read as an octal escape
    if (b === 0 && i + 1 < bytes.length && bytes[i + 1] >= 0x30 && bytes[i + 1] <= 0x39) piece = '\\x00'
    text += piece || (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${HEX[b]}`)
  }
  return `"${text}"`
}

export function toBase64(bytes) {
  const out = []
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out.push(B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63])
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out.push(`${B64[n >> 18]}${B64[(n >> 12) & 63]}==`)
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out.push(`${B64[n >> 18]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`)
  }
  return out.join('')
}

export const COPY_FORMATS = [
  { id: 'hex', label: 'Hex', format: toHex },
  { id: 'hexlist', label: '0x list', format: toHexList },
  { id: 'c', label: 'C array', format: bytes => toCArray(bytes) },
  { id: 'python', label: 'Python bytes', format: toPythonBytes },
  { id: 'base64', label: 'Base64', format: toBase64 },
  { id: 'string', label: 'Escaped string', format: toEscapedString }
]

/** File name for a saved range, e.g. `hello.0x40-0x7f.bin` (inclusive end). */
export function rangeFileName(fileName, start, end) {
  const base = (fileName || 'selection').replace(/[\\/:*?"<>|]+/g, '_')
  return `${base}.0x${start.toString(16)}-0x${(end - 1).toString(16)}.bin`
}

export function formatSize(n) {
  if (n < 1024) return `${n} byte${n === 1 ? '' : 's'}`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KiB`
  return `${(n / 1024 / 1024).toFixed(1)} MiB`
}
