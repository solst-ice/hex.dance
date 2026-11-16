// Random access to the file's bytes for the validators. In the worker the
// bytes live on the main thread and are fetched in windows on demand; in
// tests they are a plain array. Reads come back as views into cached
// windows, so most of them cost nothing.

const MIN_FETCH = 256 << 10

export class ByteSource {
  /**
   * @param {number} size
   * @param {(start: number, end: number) => Promise<Uint8Array>|Uint8Array} fetch   bytes [start, end)
   * @param {{ cacheBytes?: number }} [options]
   */
  constructor(size, fetch, { cacheBytes = 48 << 20 } = {}) {
    this.size = size
    this.fetch = fetch
    this.cacheBytes = cacheBytes
    /** @type {Array<{ base: number, buf: Uint8Array }>} most recently used last */
    this.windows = []
    this.pinned = null
    this.fetched = 0
  }

  /** Makes a window readable without a fetch while it is current (the prefilter's chunk). */
  pin(buf, base) {
    this.pinned = buf ? { base, buf } : null
  }

  /** Bytes [start, start + length) clipped to the file, if already cached; else null. */
  peek(start, length) {
    const end = Math.min(this.size, start + length)
    if (start < 0 || start > end) return new Uint8Array(0)
    const pinned = this.pinned
    if (pinned && start >= pinned.base && end <= pinned.base + pinned.buf.length) {
      return pinned.buf.subarray(start - pinned.base, end - pinned.base)
    }
    for (let i = this.windows.length - 1; i >= 0; i--) {
      const w = this.windows[i]
      if (start >= w.base && end <= w.base + w.buf.length) {
        if (i !== this.windows.length - 1) {
          this.windows.splice(i, 1)
          this.windows.push(w)
        }
        return w.buf.subarray(start - w.base, end - w.base)
      }
    }
    return null
  }

  /**
   * Bytes [start, start + length) clipped to the file.
   * @returns {Promise<Uint8Array>}
   */
  async read(start, length) {
    const hit = this.peek(start, length)
    if (hit) return hit
    const end = Math.min(this.size, start + length)
    const fetchEnd = Math.min(this.size, Math.max(end, start + MIN_FETCH))
    const buf = await this.fetch(start, fetchEnd)
    this.fetched += buf.length
    this.windows.push({ base: start, buf })
    let total = this.windows.reduce((sum, w) => sum + w.buf.length, 0)
    while (this.windows.length > 1 && total > this.cacheBytes) total -= this.windows.shift().buf.length
    return buf.subarray(0, end - start)
  }
}

/** A ByteSource over bytes already in memory. */
export function memorySource(bytes) {
  return new ByteSource(bytes.length, (start, end) => bytes.subarray(start, end))
}

/**
 * Sequential reading for walkers: `await r.need(pos, n)` makes
 * `r.buf[pos - r.base]` … valid for n bytes (fewer at the end of the file;
 * check `r.has(pos, n)`).
 */
export class Reader {
  constructor(source, windowSize = 1 << 20) {
    this.source = source
    this.windowSize = windowSize
    this.buf = new Uint8Array(0)
    this.base = 0
  }

  has(pos, n) {
    return pos >= this.base && pos + n <= this.base + this.buf.length
  }

  async need(pos, n) {
    if (this.has(pos, n)) return true
    if (pos < 0 || pos >= this.source.size) {
      this.buf = new Uint8Array(0)
      this.base = Math.max(0, pos)
      return false
    }
    this.buf = await this.source.read(pos, Math.max(n, this.windowSize))
    this.base = pos
    return this.has(pos, n)
  }

  u8(pos) {
    return this.buf[pos - this.base]
  }
}

/**
 * Finds the next occurrence of `pattern` at or after `from` and before `limit`.
 * @returns {Promise<number>} its offset, or -1 (also when `isExpired` says to stop)
 */
export async function findForward(source, from, pattern, limit, isExpired) {
  const step = 1 << 20
  const n = pattern.length
  const first = pattern[0]
  for (let pos = from; pos < Math.min(limit, source.size); pos += step) {
    if (isExpired && isExpired()) return -1
    const buf = await source.read(pos, step + n - 1)
    const stop = Math.min(buf.length - n + 1, limit - pos)
    let i = buf.indexOf(first)
    while (i >= 0 && i < stop) {
      let k = 1
      while (k < n && buf[i + k] === pattern[k]) k++
      if (k === n) return pos + i
      i = buf.indexOf(first, i + 1)
    }
  }
  return -1
}
