import { StringScanner } from './scan.js'
import { classify } from './classify.js'
import { acceptChunks } from '../../lib/chunkStream.js'

// Columns of the strings found since the last message
let batch = null
let scanner = null
let limits = null
let stored = 0
let storedChars = 0
let total = 0
// Offset of the first string that was found but not kept, once a cap is hit
let cappedAt = -1

function newBatch() {
  return { offsets: [], lengths: [], encodings: [], classes: [], texts: [] }
}

function keep(offset, encoding, length, text) {
  total++
  if (cappedAt >= 0) return
  if (stored >= limits.maxStrings || storedChars + text.length > limits.maxChars) {
    cappedAt = offset
    return
  }
  stored++
  storedChars += text.length
  batch.offsets.push(offset)
  batch.lengths.push(length)
  batch.encodings.push(encoding)
  batch.classes.push(classify(text))
  batch.texts.push(text)
}

function post(type, position) {
  const { offsets, lengths, encodings, classes, texts } = batch
  const columns = {
    offsets: Float64Array.from(offsets),
    lengths: Float64Array.from(lengths),
    encodings: Uint8Array.from(encodings),
    classes: Uint8Array.from(classes)
  }
  self.postMessage(
    { type, position, total, cappedAt, ...columns, texts },
    [columns.offsets.buffer, columns.lengths.buffer, columns.encodings.buffer, columns.classes.buffer]
  )
  batch = newBatch()
}

acceptChunks({
  begin({ minLength, maxText, maxStrings, maxChars }) {
    limits = { maxStrings, maxChars }
    batch = newBatch()
    stored = 0
    storedChars = 0
    total = 0
    cappedAt = -1
    scanner = new StringScanner({ minLength, maxText, onString: keep })
  },
  chunk(bytes, offset, from, last) {
    scanner.push(bytes, offset, from)
    if (last) {
      scanner.finish()
      post('done', offset + bytes.length)
    } else {
      post('batch', offset + bytes.length)
    }
  }
})
