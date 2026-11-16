// Small byte helpers shared by the validators. Pure; no DOM.

export const u16le = (b, i) => b[i] | (b[i + 1] << 8)
export const u16be = (b, i) => (b[i] << 8) | b[i + 1]
export const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
export const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
export const u64le = (b, i) => u32le(b, i) + u32le(b, i + 4) * 0x100000000
export const u64be = (b, i) => u32be(b, i) * 0x100000000 + u32be(b, i + 4)

/** Bytes of a latin-1 string, for writing signatures readably. */
export const fromLatin1 = (text) => Uint8Array.from(text, c => c.charCodeAt(0))

export function latin1(b, i, length) {
  let s = ''
  for (let k = 0; k < length && i + k < b.length; k++) s += String.fromCharCode(b[i + k])
  return s
}

export function startsWithAt(b, i, pattern) {
  if (i < 0 || i + pattern.length > b.length) return false
  for (let k = 0; k < pattern.length; k++) if (b[i + k] !== pattern[k]) return false
  return true
}

/** Printable ASCII (space to tilde). */
export const isPrint = (v) => v >= 0x20 && v <= 0x7E

export function allPrint(b, i, length) {
  if (i + length > b.length) return false
  for (let k = 0; k < length; k++) if (!isPrint(b[i + k])) return false
  return true
}

/** A four-character code made of letters, digits, spaces or a few punctuation marks. */
export function isFourCC(b, i) {
  if (i + 4 > b.length) return false
  for (let k = 0; k < 4; k++) {
    const v = b[i + k]
    const ok = (v >= 0x30 && v <= 0x39) || (v >= 0x41 && v <= 0x5A) || (v >= 0x61 && v <= 0x7A) || v === 0x20 || v === 0x5F || v === 0x2D || v === 0xA9
    if (!ok) return false
  }
  return true
}

export function allZero(b, i, length) {
  for (let k = 0; k < length; k++) if (b[i + k] !== 0) return false
  return true
}

/** Parses an ASCII octal number as used by tar and cpio (spaces and NULs end it). */
export function octal(b, i, length) {
  let value = 0
  let digits = 0
  let k = 0
  while (k < length && b[i + k] === 0x20) k++
  for (; k < length; k++) {
    const v = b[i + k]
    if (v === 0 || v === 0x20) break
    if (v < 0x30 || v > 0x37) return -1
    value = value * 8 + (v - 0x30)
    digits++
  }
  return digits ? value : -1
}

/** Parses a fixed-width ASCII hex field; -1 when any character is not a hex digit. */
export function hexField(b, i, length) {
  let value = 0
  for (let k = 0; k < length; k++) {
    const v = b[i + k]
    let d
    if (v >= 0x30 && v <= 0x39) d = v - 0x30
    else if (v >= 0x41 && v <= 0x46) d = v - 0x37
    else if (v >= 0x61 && v <= 0x66) d = v - 0x57
    else return -1
    value = value * 16 + d
  }
  return value
}

export const isPowerOfTwo = (n) => n > 0 && Number.isSafeInteger(n) && (n & (n - 1)) === 0 && n <= 0x40000000

/** Adler-32 (zlib). Pass the previous result as `adler` to continue. */
export function adler32(b, start = 0, end = b.length, adler = 1) {
  let a = adler & 0xFFFF
  let s = adler >>> 16
  let i = start
  while (i < end) {
    const stop = Math.min(end, i + 3800)
    for (; i < stop; i++) {
      a += b[i]
      s += a
    }
    a %= 65521
    s %= 65521
  }
  return ((s << 16) | a) >>> 0
}
