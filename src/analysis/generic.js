import { formatBytes, hexBytes, item } from '../formats/shared.js'

// The facts any file has, kept apart from the parsers so the page can answer
// with them without loading the parsers when the analysis worker gives up.

/** Facts available for any file, used for unknown formats and when a parser fails. */
export function genericSummary(bytes, meta = {}) {
  const summary = [
    item('File Size', formatBytes(bytes.length)),
    item('File Type', meta.mimeType || 'application/octet-stream')
  ]
  if (bytes.length > 0) summary.push(item('First Bytes', `0x${hexBytes(bytes, 0, 4)}`))
  return summary
}

/**
 * A finished analysis holding only the generic facts and one note saying why.
 * `head` holds the file's first bytes and `size` its full length.
 * @param {Uint8Array} head
 * @param {number} size
 * @param {import('./types.js').FileMeta} meta
 * @param {string} note
 * @param {'timeout' | 'crash'} reason
 * @returns {import('./types.js').Analysis}
 */
export function gaveUpAnalysis(head, size, meta, note, reason) {
  const summary = genericSummary(head, meta)
  summary[0] = item('File Size', formatBytes(size))
  return {
    formatId: 'unknown',
    formatName: 'Unknown format',
    category: 'unknown',
    summary,
    fields: [],
    regions: [],
    symbols: [],
    entries: [],
    warnings: [note],
    unusual: [],
    image: null,
    gaveUp: reason
  }
}
