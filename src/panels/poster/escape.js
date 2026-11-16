// Making untrusted strings (file names, decoded values, descriptions) safe to
// put into SVG text and attributes, and short enough to fit a layout.

// Characters XML 1.0 cannot carry at all, plus C1 controls, bidi overrides
// and lone surrogates, which would either break parsing or mislead a reader
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/**
 * Replaces control and otherwise unsafe characters with U+FFFD and turns tabs
 * and line breaks into single spaces, so the result is one printable line.
 * @param {unknown} value
 */
export function cleanText(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[\t\n\r]+/g, ' ').replace(UNSAFE, '�')
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
  return chars.slice(0, max - 1).join('').trimEnd() + '…'
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
