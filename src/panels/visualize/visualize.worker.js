import { createAccumulator } from './stats.js'
import { createMagicScanner } from './magic.js'

// Messages in:
//   { type: 'start', size }
//   { type: 'chunk', offset, contiguous, buffer }
//   { type: 'end' }
// Messages out:
//   { type: 'ack' }                        after each chunk, so the sender can send the next
//   { type: 'progress', bytesSeen, digraph, classCounts }
//   { type: 'done', bytesSeen, digraph, classCounts, magic }
// classCounts holds the byte-class counts per Hilbert cell; the page colours
// them, so a theme change does not need another pass over the file.

const PROGRESS_MS = 250

let acc = null
let scanner = null
let lastProgress = 0

function snapshot(type, extra) {
  const digraph = acc.digraph.slice()
  const classCounts = acc.classCounts.slice()
  self.postMessage({ type, bytesSeen: acc.bytesSeen, digraph, classCounts, ...extra }, [digraph.buffer, classCounts.buffer])
}

self.onmessage = (event) => {
  const message = event.data || {}
  if (message.type === 'start') {
    acc = createAccumulator(message.size)
    scanner = createMagicScanner()
    // the first chunk reports at once, so something is drawn straight away
    lastProgress = performance.now() - PROGRESS_MS
  } else if (message.type === 'chunk' && acc) {
    const chunk = new Uint8Array(message.buffer)
    acc.add(chunk, message.offset, message.contiguous)
    scanner.scan(chunk, message.offset, message.contiguous)
    self.postMessage({ type: 'ack' })
    const now = performance.now()
    if (now - lastProgress > PROGRESS_MS) {
      lastProgress = now
      snapshot('progress')
    }
  } else if (message.type === 'end' && acc) {
    snapshot('done', { magic: scanner.results() })
    acc = null
    scanner = null
  }
}
