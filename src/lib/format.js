// Short text forms of offsets and lengths, as the structure views show them.

/** `0x` and upper-case hex, no padding: 0x1F40 */
export function formatOffset(n) {
  return `0x${n.toString(16).toUpperCase()}`
}

/** A byte count in words: 1 byte, 8,000 bytes */
export function formatLength(n) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'byte' : 'bytes'}`
}
