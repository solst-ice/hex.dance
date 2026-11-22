import { detectFormat } from '../formats/index.js'
import { limitsFor, limitWarning, runParse } from '../formats/budget.js'
import { genericSummary } from './generic.js'
import { revealAnalysis } from './reveal.js'
import { MAX_IMAGE_SECTIONS, MAX_UNUSUAL } from '../formats/pointers.js'

export { genericSummary }

/** @typedef {import('./types.js').Analysis} Analysis */

// Keeps a byte range inside the file; returns null for ranges that cannot be shown
function clipRange(range, size) {
  const { offset, length } = range
  if (!Number.isSafeInteger(offset) || !Number.isFinite(length) || offset < 0 || offset >= size || length <= 0) return null
  return { ...range, length: Math.min(Math.floor(length), size - offset) }
}

/** Exported for tests: what analyzeBytes keeps of a parser's fields, notes and layout */
export function cleanFields(fields, size) {
  if (!Array.isArray(fields)) return []
  const result = []
  for (const field of fields) {
    const clipped = field && clipRange(field, size)
    if (!clipped) continue
    for (const key of Object.keys(clipped)) {
      if (clipped[key] === undefined) delete clipped[key]
    }
    if ('target' in clipped && !(Number.isSafeInteger(clipped.target) && clipped.target >= 0 && clipped.target < size)) delete clipped.target
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

// Characters kept of one unusual note; parsers write one plain sentence
const MAX_NOTE_TEXT = 300
const MAX_FLAGS_TEXT = 8
const MAX_NAME_TEXT = 256
// Entries of a parser's list looked at before the rest is ignored
const MAX_LOOKED_AT = 65536

const isCount = value => Number.isSafeInteger(value) && value >= 0

function cleanText(text, max) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export function cleanUnusual(notes, size) {
  if (!Array.isArray(notes)) return []
  const result = []
  for (let i = 0; i < notes.length && i < MAX_LOOKED_AT && result.length < MAX_UNUSUAL; i++) {
    const note = notes[i]
    const text = note && cleanText(note.text, MAX_NOTE_TEXT)
    if (!text) continue
    const clean = { text }
    if (isCount(note.offset) && note.offset < size) {
      clean.offset = note.offset
      if (Number.isSafeInteger(note.length) && note.length > 0 && note.length <= size - note.offset) clean.length = note.length
    }
    result.push(clean)
  }
  return result
}

export function cleanImage(image, size) {
  if (!image || typeof image !== 'object' || !Array.isArray(image.sections)) return null
  if (image.addressLabel !== 'RVA' && image.addressLabel !== 'address') return null
  const sections = []
  for (let i = 0; i < image.sections.length && i < MAX_LOOKED_AT && sections.length < MAX_IMAGE_SECTIONS; i++) {
    const section = image.sections[i]
    if (!section || ![section.offset, section.size, section.address, section.memSize].every(isCount)) continue
    sections.push({
      name: cleanText(section.name, MAX_NAME_TEXT),
      offset: section.offset,
      size: section.size,
      address: section.address,
      memSize: section.memSize,
      flags: cleanText(section.flags, MAX_FLAGS_TEXT)
    })
  }
  const entry = image.entry && isCount(image.entry.address)
    ? { address: image.entry.address, offset: isCount(image.entry.offset) && image.entry.offset < size ? image.entry.offset : null }
    : null
  const total = isCount(image.total) ? Math.max(image.total, image.sections.length) : image.sections.length
  if (!sections.length && !entry) return null
  return { addressLabel: image.addressLabel, entry, sections, total }
}

function countFields(fields) {
  let count = fields.length
  for (const entry of fields) if (entry.children) count += countFields(entry.children)
  return count
}

const asArray = value => (Array.isArray(value) ? value : [])

/**
 * Identifies and parses a file. Pure and synchronous; never throws.
 * @param {Uint8Array | ArrayBuffer} input
 * @param {import('./types.js').FileMeta} [meta]
 * @param {{ limits?: Partial<{ rows: number, text: number, ms: number }> }} [options]  tighter limits, for tests
 * @returns {Analysis}
 */
export function analyzeBytes(input, meta = {}, options = {}) {
  return revealAnalysis(analyzeRaw(input, meta, options))
}

function analyzeRaw(input, meta, options) {
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
    warnings: [],
    unusual: [],
    image: null
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

  const run = runParse(format.parse, bytes, meta, options.limits)
  if (run.limit) {
    analysis.summary = genericSummary(bytes, meta)
    analysis.warnings.push(limitWarning(run.limit))
    return analysis
  }
  if (run.error) {
    const err = run.error
    analysis.summary = genericSummary(bytes, meta)
    analysis.warnings.push(`Error analyzing file: ${err && err.message ? err.message : String(err)}`)
    return analysis
  }
  const partial = run.result || {}

  if (typeof partial.formatName === 'string' && partial.formatName) analysis.formatName = partial.formatName
  analysis.summary = asArray(partial.summary)
  analysis.fields = cleanFields(partial.fields, bytes.length)
  analysis.regions = cleanRegions(partial.regions, bytes.length)
  analysis.symbols = asArray(partial.symbols)
  analysis.entries = asArray(partial.entries)
  analysis.warnings.push(...asArray(partial.warnings))
  analysis.unusual = cleanUnusual(partial.unusual, bytes.length)
  analysis.image = cleanImage(partial.image, bytes.length)

  // Rows a parser built without the shared helpers were not charged as it
  // went; count them here so the page is never handed more than the budget
  const rows = countFields(analysis.fields) + analysis.regions.length + analysis.symbols.length + analysis.entries.length + analysis.summary.length
  if (rows > { ...limitsFor(bytes.length), ...options.limits }.rows) {
    return { ...analysis, summary: genericSummary(bytes, meta), fields: [], regions: [], symbols: [], entries: [], warnings: [limitWarning('rows')], unusual: [], image: null }
  }
  return analysis
}
