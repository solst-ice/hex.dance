/**
 * Byte statistics: Shannon entropy per block and a whole-file histogram,
 * computed incrementally so the work can be streamed through a worker.
 */

export const MIN_BLOCK = 256
export const MAX_POINTS = 2048

/**
 * Smallest power-of-two block size (at least MIN_BLOCK) that keeps the
 * graph at or under `maxPoints` points.
 */
export function chooseBlockSize(size, maxPoints = MAX_POINTS) {
  let block = MIN_BLOCK
  while (Math.ceil(size / block) > maxPoints) block *= 2
  return block
}

/** Shannon entropy in bits per byte of a 256-bin histogram over `total` bytes. */
export function entropyOf(counts, total) {
  if (total <= 0) return 0
  let sum = 0
  for (let i = 0; i < 256; i++) {
    const c = counts[i]
    if (c > 0) sum += c * Math.log2(c)
  }
  // H = log2(N) - (1/N) Σ c log2 c
  return Math.max(0, Math.log2(total) - sum / total)
}

export class ByteStats {
  /**
   * @param {number} size        total bytes that will be fed
   * @param {number} blockSize
   */
  constructor(size, blockSize = chooseBlockSize(size)) {
    this.size = size
    this.blockSize = blockSize
    this.points = Math.ceil(size / blockSize)
    this.entropy = new Float32Array(this.points)
    // Share of zero bytes per block, 0–255
    this.zeros = new Uint8Array(this.points)
    this.histogram = new Float64Array(256)
    this.block = new Uint32Array(256)
    this.blockFill = 0
    this.done = 0 // completed blocks
    this.fed = 0
  }

  update(bytes, start = 0, end = bytes.length) {
    const block = this.block
    const blockSize = this.blockSize
    let i = start
    while (i < end) {
      const take = Math.min(end - i, blockSize - this.blockFill)
      const stop = i + take
      for (; i < stop; i++) block[bytes[i]]++
      this.blockFill += take
      if (this.blockFill === blockSize) this.closeBlock()
    }
    this.fed += end - start
    if (this.fed >= this.size && this.blockFill > 0) this.closeBlock()
  }

  closeBlock() {
    const block = this.block
    const fill = this.blockFill
    if (this.done < this.points) {
      this.entropy[this.done] = entropyOf(block, fill)
      this.zeros[this.done] = Math.round((block[0] / fill) * 255)
    }
    const histogram = this.histogram
    for (let b = 0; b < 256; b++) histogram[b] += block[b]
    block.fill(0)
    this.blockFill = 0
    this.done++
  }
}

const PRINTABLE_EXTRA = new Set([0x09, 0x0a, 0x0d])

/**
 * Summary numbers from a histogram.
 * @param {ArrayLike<number>} histogram
 */
export function summarize(histogram) {
  let total = 0
  let printable = 0
  let high = 0
  for (let b = 0; b < 256; b++) {
    const c = histogram[b]
    total += c
    if ((b >= 0x20 && b < 0x7f) || PRINTABLE_EXTRA.has(b)) printable += c
    else if (b >= 0x80) high += c
  }
  const order = Array.from({ length: 256 }, (_, b) => b).sort((a, b) => histogram[b] - histogram[a] || a - b)
  const missing = order.filter(b => histogram[b] === 0)
  const present = order.filter(b => histogram[b] > 0)
  return {
    total,
    entropy: entropyOf(histogram, total),
    zeroShare: total ? histogram[0] / total : 0,
    printableShare: total ? printable / total : 0,
    highShare: total ? high / total : 0,
    distinct: present.length,
    mostCommon: present.slice(0, 5),
    leastCommon: present.slice(-5).reverse(),
    missing
  }
}

/**
 * Plain-language reading of the statistics.
 * @param {{ size: number, blockSize: number, entropy: ArrayLike<number>, zeros: ArrayLike<number> }} stats
 * @param {ReturnType<typeof summarize>} summary
 * @returns {string[]} sentences, most important first
 */
export function describe(stats, summary) {
  const { size, blockSize, entropy, zeros } = stats
  if (size === 0) return ['The file is empty.']
  const out = []
  const blocks = entropy.length
  // Even uniformly random bytes measure below 8 bits in a short block (by
  // about 255 / (2n ln 2) for n bytes), so "high" is judged against that
  const lastBlock = size - (blocks - 1) * blockSize
  const randomLevel = (n) => Math.min(8, Math.log2(n)) - 255 / (2 * n * Math.LN2)
  const highFull = randomLevel(blockSize) - 0.3
  const highLast = randomLevel(lastBlock) - 0.3
  let high = 0
  let dense = 0
  let zeroBlocks = 0
  let low = 0
  for (let i = 0; i < blocks; i++) {
    const e = entropy[i]
    const level = i === blocks - 1 ? highLast : highFull
    if (e >= level && e > 5) high++
    else if (e >= level - 1 && e > 5) dense++
    if (zeros[i] === 255) zeroBlocks++
    else if (e < 1) low++
  }
  const share = (n) => `${Math.round((n / blocks) * 100)}%`

  if (size < 64) out.push('The file is too small for its entropy to say much.')
  if (summary.printableShare >= 0.95) {
    out.push(summary.entropy > 6 ? 'Mostly text, with an unusually varied character mix (maybe encoded data).' : 'Mostly text.')
  } else if (high / blocks >= 0.9) {
    out.push('Looks compressed or encrypted throughout.')
  } else if (high / blocks >= 0.2) {
    out.push(`Partly compressed or encrypted: ${share(high)} of the file has near-maximum entropy.`)
  } else if (summary.entropy < 1 && summary.zeroShare > 0.9) {
    out.push('Almost entirely zero bytes.')
  } else if ((high + dense) / blocks >= 0.8) {
    out.push('Dense data throughout, fairly high entropy but not random-looking (such as compressed media or packed code).')
  } else {
    out.push('Mixed content with structure, typical of executables and binary data.')
  }
  if (zeroBlocks / blocks >= 0.1 && !(summary.entropy < 1 && summary.zeroShare > 0.9)) {
    out.push(`Large zero-filled areas: ${share(zeroBlocks)} of the file.`)
  }
  if (low / blocks >= 0.1) out.push(`${share(low)} of the file is low-entropy padding or repeated bytes.`)
  return out
}
