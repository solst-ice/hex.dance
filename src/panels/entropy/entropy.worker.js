import { ByteStats } from './stats.js'
import { acceptChunks } from '../../lib/chunkStream.js'

let stats = null
let sent = 0

// Sends the blocks finished since the last message, so the graph fills in as it goes
function post(type, position) {
  const from = sent
  const to = Math.min(stats.done, stats.points)
  sent = to
  const message = {
    type,
    position,
    from,
    entropy: stats.entropy.slice(from, to),
    zeros: stats.zeros.slice(from, to)
  }
  const transfer = [message.entropy.buffer, message.zeros.buffer]
  if (type === 'done') {
    message.histogram = Float64Array.from(stats.histogram)
    transfer.push(message.histogram.buffer)
  }
  self.postMessage(message, transfer)
}

acceptChunks({
  begin({ size, blockSize }) {
    stats = new ByteStats(size, blockSize)
    sent = 0
  },
  chunk(bytes, offset, from, last) {
    stats.update(bytes, from - offset)
    post(last ? 'done' : 'progress', offset + bytes.length)
  }
})
