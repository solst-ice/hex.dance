// Well-known hexspeak and magic constants, found in either byte order.

/**
 * @typedef {{ hex: string, note: string }} MagicConstant
 */

/** @type {MagicConstant[]} */
export const MAGIC_CONSTANTS = [
  { hex: 'CAFEBABE', note: 'Java class file magic; also the magic of Mach-O universal (fat) binaries.' },
  { hex: 'CAFED00D', note: 'Magic of Java Pack200 compressed archives.' },
  { hex: 'FEEDFACE', note: 'Mach-O magic for 32-bit binaries (stored in the CPU\'s byte order).' },
  { hex: 'FEEDFACF', note: 'Mach-O magic for 64-bit binaries (stored in the CPU\'s byte order).' },
  { hex: 'DEADBEEF', note: 'Classic marker for freed or uninitialised memory; Solaris libumem fills freed buffers with it.' },
  { hex: 'BADDCAFE', note: 'Solaris libumem fill for allocated but uninitialised memory.' },
  { hex: 'BAADF00D', note: 'Windows debug heap fill for memory from LocalAlloc(LMEM_FIXED) that was never written.' },
  { hex: 'FEEEFEEE', note: 'Windows debug heap fill for memory released with HeapFree.' },
  { hex: 'ABABABAB', note: 'Windows debug heap guard bytes after an allocated block.' },
  { hex: 'CDCDCDCD', note: 'MSVC debug CRT fill for new heap memory that was never written.' },
  { hex: 'DDDDDDDD', note: 'MSVC debug CRT fill for freed heap memory.' },
  { hex: 'FDFDFDFD', note: 'MSVC debug CRT "no man\'s land" guard bytes around heap blocks.' },
  { hex: '8BADF00D', note: 'iOS crash report code: the watchdog killed an app that took too long ("ate bad food").' },
  { hex: 'DEAD10CC', note: 'iOS crash report code: app killed for holding a file lock while suspended ("deadlock").' },
  { hex: 'C00010FF', note: 'iOS crash report code: app killed because the device was too hot ("cool off").' },
  { hex: 'DEADDEAD', note: 'Windows bug check code MANUALLY_INITIATED_CRASH1.' },
  { hex: 'DEADC0DE', note: 'OpenWrt firmware marker for where the writable overlay starts.' },
  { hex: '0D15EA5E', note: 'Nintendo GameCube and Wii flag for a normal boot ("zero disease").' },
  { hex: '1BADB002', note: 'Multiboot header magic, which GRUB looks for in a kernel image.' },
  { hex: 'E85250D6', note: 'Multiboot2 header magic.' },
  { hex: 'D00DFEED', note: 'Flattened device tree (.dtb) magic.' },
  { hex: 'BEEFCACE', note: '.NET resources (.resources) file magic.' },
  { hex: 'C0FFEE', note: 'Playful hexspeak with no single standard use. Only 3 bytes, so it also turns up by chance about once per 16 MB.' }
]

export const MAX_OFFSETS_PER_HIT = 200

function hexToBytes(hex) {
  const out = []
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16))
  return out
}

/** Every distinct byte sequence to look for: each constant big-endian and, unless symmetric, little-endian. */
export function magicPatterns(constants = MAGIC_CONSTANTS) {
  const patterns = []
  for (const constant of constants) {
    const be = hexToBytes(constant.hex)
    const le = be.slice().reverse()
    patterns.push({ constant, order: 'BE', bytes: be })
    if (le.some((v, i) => v !== be[i])) patterns.push({ constant, order: 'LE', bytes: le })
  }
  return patterns
}

/** How many times a pattern of `length` bytes would appear by chance in `size` random bytes. */
export function expectedByChance(size, length) {
  return Math.max(0, size - length + 1) / 256 ** length
}

/**
 * Streams chunks through a scan for the magic patterns. Hits of one pattern
 * never overlap, so a run of 0xCD bytes counts once per four bytes.
 */
export function createMagicScanner(constants = MAGIC_CONSTANTS, { maxOffsets = MAX_OFFSETS_PER_HIT } = {}) {
  const patterns = magicPatterns(constants)
  const maxLength = Math.max(...patterns.map(p => p.bytes.length))
  // First byte -> patterns starting with it
  const byFirst = Array.from({ length: 256 }, () => [])
  patterns.forEach((pattern, index) => byFirst[pattern.bytes[0]].push(index))
  const firstMask = new Uint8Array(256)
  for (let v = 0; v < 256; v++) firstMask[v] = byFirst[v].length ? 1 : 0

  const counts = new Array(patterns.length).fill(0)
  const offsets = patterns.map(() => [])
  const nextFree = new Array(patterns.length).fill(0)
  let carry = new Uint8Array(0)
  let carryOffset = 0

  function scanBuffer(buf, base, minEnd) {
    const n = buf.length
    for (let i = 0; i < n; i++) {
      if (!firstMask[buf[i]]) continue
      const list = byFirst[buf[i]]
      for (let k = 0; k < list.length; k++) {
        const p = list[k]
        const bytes = patterns[p].bytes
        const len = bytes.length
        if (i + len > n || i + len <= minEnd) continue
        let match = true
        for (let j = 1; j < len; j++) {
          if (buf[i + j] !== bytes[j]) { match = false; break }
        }
        if (!match) continue
        const at = base + i
        if (at < nextFree[p]) continue
        nextFree[p] = at + len
        counts[p]++
        if (offsets[p].length < maxOffsets) offsets[p].push(at)
      }
    }
  }

  return {
    /** `contiguous`: the chunk follows the previous one directly, so a match may straddle them. */
    scan(chunk, offset, contiguous) {
      if (contiguous && carry.length && carryOffset + carry.length === offset) {
        const joined = new Uint8Array(carry.length + chunk.length)
        joined.set(carry)
        joined.set(chunk, carry.length)
        // Matches lying entirely inside the carried tail were found last time
        scanBuffer(joined, carryOffset, carry.length)
      } else {
        scanBuffer(chunk, offset, 0)
      }
      const keep = Math.min(maxLength - 1, chunk.length)
      carry = chunk.slice(chunk.length - keep)
      carryOffset = offset + chunk.length - keep
    },
    /** Patterns with at least one hit, in the order of MAGIC_CONSTANTS. */
    results() {
      return patterns
        .map((pattern, i) => ({
          hex: pattern.constant.hex,
          note: pattern.constant.note,
          order: pattern.order,
          bytes: pattern.bytes,
          count: counts[i],
          offsets: offsets[i].slice()
        }))
        .filter(hit => hit.count > 0)
    }
  }
}
