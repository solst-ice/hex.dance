// Stage one of the scan: a cheap pass over every byte that finds where a
// signature key matches. Keys are indexed by their first two bytes, so most
// positions cost one table lookup.

import { SIGNATURES, MAX_KEY_LENGTH } from './signatures.js'
import { fromLatin1 } from './bytes.js'

/**
 * @param {import('./signatures.js').Signature[]} [signatures]
 */
export function createPrefilter(signatures = SIGNATURES) {
  // slots[first two bytes] -> 1-based slot; third[slot * 256 + third byte] says whether any key can match
  const slots = new Uint8Array(65536)
  /** @type {Array<Array<{ id: string, bytes: Uint8Array, at: number }>>} */
  const lists = []
  const keys = signatures.flatMap(signature => signature.keys.map(key => ({ id: signature.id, bytes: fromLatin1(key.bytes), at: key.at || 0 })))
  for (const key of keys) {
    if (key.bytes.length < 2) throw new Error(`Key for ${key.id} is shorter than two bytes`)
    const v = (key.bytes[0] << 8) | key.bytes[1]
    if (!slots[v]) {
      lists.push([])
      slots[v] = lists.length
    }
    lists[slots[v] - 1].push(key)
  }
  if (lists.length > 255) throw new Error('Too many distinct two-byte key prefixes')
  const third = new Uint8Array((lists.length + 1) * 256)
  lists.forEach((list, k) => {
    for (const key of list) {
      if (key.bytes.length === 2) third.fill(1, (k + 1) * 256, (k + 2) * 256)
      else third[(k + 1) * 256 + key.bytes[2]] = 1
    }
  })
  const maxKeyLength = Math.max(2, ...signatures.flatMap(s => s.keys.map(k => k.bytes.length)))

  /**
   * Reports every key whose first byte lies in buf[from, to). A key that runs
   * past the end of `buf` is not reported, so callers give each chunk at
   * least `maxKeyLength - 1` bytes of lookahead (or the end of the file).
   * @param {Uint8Array} buf
   * @param {number} base   file offset of buf[0]
   * @param {number} from
   * @param {number} to
   * @param {(id: string, start: number, keyOffset: number) => void} onMatch
   *   `start` is where the marked file would begin (key offset minus `at`)
   */
  function scan(buf, base, from, to, onMatch) {
    const last = Math.min(to, buf.length - 1)
    if (from >= last) return
    let v = buf[from]
    for (let p = from; p < last; p++) {
      v = ((v << 8) | buf[p + 1]) & 0xFFFF
      const slot = slots[v]
      if (slot === 0 || third[(slot << 8) | buf[p + 2]] === 0) continue
      const list = lists[slot - 1]
      for (let k = 0; k < list.length; k++) {
        const key = list[k]
        const bytes = key.bytes
        const n = bytes.length
        if (p + n > buf.length) continue
        let match = true
        for (let j = 2; j < n; j++) {
          if (buf[p + j] !== bytes[j]) {
            match = false
            break
          }
        }
        if (!match) continue
        const start = base + p - key.at
        if (start >= 0) onMatch(key.id, start, base + p)
      }
    }
  }

  return { scan, maxKeyLength }
}

/**
 * Runs the prefilter over [0, size) in chunks fetched with `read`, so the
 * whole file never has to be in one buffer. Each chunk is read with enough
 * lookahead that a key straddling two chunks is found exactly once.
 * @param {(start: number, end: number) => Promise<Uint8Array>|Uint8Array} read
 * @param {number} size
 * @param {{ prefilter?: ReturnType<typeof createPrefilter>, chunkSize?: number, lookahead?: number,
 *   onChunk?: (buf: Uint8Array, base: number, end: number) => Promise<void>|void,
 *   onMatch: (id: string, start: number, keyOffset: number) => void,
 *   isCancelled?: () => boolean }} options
 *   `onChunk` runs after each chunk's matches are reported (validation happens there)
 */
export async function prefilterRange(read, size, { prefilter = createPrefilter(), chunkSize = 4 << 20, lookahead = MAX_KEY_LENGTH, onChunk, onMatch, isCancelled }) {
  const extra = Math.max(lookahead, prefilter.maxKeyLength - 1)
  for (let pos = 0; pos < size; pos += chunkSize) {
    if (isCancelled?.()) return
    const end = Math.min(size, pos + chunkSize)
    const buf = await read(pos, Math.min(size, end + extra))
    prefilter.scan(buf, pos, 0, end - pos, onMatch)
    if (onChunk) await onChunk(buf, pos, end)
  }
}
