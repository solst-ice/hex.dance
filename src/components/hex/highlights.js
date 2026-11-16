// Turns possibly overlapping highlight ranges into sorted, non-overlapping
// segments so any window of bytes can be looked up with a binary search.
// Where ranges overlap, the shortest one wins (the innermost of nested
// ranges); between ranges of equal length, the later one in the array wins.

const EMPTY = Object.freeze({ segments: Object.freeze([]) })

function beats(a, b) {
  const la = a.end - a.start
  const lb = b.end - b.start
  return la < lb || (la === lb && a.index > b.index)
}

class Heap {
  constructor() { this.items = [] }
  get size() { return this.items.length }
  peek() { return this.items[0] }
  push(item) {
    const a = this.items
    a.push(item)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!beats(a[i], a[p])) break
      ;[a[i], a[p]] = [a[p], a[i]]
      i = p
    }
  }
  pop() {
    const a = this.items
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && beats(a[l], a[m])) m = l
        if (r < a.length && beats(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}

export function buildHighlightIndex(highlights) {
  if (!Array.isArray(highlights) || highlights.length === 0) return EMPTY
  const ranges = []
  highlights.forEach((h, index) => {
    if (!h) return
    const start = Math.floor(Number(h.start))
    const end = Math.floor(Number(h.end))
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return
    ranges.push({ start: Math.max(0, start), end, index, highlight: h })
  })
  if (!ranges.length) return EMPTY
  ranges.sort((a, b) => a.start - b.start)

  const bounds = new Set()
  for (const r of ranges) { bounds.add(r.start); bounds.add(r.end) }
  const points = [...bounds].sort((a, b) => a - b)

  const segments = []
  const heap = new Heap()
  let next = 0
  for (let i = 0; i < points.length - 1; i++) {
    const x = points[i]
    while (next < ranges.length && ranges[next].start <= x) heap.push(ranges[next++])
    while (heap.size && heap.peek().end <= x) heap.pop()
    if (!heap.size) continue
    const winner = heap.peek().highlight
    const prev = segments[segments.length - 1]
    if (prev && prev.highlight === winner && prev.end === x) prev.end = points[i + 1]
    else segments.push({ start: x, end: points[i + 1], highlight: winner })
  }
  return { segments }
}

// Index of the first segment that ends after `offset`
function firstEndingAfter(segments, offset) {
  let lo = 0
  let hi = segments.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].end <= offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function segmentsIn(index, start, end) {
  const { segments } = index
  if (!segments.length) return segments
  const out = []
  for (let i = firstEndingAfter(segments, start); i < segments.length && segments[i].start < end; i++) {
    out.push(segments[i])
  }
  return out
}

export function highlightAt(index, offset) {
  const { segments } = index
  const i = firstEndingAfter(segments, offset)
  return i < segments.length && segments[i].start <= offset ? segments[i].highlight : null
}
