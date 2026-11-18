import { CLASSES } from './classify.js'

/**
 * Column store for extracted strings on the main thread. Batches arrive
 * from the worker already in offset order and are appended.
 */
export class StringStore {
  constructor() {
    this.count = 0
    this.capacity = 0
    this.offsets = new Float64Array(0)
    this.lengths = new Float64Array(0)
    this.encodings = new Uint8Array(0)
    this.classes = new Uint8Array(0)
    this.texts = []
    /** strings per class bit, indexed like CLASSES */
    this.classCounts = CLASSES.map(() => 0)
    this.encodingCounts = [0, 0]
  }

  grow(needed) {
    if (needed <= this.capacity) return
    const capacity = Math.max(needed, this.capacity * 2, 4096)
    const resize = (Type, old) => {
      const next = new Type(capacity)
      next.set(old.subarray(0, this.count))
      return next
    }
    this.offsets = resize(Float64Array, this.offsets)
    this.lengths = resize(Float64Array, this.lengths)
    this.encodings = resize(Uint8Array, this.encodings)
    this.classes = resize(Uint8Array, this.classes)
    this.capacity = capacity
  }

  /** @param {{ offsets: ArrayLike<number>, lengths: ArrayLike<number>, encodings: ArrayLike<number>, classes: ArrayLike<number>, texts: string[] }} batch */
  append(batch) {
    const n = batch.texts.length
    if (n === 0) return
    this.grow(this.count + n)
    this.offsets.set(batch.offsets, this.count)
    this.lengths.set(batch.lengths, this.count)
    this.encodings.set(batch.encodings, this.count)
    this.classes.set(batch.classes, this.count)
    for (let i = 0; i < n; i++) {
      this.texts.push(batch.texts[i])
      this.encodingCounts[batch.encodings[i]]++
      const mask = batch.classes[i]
      if (mask) CLASSES.forEach((c, k) => { if (mask & c.bit) this.classCounts[k]++ })
    }
    this.count += n
  }

  byteLength(i) {
    return this.lengths[i] * (this.encodings[i] === 1 ? 2 : 1)
  }
}

/**
 * Builds a predicate over store indices.
 * `query` is a case-insensitive substring, or a regular expression written
 * as /pattern/flags.
 *
 * A regular expression can take any time on one string, so the panel does
 * not run `test` for one: it runs `regex` in a worker (regexFilter.js) over
 * the strings that pass `prefilter`, the class and encoding part.
 * @returns {{
 *   test: ((store: StringStore, i: number) => boolean) | null,
 *   error: string | null,
 *   regex: { source: string, flags: string } | null,
 *   prefilter: ((store: StringStore, i: number) => boolean) | null
 * }}
 *   `test` is null when everything matches
 */
export function compileFilter({ query = '', classBit = 0, encoding = -1 }) {
  let textTest = null
  let error = null
  let regex = null
  const written = /^\/(.+)\/([a-z]*)$/s.exec(query)
  if (written) {
    try {
      const re = new RegExp(written[1], written[2].replace(/[gy]/g, '') || 'i')
      regex = { source: re.source, flags: re.flags }
      textTest = (store, i) => re.test(store.texts[i])
    } catch (err) {
      error = err.message
    }
  } else if (query) {
    if (/[a-z]/i.test(query)) {
      const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      textTest = (store, i) => re.test(store.texts[i])
    } else {
      textTest = (store, i) => store.texts[i].includes(query)
    }
  }
  const prefilter = classBit || encoding >= 0
    ? (store, i) => (!classBit || (store.classes[i] & classBit) !== 0) && (encoding < 0 || store.encodings[i] === encoding)
    : null
  if (!textTest && !prefilter) return { test: null, error, regex, prefilter }
  return {
    error,
    regex,
    prefilter,
    test(store, i) {
      if (prefilter && !prefilter(store, i)) return false
      return textTest ? textTest(store, i) : true
    }
  }
}

/** Appends to `into` the indices in [from, store.count) that pass `test`. */
export function collectMatches(store, test, from, into) {
  for (let i = from; i < store.count; i++) if (test(store, i)) into.push(i)
  return into
}

/** Index in the sorted `list` of the first element >= value. */
export function lowerBound(list, value, count = list.length) {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}
