import { createDiffer } from './diff.js'
import { findShift } from './shift.js'

// Protocol (see compareJob.js):
//   { type: 'begin', params }                    starts a comparison
//   { type: 'chunk', a, b, offset, last }        equal-length chunks of A and B
//   { type: 'shift', a, b }                      windows from the divergence on
// Replies: 'progress' after each chunk (also the acknowledgement), 'done'
// after the last one, 'shift' with the result.

let differ = null

function post(message) {
  const { ranges } = message
  self.postMessage(message, ranges ? [ranges.starts.buffer, ranges.ends.buffer, ranges.diffs.buffer] : [])
}

self.onmessage = (event) => {
  const message = event.data || {}
  if (message.type === 'begin') {
    differ = createDiffer(message.params)
  } else if (message.type === 'chunk') {
    differ.push(new Uint8Array(message.a), new Uint8Array(message.b), message.offset)
    if (message.last) {
      const stats = differ.finish()
      post({ type: 'done', stats, ranges: differ.takeRanges() })
    } else {
      post({ type: 'progress', stats: differ.stats(), ranges: differ.takeRanges() })
    }
  } else if (message.type === 'shift') {
    self.postMessage({ type: 'shift', shift: findShift(new Uint8Array(message.a), new Uint8Array(message.b)) })
  }
}
