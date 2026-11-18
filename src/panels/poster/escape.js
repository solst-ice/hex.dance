// Making untrusted strings (file names, decoded values, descriptions) safe to
// put into SVG text and attributes, and short enough to fit a layout.

import { visibleText } from '../../lib/visibleText.js'

/**
 * Turns tabs and line breaks into single spaces, so the result is one line,
 * and shows control, invisible and direction-changing characters as markers
 * such as ⟨U+202E⟩ (the same as everywhere else in the app). That also keeps
 * out every character XML 1.0 cannot carry. The layout measures text it has
 * already cleaned, so markers already there are left as they are.
 * @param {unknown} value
 */
export function cleanText(value) {
  if (value === null || value === undefined) return ''
  return visibleText(String(value).replace(/[\t\n\r]+/g, ' '), { keepMarkers: true })
}

/**
 * Escapes text for an XML text node or a double- or single-quoted attribute.
 * @param {unknown} value
 */
export function escapeXml(value) {
  return cleanText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Shortens text to at most `max` characters (code points), ending with an
 * ellipsis when anything was cut.
 * @param {unknown} value
 * @param {number} max
 */
export function truncate(value, max) {
  const text = cleanText(value)
  if (max <= 0) return ''
  const chars = Array.from(text)
  if (chars.length <= max) return text
  if (max === 1) return '…'
  let kept = chars.slice(0, max - 1).join('')
  // Half a marker such as '⟨U+20' would read as file text; leave all of it out
  const open = kept.lastIndexOf('\u27E8')
  if (open > kept.lastIndexOf('\u27E9')) kept = kept.slice(0, open)
  return kept.trimEnd() + '…'
}

/** Number of code points, which is what the monospace layout measures. */
export function textLength(value) {
  return Array.from(cleanText(value)).length
}

/**
 * A download name derived from the source file: `grad.png` becomes
 * `grad_png-poster`. Only letters, digits, dots, dashes and underscores.
 * @param {string} fileName
 */
export function posterBaseName(fileName) {
  const base = cleanText(fileName || '')
    .replace(/\.(?=[^.]*$)/, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 60)
    .replace(/[._-]+$/, '')
  return `${base || 'file'}-poster`
}
