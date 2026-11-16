import { detectFormat } from '../formats/index.js'
import { formatBytes, hexBytes, item } from '../formats/shared.js'

/** @typedef {import('./types.js').Analysis} Analysis */

/** Facts available for any file, used for unknown formats and when a parser fails. */
export function genericSummary(bytes, meta = {}) {
  const summary = [
    item('File Size', formatBytes(bytes.length)),
    item('File Type', meta.mimeType || 'application/octet-stream')
  ]
  if (bytes.length > 0) summary.push(item('First Bytes', `0x${hexBytes(bytes, 0, 4)}`))
  return summary
}

// Keeps a byte range inside the file; returns null for ranges that cannot be shown
function clipRange(range, size) {
  const { offset, length } = range
  if (!Number.isSafeInteger(offset) || !Number.isFinite(length) || offset < 0 || offset >= size || length <= 0) return null
  return { ...range, length: Math.min(Math.floor(length), size - offset) }
}

function cleanFields(fields, size) {
  if (!Array.isArray(fields)) return []
  const result = []
  for (const field of fields) {
    const clipped = field && clipRange(field, size)
    if (!clipped) continue
    for (const key of Object.keys(clipped)) {
      if (clipped[key] === undefined) delete clipped[key]
    }
    if (clipped.children) clipped.children = cleanFields(clipped.children, size)
    result.push(clipped)
  }
  return result
}

function cleanRegions(regions, size) {
  if (!Array.isArray(regions)) return []
  return regions
    .map(region => region && clipRange(region, size))
    .filter(Boolean)
    .sort((a, b) => a.offset - b.offset)
}

const asArray = value => (Array.isArray(value) ? value : [])

/**
 * Identifies and parses a file. Pure and synchronous; never throws.
 * @param {Uint8Array | ArrayBuffer} input
 * @param {import('./types.js').FileMeta} [meta]
 * @returns {Analysis}
 */
export function analyzeBytes(input, meta = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || new ArrayBuffer(0))
  /** @type {Analysis} */
  const analysis = {
    formatId: 'unknown',
    formatName: 'Unknown format',
    category: 'unknown',
    summary: [],
    fields: [],
    regions: [],
    symbols: [],
    entries: [],
    warnings: []
  }

  let format = null
  try {
    format = detectFormat(bytes)
  } catch (err) {
    analysis.warnings.push(`Error detecting file type: ${err.message}`)
  }
  if (!format) {
    analysis.summary = genericSummary(bytes, meta)
    return analysis
  }

  analysis.formatId = format.id
  analysis.formatName = format.name
  analysis.category = format.category

  let partial
  try {
    partial = format.parse(bytes, meta) || {}
  } catch (err) {
    analysis.summary = genericSummary(bytes, meta)
    analysis.warnings.push(`Error analyzing file: ${err && err.message ? err.message : String(err)}`)
    return analysis
  }

  if (typeof partial.formatName === 'string' && partial.formatName) analysis.formatName = partial.formatName
  analysis.summary = asArray(partial.summary)
  analysis.fields = cleanFields(partial.fields, bytes.length)
  analysis.regions = cleanRegions(partial.regions, bytes.length)
  analysis.symbols = asArray(partial.symbols)
  analysis.entries = asArray(partial.entries)
  analysis.warnings.push(...asArray(partial.warnings))
  return analysis
}
