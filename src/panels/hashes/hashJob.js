import { streamToWorker } from './chunkStream.js'

// SHA-512 is the slowest by far, so large inputs are split over two workers
// with roughly equal work.
const GROUPS = [['md5', 'sha1', 'sha256'], ['sha512', 'crc32']]
const SPLIT_ABOVE = 8 << 20

/**
 * Hashes bytes[start, end) with every algorithm off the main thread.
 * @param {Object} options
 * @param {Uint8Array} options.bytes
 * @param {number} options.start
 * @param {number} options.end
 * @param {(fraction: number) => void} options.onProgress
 * @param {(hashes: Record<string, string>) => void} options.onDone
 * @param {(error: Error) => void} options.onError
 * @returns {{ cancel: () => void }}
 */
export function startHashing({ bytes, start, end, onProgress, onDone, onError }) {
  const groups = end - start > SPLIT_ABOVE ? GROUPS : [GROUPS.flat()]
  const positions = groups.map(() => start)
  const hashes = {}
  let remaining = groups.length
  let jobs = []
  const cancel = () => jobs.forEach(job => job.cancel())

  jobs = groups.map((algorithms, index) => streamToWorker({
    createWorker: () => new Worker(new URL('./hashes.worker.js', import.meta.url), { type: 'module' }),
    bytes,
    start,
    end,
    params: { algorithms },
    onMessage(message) {
      if (message.type === 'progress') {
        positions[index] = message.position
        const total = (end - start) * groups.length
        onProgress(total ? positions.reduce((sum, p) => sum + p - start, 0) / total : 1)
      } else if (message.type === 'done') {
        Object.assign(hashes, message.hashes)
        if (--remaining === 0) onDone(hashes)
      }
    },
    onError(error) {
      cancel()
      onError(error)
    }
  }))
  return { cancel }
}
