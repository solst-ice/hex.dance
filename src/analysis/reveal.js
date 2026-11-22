import { revealText } from '../lib/visibleText.js'

// Every piece of text in an analysis came from the file or was written about
// it, so all of it is passed through revealText on the way out of
// analyzeBytes: names, values, descriptions, symbols, entries, the parsers'
// own warnings and unusual notes, which often quote a name, and the section
// names of the memory layout. Text the parsers write
// themselves holds no hidden characters and comes through unchanged.

function revealIn(value, found) {
  if (typeof value === 'string') {
    const { text, deceptive } = revealText(value)
    if (deceptive) found.add(value)
    return text
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const next = revealIn(value[i], found)
      if (next !== value[i]) value[i] = next
    }
    return value
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const next = revealIn(value[key], found)
      if (next !== value[key]) value[key] = next
    }
  }
  return value
}

// A name usually appears on its own and inside labels such as 'Local file:
// name'; a text that contains another flagged text is not counted again
const MAX_COMPARED = 2000

function distinctNames(found) {
  const texts = [...found].sort((a, b) => a.length - b.length)
  if (texts.length > MAX_COMPARED) return texts.length
  const kept = []
  for (const text of texts) if (!kept.some(shorter => text.includes(shorter))) kept.push(text)
  return kept.length
}

/**
 * Makes hidden and direction-changing characters visible throughout an
 * analysis, in place, and adds one warning when any invisible formatting or direction controls
 * were found (control bytes are marked too, but are common in binary data).
 * @param {import('./types.js').Analysis} analysis
 */
export function revealAnalysis(analysis) {
  const found = new Set()
  analysis.formatName = revealIn(analysis.formatName, found)
  for (const key of ['summary', 'fields', 'regions', 'symbols', 'entries', 'warnings', 'unusual', 'image']) revealIn(analysis[key], found)
  const names = distinctNames(found)
  if (names) {
    const count = names.toLocaleString('en-US')
    analysis.warnings.push(`${names === 1 ? 'One name or value' : `${count} names or values`} from the file ${names === 1 ? 'contains' : 'contain'} hidden or direction-changing characters, such as a right-to-left override or a zero-width space, which can make a name look like something else. They are shown as markers like ⟨U+202E⟩.`)
  }
  return analysis
}
