// Pure decoders for the data inspector. Each takes the file's bytes and an
// offset and returns null when the value would read past the end of the file.

const CONTROL_NAMES = [
  'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL', 'BS', 'TAB', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI',
  'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB', 'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US'
]

const MIN_PLAUSIBLE_SECONDS = 315532800 // 1980-01-01
const MAX_PLAUSIBLE_SECONDS = 4102444800 // 2100-01-01
const FILETIME_UNIX_EPOCH = 116444736000000000n // 100 ns intervals from 1601 to 1970

function fits(bytes, offset, length) {
  return Number.isInteger(offset) && offset >= 0 && length > 0 && offset + length <= bytes.length
}

function view(bytes, offset, length) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, length)
}

/**
 * Unsigned and signed integer of 1, 2, 4 or 8 bytes. 64-bit values are BigInt.
 * @returns {{ unsigned: number|bigint, signed: number|bigint }|null}
 */
export function readInt(bytes, offset, size, littleEndian) {
  if (!fits(bytes, offset, size)) return null
  const v = view(bytes, offset, size)
  switch (size) {
    case 1: return { unsigned: v.getUint8(0), signed: v.getInt8(0) }
    case 2: return { unsigned: v.getUint16(0, littleEndian), signed: v.getInt16(0, littleEndian) }
    case 4: return { unsigned: v.getUint32(0, littleEndian), signed: v.getInt32(0, littleEndian) }
    case 8: return { unsigned: v.getBigUint64(0, littleEndian), signed: v.getBigInt64(0, littleEndian) }
    default: throw new RangeError(`Unsupported integer size ${size}`)
  }
}

/** @returns {number|null} */
export function readFloat(bytes, offset, size, littleEndian) {
  if (!fits(bytes, offset, size)) return null
  const v = view(bytes, offset, size)
  return size === 4 ? v.getFloat32(0, littleEndian) : v.getFloat64(0, littleEndian)
}

/** Shortest decimal text that reads back as the same float32 (or float64). */
export function formatFloat(value, size) {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return '+Infinity'
  if (value === -Infinity) return '-Infinity'
  if (Object.is(value, -0)) return '-0'
  if (size === 8) return String(value)
  for (let precision = 1; precision <= 9; precision++) {
    const text = value.toPrecision(precision)
    if (Math.fround(Number(text)) === value) return String(Number(text))
  }
  return String(value)
}

export function formatBits(byte) {
  const text = byte.toString(2).padStart(8, '0')
  return `${text.slice(0, 4)} ${text.slice(4)}`
}

/** Name or glyph of a single byte read as ASCII. */
export function describeAscii(byte) {
  if (byte < 0x20) return CONTROL_NAMES[byte]
  if (byte === 0x20) return 'space'
  if (byte === 0x7f) return 'DEL'
  if (byte > 0x7f) return 'not ASCII'
  return `'${String.fromCharCode(byte)}'`
}

/**
 * Strict UTF-8 decode of one code point (no overlong forms, no surrogates,
 * nothing above U+10FFFF).
 * @returns {{ codePoint: number, length: number } | { error: string, length: number } | null}
 */
export function readUtf8(bytes, offset) {
  if (!fits(bytes, offset, 1)) return null
  const b0 = bytes[offset]
  if (b0 < 0x80) return { codePoint: b0, length: 1 }
  if (b0 < 0xc2) return { error: b0 < 0xc0 ? 'continuation' : 'bad lead byte', length: 1 }
  let length, min, codePoint
  if (b0 < 0xe0) { length = 2; min = 0x80; codePoint = b0 & 0x1f }
  else if (b0 < 0xf0) { length = 3; min = 0x800; codePoint = b0 & 0x0f }
  else if (b0 < 0xf5) { length = 4; min = 0x10000; codePoint = b0 & 0x07 }
  else return { error: 'bad lead byte', length: 1 }
  for (let i = 1; i < length; i++) {
    if (offset + i >= bytes.length) return null
    const b = bytes[offset + i]
    if ((b & 0xc0) !== 0x80) return { error: 'truncated', length: i }
    codePoint = (codePoint << 6) | (b & 0x3f)
  }
  if (codePoint < min) return { error: 'overlong', length }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return { error: 'surrogate', length }
  if (codePoint > 0x10ffff) return { error: '> U+10FFFF', length }
  return { codePoint, length }
}

export function formatCodePoint(codePoint) {
  const hex = codePoint.toString(16).toUpperCase().padStart(4, '0')
  // Control characters and unassigned-looking marks are shown by number only
  const printable = codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint < 0xa0) && codePoint !== 0xad
  return printable ? `U+${hex} ${String.fromCodePoint(codePoint)}` : `U+${hex}`
}

const LEB_MAX_BYTES = 10 // enough for any 64-bit value

/**
 * ULEB128 / SLEB128 of at most 10 bytes.
 * @returns {{ value: bigint, length: number } | { error: string, length: number } | null}
 *   null when the encoding runs past the end of the file
 */
export function readLeb128(bytes, offset, signed) {
  if (!fits(bytes, offset, 1)) return null
  let result = 0n
  let shift = 0n
  for (let i = 0; i < LEB_MAX_BYTES; i++) {
    if (offset + i >= bytes.length) return null
    const byte = bytes[offset + i]
    result |= BigInt(byte & 0x7f) << shift
    shift += 7n
    if ((byte & 0x80) === 0) {
      if (signed && (byte & 0x40)) result -= 1n << shift
      return { value: result, length: i + 1 }
    }
  }
  return { error: 'longer than 10 bytes', length: LEB_MAX_BYTES }
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0')
}

function formatUtc(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

/** Seconds since 1970 as a UTC date, or null when outside 1980–2100. */
export function formatUnixSeconds(seconds) {
  const s = Number(seconds)
  if (!(s >= MIN_PLAUSIBLE_SECONDS && s < MAX_PLAUSIBLE_SECONDS)) return null
  return `${formatUtc(new Date(s * 1000))} UTC`
}

/**
 * A 64-bit time read as Unix seconds, Unix milliseconds or a Windows
 * FILETIME, whichever gives a date between 1980 and 2100.
 * @param {bigint} value
 * @returns {{ text: string, unit: string }|null}
 */
export function describeTime64(value) {
  if (value <= 0n) return null
  const seconds = formatUnixSeconds(value)
  if (seconds) return { text: seconds, unit: 's' }
  const ms = Number(value)
  if (ms >= MIN_PLAUSIBLE_SECONDS * 1000 && ms < MAX_PLAUSIBLE_SECONDS * 1000) {
    const date = new Date(ms)
    return { text: `${formatUtc(date)}.${pad(date.getUTCMilliseconds(), 3)} UTC`, unit: 'ms' }
  }
  if (value > FILETIME_UNIX_EPOCH) {
    const filetimeSeconds = (value - FILETIME_UNIX_EPOCH) / 10000000n
    const text = formatUnixSeconds(filetimeSeconds)
    if (text) return { text, unit: 'FILETIME' }
  }
  return null
}

/**
 * MS-DOS date and time as stored by FAT and ZIP: a little-endian time word
 * followed by a little-endian date word.
 * @returns {{ text: string } | { error: string } | null}
 */
export function readDosDateTime(bytes, offset) {
  if (!fits(bytes, offset, 4)) return null
  const time = bytes[offset] | (bytes[offset + 1] << 8)
  const date = bytes[offset + 2] | (bytes[offset + 3] << 8)
  const year = 1980 + (date >> 9)
  const month = (date >> 5) & 0x0f
  const day = date & 0x1f
  const hours = time >> 11
  const minutes = (time >> 5) & 0x3f
  const seconds = (time & 0x1f) * 2
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0
  if (!daysInMonth || day < 1 || day > daysInMonth || hours > 23 || minutes > 59 || seconds > 59) {
    return { error: 'invalid' }
  }
  return { text: `${year}-${pad(month)}-${pad(day)} ${pad(hours)}:${pad(minutes)}:${pad(seconds)}` }
}

function hexOf(bytes, from, to, reverse) {
  let text = ''
  for (let i = 0; i < to - from; i++) {
    const byte = bytes[reverse ? to - 1 - i : from + i]
    text += byte.toString(16).padStart(2, '0')
  }
  return text
}

/**
 * GUID from 16 bytes. Little-endian is the Microsoft layout (first three
 * fields stored little-endian); big-endian is the RFC 4122 byte order.
 */
export function readGuid(bytes, offset, littleEndian) {
  if (!fits(bytes, offset, 16)) return null
  const o = offset
  const parts = [
    hexOf(bytes, o, o + 4, littleEndian),
    hexOf(bytes, o + 4, o + 6, littleEndian),
    hexOf(bytes, o + 6, o + 8, littleEndian),
    hexOf(bytes, o + 8, o + 10, false),
    hexOf(bytes, o + 10, o + 16, false)
  ]
  return `{${parts.join('-')}}`
}

/** @returns {{ hex: string, css: string }|null} */
export function readColor(bytes, offset, withAlpha) {
  const length = withAlpha ? 4 : 3
  if (!fits(bytes, offset, length)) return null
  const hex = `#${hexOf(bytes, offset, offset + length, false)}`
  return { hex, css: hex }
}

function intText({ unsigned, signed }) {
  return unsigned === signed ? String(unsigned) : `${unsigned} / ${signed}`
}

/**
 * Everything the inspector shows for one offset. Each entry names the byte
 * range it was decoded from; `value` is null when the bytes run past the end
 * of the file.
 *
 * @typedef {Object} InspectorEntry
 * @property {string} id
 * @property {string} label
 * @property {string|null} value     null: unavailable (past the end of the file)
 * @property {boolean} [invalid]     the bytes are there but do not decode
 * @property {number} start
 * @property {number} length
 * @property {string} [title]
 * @property {string} [color]        CSS colour for an RGB swatch
 * @property {string} [colorAlpha]   CSS colour for an RGBA swatch
 *
 * @returns {InspectorEntry[]}
 */
export function inspect(bytes, offset, littleEndian) {
  const entries = []
  const add = (id, label, length, value, extra = {}) =>
    entries.push({ id, label, start: offset, length, value, ...extra })

  for (const size of [1, 2, 4, 8]) {
    const n = readInt(bytes, offset, size, littleEndian)
    add(`int${size * 8}`, `${size * 8}-bit`, size, n ? intText(n) : null, {
      title: n ? `Unsigned ${n.unsigned}, signed ${n.signed}` : undefined
    })
  }

  for (const size of [4, 8]) {
    const f = readFloat(bytes, offset, size, littleEndian)
    add(`float${size * 8}`, `float${size * 8}`, size, f === null ? null : formatFloat(f, size))
  }

  const first = fits(bytes, offset, 1) ? bytes[offset] : null
  add('bits', 'binary', 1, first === null ? null : formatBits(first))
  add('ascii', 'ASCII', 1, first === null ? null : describeAscii(first))

  const utf8 = readUtf8(bytes, offset)
  if (!utf8) add('utf8', 'UTF-8', 1, null)
  else if ('error' in utf8) add('utf8', 'UTF-8', utf8.length, utf8.error, { invalid: true })
  else add('utf8', 'UTF-8', utf8.length, formatCodePoint(utf8.codePoint))

  // ULEB128 and SLEB128 always consume the same bytes
  const uleb = readLeb128(bytes, offset, false)
  const sleb = readLeb128(bytes, offset, true)
  if (!uleb) add('leb128', 'LEB128', 1, null)
  else if ('error' in uleb) add('leb128', 'LEB128', uleb.length, uleb.error, { invalid: true })
  else {
    add('leb128', 'LEB128', uleb.length, intText({ unsigned: uleb.value, signed: sleb.value }), {
      title: `ULEB128 ${uleb.value}, SLEB128 ${sleb.value} (${uleb.length} byte${uleb.length === 1 ? '' : 's'})`
    })
  }

  const t32 = readInt(bytes, offset, 4, littleEndian)
  if (!t32) add('time32', 'time32', 4, null)
  else {
    const text = formatUnixSeconds(t32.unsigned)
    add('time32', 'time32', 4, text || 'not a date', { invalid: !text, title: 'Unix seconds, shown when between 1980 and 2100' })
  }

  const t64 = readInt(bytes, offset, 8, littleEndian)
  if (!t64) add('time64', 'time64', 8, null)
  else {
    const time = describeTime64(t64.unsigned)
    add('time64', 'time64', 8, time ? `${time.text} (${time.unit})` : 'not a date', {
      invalid: !time,
      title: 'Unix seconds, Unix milliseconds or Windows FILETIME, shown when between 1980 and 2100'
    })
  }

  const dos = readDosDateTime(bytes, offset)
  if (!dos) add('dos', 'DOS time', 4, null)
  else if ('error' in dos) add('dos', 'DOS time', 4, dos.error, { invalid: true, title: 'MS-DOS time word then date word, little-endian' })
  else add('dos', 'DOS time', 4, dos.text, { title: 'MS-DOS time word then date word, little-endian' })

  add('guid', 'GUID', 16, readGuid(bytes, offset, littleEndian), {
    title: littleEndian ? 'Microsoft layout (first three fields little-endian)' : 'RFC 4122 byte order'
  })

  const rgba = readColor(bytes, offset, true)
  const rgb = readColor(bytes, offset, false)
  const color = rgba || rgb
  add('color', 'RGBA', rgba ? 4 : 3, color ? color.hex : null, color
    ? { color: rgb.css, colorAlpha: rgba?.css, title: rgba ? 'Left: RGB, right: RGBA' : 'RGB (no fourth byte for alpha)' }
    : {})

  return entries
}
