/**
 * Incremental string extraction, compatible with GNU `strings -a`:
 * printable ASCII runs (0x20–0x7E and tab), and UTF-16LE runs whose code
 * units are such a character followed by a zero byte, at either byte
 * alignment (`strings -e l`). Input arrives in chunks; runs may span them.
 */

export const ASCII = 0
export const UTF16LE = 1

const PRINTABLE = new Uint8Array(256)
for (let b = 0x20; b < 0x7f; b++) PRINTABLE[b] = 1
PRINTABLE[0x09] = 1

const utf16Decoder = typeof TextDecoder === 'undefined' ? null : new TextDecoder('utf-16le')

function decodeAscii(bytes, from, to) {
  let out = ''
  for (let i = from; i < to; i += 8192) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(to, i + 8192)))
  }
  return out
}

// Every second byte, starting at `from` (the low byte of each code unit)
function decodeUtf16(bytes, from, to) {
  if (utf16Decoder && (to - from) % 2 === 0) return utf16Decoder.decode(bytes.subarray(from, to))
  let out = ''
  for (let i = from; i < to; i += 2) out += String.fromCharCode(bytes[i])
  return out
}

/**
 * @typedef {(offset: number, encoding: number, length: number, text: string) => void} StringSink
 *   `offset` is the absolute byte offset, `length` the length in characters
 *   (UTF-16 runs take 2 bytes per character), `text` at most `maxText` characters
 */

export class StringScanner {
  /**
   * @param {{ minLength?: number, maxText?: number, onString: StringSink }} options
   */
  constructor({ minLength = 5, maxText = 256, onString }) {
    this.minLength = Math.max(1, minLength | 0)
    this.maxText = Math.max(1, maxText | 0)
    this.onString = onString
    this.position = 0 // absolute offset of the next byte to read
    this.last = -1 // the previous byte, for code units that span chunks
    // One run in progress per kind: index 0 ASCII, 1 UTF-16 at even offsets, 2 at odd
    this.runs = [null, null, null]
    this.pending = []
  }

  /**
   * Feeds the next bytes. `bytes[0]` is at absolute `offset`; bytes before
   * `from` have been fed already (callers may repeat the last byte).
   */
  push(bytes, offset = this.position, from = offset) {
    if (from === offset && offset > 0 && this.last >= 0) {
      // Without the repeated byte, a code unit spanning the chunks could not be decoded
      const joined = new Uint8Array(bytes.length + 1)
      joined[0] = this.last
      joined.set(bytes, 1)
      return this.push(joined, offset - 1, from)
    }
    const P = PRINTABLE
    const runs = this.runs
    const n = bytes.length
    let prev = from > offset ? bytes[from - offset - 1] : this.last
    for (let i = from - offset; i < n; i++) {
      const b = bytes[i]
      const pos = offset + i
      if (P[b]) {
        if (runs[0] === null) runs[0] = { start: pos, text: '', next: pos, end: 0, step: 1, encoding: ASCII }
      } else if (runs[0] !== null) {
        this.endRun(0, pos, bytes, offset)
      }
      // The code unit that starts at pos - 1
      if (prev >= 0) {
        const kind = 1 + ((pos - 1) & 1)
        if (b === 0 && P[prev]) {
          if (runs[kind] === null) runs[kind] = { start: pos - 1, text: '', next: pos - 1, end: 0, step: 2, encoding: UTF16LE }
          runs[kind].end = pos + 1
        } else if (runs[kind] !== null) {
          this.endRun(kind, runs[kind].end, bytes, offset)
        }
      }
      prev = b
    }
    this.last = prev
    this.position = offset + n
    // Keep the beginning of runs that continue into the next chunk
    for (const run of runs) {
      if (run === null) continue
      const confirmed = run.step === 1 ? this.position : run.end
      this.extend(run, bytes, offset, confirmed)
    }
    this.flush(false)
  }

  /** Ends the input: reports runs still open and anything held back. */
  finish() {
    for (let kind = 0; kind < 3; kind++) {
      const run = this.runs[kind]
      if (run !== null) this.endRun(kind, run.step === 1 ? this.position : run.end, null, 0)
    }
    this.flush(true)
  }

  extend(run, bytes, offset, to) {
    const limit = Math.min(to, run.start + this.maxText * run.step)
    if (run.next >= limit || bytes === null) return
    const from = run.next - offset
    run.text += run.step === 1 ? decodeAscii(bytes, from, limit - offset) : decodeUtf16(bytes, from, limit - offset)
    run.next = limit
  }

  endRun(kind, end, bytes, offset) {
    const run = this.runs[kind]
    this.runs[kind] = null
    const length = (end - run.start) / run.step
    if (length < this.minLength) return
    if (bytes !== null) this.extend(run, bytes, offset, end)
    this.pending.push(run.start, run.encoding, length, run.text)
  }

  // Strings are reported in offset order: a string is held back while a run
  // that started before it is still open.
  flush(all) {
    const pending = this.pending
    if (pending.length === 0) return
    let limit = Infinity
    if (!all) for (const run of this.runs) if (run !== null && run.start < limit) limit = run.start
    const items = []
    const kept = []
    for (let i = 0; i < pending.length; i += 4) {
      (pending[i] < limit ? items : kept).push(i)
    }
    if (items.length === 0) return
    items.sort((a, b) => pending[a] - pending[b])
    for (const i of items) this.onString(pending[i], pending[i + 1], pending[i + 2], pending[i + 3])
    const rest = []
    for (const i of kept) rest.push(pending[i], pending[i + 1], pending[i + 2], pending[i + 3])
    this.pending = rest
  }
}

/** Convenience for small inputs and tests: all strings of a buffer. */
export function extractStrings(bytes, options = {}) {
  const out = []
  const scanner = new StringScanner({
    ...options,
    onString: (offset, encoding, length, text) => out.push({ offset, encoding, length, text })
  })
  scanner.push(bytes, 0)
  scanner.finish()
  return out
}

/** Decodes a whole string from the bytes, for copying. */
export function readString(bytes, offset, encoding, length) {
  const end = Math.min(bytes.length, offset + length * (encoding === UTF16LE ? 2 : 1))
  return encoding === UTF16LE ? decodeUtf16(bytes, offset, end - ((end - offset) & 1)) : decodeAscii(bytes, offset, end)
}
