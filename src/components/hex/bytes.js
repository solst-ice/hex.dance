// Lookup tables so rendering a cell never formats numbers on the fly

export const HEX = Array.from({ length: 256 }, (_, v) => v.toString(16).padStart(2, '0'))

export const BYTE_CLASSES = ['zero', 'print', 'ctrl', 'ff', 'high']

export function byteClass(v) {
  if (v === 0) return 'zero'
  if (v > 0x20 && v < 0x7f) return 'print'
  if (v < 0x80) return 'ctrl'
  if (v === 0xff) return 'ff'
  return 'high'
}

export const CLASS_NAME = Array.from({ length: 256 }, (_, v) => 'b-' + byteClass(v))

// Character shown in the text column: printable ASCII as is, space as a space,
// zero as a middle dot and everything else as a period
export const CHAR = Array.from({ length: 256 }, (_, v) => {
  if (v >= 0x20 && v < 0x7f) return String.fromCharCode(v)
  return v === 0 ? '·' : '.'
})

const CHAR_NAMES = {
  0x00: 'NUL', 0x07: 'BEL', 0x08: 'BS', 0x09: 'TAB', 0x0a: 'LF', 0x0b: 'VT', 0x0c: 'FF',
  0x0d: 'CR', 0x1b: 'ESC', 0x20: 'SPACE', 0x7f: 'DEL'
}

export function describeByte(v) {
  let char
  if (v > 0x20 && v < 0x7f) char = `'${String.fromCharCode(v)}'`
  else if (CHAR_NAMES[v]) char = CHAR_NAMES[v]
  else if (v < 0x20) char = '^' + String.fromCharCode(v + 0x40)
  else char = '—'
  return {
    hex: '0x' + HEX[v],
    dec: String(v),
    bin: '0b' + v.toString(2).padStart(8, '0'),
    char
  }
}

export function formatOffset(offset) {
  return offset.toString(16).padStart(8, '0')
}

export function hexText(bytes, start, end) {
  const parts = new Array(Math.max(0, end - start))
  for (let i = start; i < end; i++) parts[i - start] = HEX[bytes[i]]
  return parts.join(' ')
}

// Printable ASCII and ordinary whitespace are kept, everything else becomes '.'
export function asciiText(bytes, start, end) {
  let out = ''
  const CHUNK = 8192
  for (let i = start; i < end; i += CHUNK) {
    const stop = Math.min(end, i + CHUNK)
    const codes = new Array(stop - i)
    for (let j = i; j < stop; j++) {
      const v = bytes[j]
      codes[j - i] = (v >= 0x20 && v < 0x7f) || v === 0x09 || v === 0x0a || v === 0x0d ? v : 0x2e
    }
    out += String.fromCharCode.apply(null, codes)
  }
  return out
}

export function downloadName(fileName) {
  const name = fileName || 'file'
  const lastDot = name.lastIndexOf('.')
  return lastDot > 0
    ? `${name.slice(0, lastDot)}-hexdance${name.slice(lastDot)}`
    : `${name}-hexdance`
}
