import { capFields, field, fitted, formatNumber, plural, printable, utf16 } from './reader.js'
import { item } from './shared.js'

// Detection only looks at the start of the file; parsing makes one pass over
// all of it.
const SAMPLE_SIZE = 64 * 1024
const MIN_LENGTH = 4
const MAX_LINE_FIELDS = 200

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

// Bytes that never appear in ordinary text. Tab, LF, VT, FF, CR, ESC
// (terminal colours) and backspace (nroff overstrike) are allowed.
function isControl(byte) {
  return (byte < 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0B && byte !== 0x0C && byte !== 0x0D && byte !== 0x1B && byte !== 0x08) || byte === 0x7F
}

function bomOf(bytes) {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return { encoding: 'utf-8', length: 3 }
  if (bytes[0] === 0xFF && bytes[1] === 0xFE && !(bytes[2] === 0 && bytes[3] === 0)) return { encoding: 'utf-16le', length: 2 }
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { encoding: 'utf-16be', length: 2 }
  return null
}

// Drops a multi-byte sequence cut off at the end of the sample
function trimPartialUtf8(sample) {
  let end = sample.length
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const byte = sample[end - back]
    if ((byte & 0xC0) === 0x80) continue
    if (byte >= 0xC0) {
      const need = byte >= 0xF0 ? 4 : byte >= 0xE0 ? 3 : 2
      if (back < need) end -= back
    }
    break
  }
  return sample.subarray(0, end)
}

function sampleUtf16IsText(bytes, start, little) {
  const end = Math.min(bytes.length, start + SAMPLE_SIZE)
  let bad = 0
  let units = 0
  for (let i = start; i + 1 < end; i += 2) {
    const unit = little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]
    units++
    if (unit < 0x100 ? isControl(unit) || unit === 0 : unit === 0xFFFE || unit === 0xFFFF) bad++
  }
  return units > 0 && bad * 200 <= units
}

/**
 * Decides how a file's start reads as text: 'utf-8', 'ascii', 'utf-16le',
 * 'utf-16be', '8-bit' (valid as a legacy single-byte encoding only), or null.
 */
export function sniffEncoding(bytes) {
  if (bytes.length < MIN_LENGTH) return null
  const bom = bomOf(bytes)
  if (bom && bom.encoding !== 'utf-8') {
    return sampleUtf16IsText(bytes, bom.length, bom.encoding === 'utf-16le') ? bom.encoding : null
  }
  const start = bom ? bom.length : 0
  const sample = bytes.subarray(start, Math.min(bytes.length, start + SAMPLE_SIZE))
  let bad = 0
  let high = 0
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i]
    if (byte === 0) return null
    if (byte >= 0x80) high++
    else if (isControl(byte)) bad++
  }
  if (bad * 200 > sample.length) return null
  if (high === 0) return bom ? 'utf-8' : 'ascii'
  try {
    strictUtf8.decode(sample.length === bytes.length - start ? sample : trimPartialUtf8(sample))
    return 'utf-8'
  } catch {
    if (bom) return null
    // Legacy text has mostly ASCII; compressed or encrypted data does not.
    // A few bytes are too little evidence for a legacy encoding.
    return sample.length >= 64 && high * 10 <= sample.length * 3 ? '8-bit' : null
  }
}

const ENCODING_NAMES = {
  ascii: 'ASCII',
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 little-endian',
  'utf-16be': 'UTF-16 big-endian',
  '8-bit': '8-bit, not UTF-8 (Windows-1252 or Latin-1?)'
}

// One pass over the file: line endings, longest line, characters, and
// anything that does not belong in text.
function scan(bytes, start, unitSize, little) {
  const stats = {
    lf: 0, crlf: 0, cr: 0, chars: 0, longest: 0, longestLine: 0, nul: 0, controls: 0, high: 0,
    invalidUtf8: 0, firstInvalid: -1, lines: [], linesTotal: 0, endsWithNewline: false
  }
  const length = bytes.length
  let lineStart = start
  let lineChars = 0
  let lineNumber = 1
  let need = 0
  const endLine = (end, terminator) => {
    if (lineChars > stats.longest) {
      stats.longest = lineChars
      stats.longestLine = lineNumber
    }
    if (stats.lines.length < MAX_LINE_FIELDS) stats.lines.push({ start: lineStart, end, terminator, number: lineNumber })
    lineNumber++
    lineChars = 0
    lineStart = end
  }

  if (unitSize === 2) {
    for (let i = start; i + 1 < length; i += 2) {
      const unit = little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]
      if (unit === 0x0A) {
        stats.lf++
        endLine(i + 2, 'LF')
      } else if (unit === 0x0D) {
        const next = i + 3 < length ? (little ? bytes[i + 2] | (bytes[i + 3] << 8) : (bytes[i + 2] << 8) | bytes[i + 3]) : -1
        if (next === 0x0A) {
          stats.crlf++
          i += 2
          endLine(i + 2, 'CRLF')
        } else {
          stats.cr++
          endLine(i + 2, 'CR')
        }
      } else {
        if (unit === 0) stats.nul++
        else if (unit < 0x80 && isControl(unit)) stats.controls++
        if (unit < 0xDC00 || unit > 0xDFFF) {
          stats.chars++
          lineChars++
        }
      }
    }
  } else {
    for (let i = start; i < length; i++) {
      const byte = bytes[i]
      if (byte < 0x80) {
        if (need > 0) {
          stats.invalidUtf8++
          if (stats.firstInvalid < 0) stats.firstInvalid = i
          need = 0
        }
        if (byte === 0x0A) {
          stats.lf++
          endLine(i + 1, 'LF')
          continue
        }
        if (byte === 0x0D) {
          if (i + 1 < length && bytes[i + 1] === 0x0A) {
            stats.crlf++
            i++
            endLine(i + 1, 'CRLF')
          } else {
            stats.cr++
            endLine(i + 1, 'CR')
          }
          continue
        }
        if (byte === 0) stats.nul++
        else if (isControl(byte)) stats.controls++
        stats.chars++
        lineChars++
      } else if (need > 0 && (byte & 0xC0) === 0x80) {
        stats.high++
        need--
      } else {
        stats.high++
        if (need > 0 || byte < 0xC2 || byte > 0xF4) {
          stats.invalidUtf8++
          if (stats.firstInvalid < 0) stats.firstInvalid = i
        }
        need = byte >= 0xF0 ? 3 : byte >= 0xE0 ? 2 : byte >= 0xC2 ? 1 : 0
        stats.chars++
        lineChars++
      }
    }
    if (need > 0) {
      stats.invalidUtf8++
      if (stats.firstInvalid < 0) stats.firstInvalid = length - 1
    }
  }

  stats.endsWithNewline = lineStart === length && length > start
  if (lineStart < length) endLine(length, '')
  stats.linesTotal = lineNumber - 1
  return stats
}

// Recognises common text formats from the first kilobyte
function sniffContent(text) {
  const head = text.replace(/^\s+/, '')
  const pem = head.match(/^-----BEGIN ([A-Z0-9 ]+)-----/)
  if (pem) {
    const label = pem[1]
    const name = /CERTIFICATE REQUEST/.test(label) ? 'PEM certificate request'
      : /CERTIFICATE/.test(label) ? 'PEM certificate'
        : /PRIVATE KEY/.test(label) ? 'PEM private key'
          : /PUBLIC KEY/.test(label) ? 'PEM public key'
            : /PGP/.test(label) ? 'PGP armored data' : 'PEM data'
    return { name, detail: `-----BEGIN ${label}-----` }
  }
  if (head.startsWith('#!')) {
    const line = head.split(/\r?\n|\r/, 1)[0]
    const interpreter = line.slice(2).trim().split(/\s+/)
    const program = (interpreter[0] || '').split('/').pop() === 'env' ? interpreter[1] : (interpreter[0] || '').split('/').pop()
    return { name: 'Script', detail: `${program || 'unknown'} (${printable(line, 80)})` }
  }
  if (/^<\?xml[\s?]/.test(head)) {
    return /<svg[\s>]/.test(head) ? { name: 'SVG image', detail: 'XML with an <svg> root' } : { name: 'XML document', detail: 'XML declaration' }
  }
  if (/^<svg[\s>]/i.test(head)) return { name: 'SVG image', detail: '<svg> element' }
  if (/^(<!--[\s\S]*?-->\s*)?<!doctype html|^<html[\s>]/i.test(head)) return { name: 'HTML document', detail: 'HTML markup' }
  if (/^\{\\rtf/.test(head)) return { name: 'RTF document', detail: 'Rich Text Format' }
  if (/^%!PS/.test(head)) return { name: 'PostScript document', detail: printable(head.split(/\r?\n/, 1)[0], 80) }
  if (/^[[{]/.test(head)) {
    try {
      JSON.parse(text)
      return { name: 'JSON', detail: 'Parses as JSON' }
    } catch {
      if (/^\{\s*"|^\[\s*[[{"\d-]/.test(head)) return { name: 'JSON', detail: 'Looks like JSON (not checked past the first part)' }
    }
  }
  return null
}

function linePreview(bytes, line, unitSize, little) {
  const end = Math.min(line.end, line.start + 240)
  const raw = unitSize === 2 ? utf16(bytes, line.start, end - line.start, little) : new TextDecoder('utf-8').decode(bytes.subarray(line.start, end))
  return printable(raw.replace(/[\r\n]+$/, ''), 80)
}

function parseText(bytes) {
  const warnings = []
  const fields = []
  const regions = []
  let encoding = sniffEncoding(bytes) || '8-bit'
  const bom = bomOf(bytes)
  const unitSize = encoding.startsWith('utf-16') ? 2 : 1
  const little = encoding === 'utf-16le'
  const start = bom ? bom.length : 0

  if (bom) {
    fields.push(field('Byte order mark', 0, bom.length, bom.encoding.toUpperCase(), 'Marks the encoding and byte order', 'magic'))
    regions.push({ name: 'Byte order mark', offset: 0, length: bom.length, kind: 'header' })
  }
  if (bytes.length > start) regions.push({ name: 'Text', offset: start, length: bytes.length - start, kind: 'data' })

  const stats = scan(bytes, start, unitSize, little)
  // The sample was plain ASCII but later parts of the file are not
  if (encoding === 'ascii' && stats.high > 0) encoding = 'utf-8'
  const lineFields = stats.lines.map(line => {
    const ending = line.terminator ? `, ends with ${line.terminator}` : ', no line ending'
    return field(`Line ${line.number}`, line.start, line.end - line.start, linePreview(bytes, line, unitSize, little),
      `${formatNumber(line.end - line.start)} bytes${ending}`, 'string')
  })
  fields.push(...capFields(lineFields, MAX_LINE_FIELDS, 'more lines', stats.linesTotal - stats.lines.length, bytes.length))

  const summary = []
  const sampleEnd = Math.min(bytes.length, start + 1024 * unitSize)
  const head = unitSize === 2 ? utf16(bytes, start, sampleEnd - start, little) : new TextDecoder('utf-8').decode(bytes.subarray(start, Math.min(bytes.length, start + SAMPLE_SIZE)))
  const content = sniffContent(head)
  let encodingName = ENCODING_NAMES[encoding]
  if (encoding === 'utf-8' && stats.invalidUtf8 > 0) encodingName = 'Mostly UTF-8 (has invalid sequences)'
  summary.push(item('Encoding', encodingName))
  summary.push(item('Byte Order Mark', bom ? 'Yes' : 'No'))
  if (content) summary.push(item('Content', content.name, [content.detail]))
  summary.push(item('Lines', formatNumber(stats.linesTotal)))

  const endings = [['LF', stats.lf], ['CRLF', stats.crlf], ['CR', stats.cr]].filter(([, count]) => count > 0)
  if (endings.length === 0) summary.push(item('Line Endings', 'None (single line)'))
  else if (endings.length === 1) summary.push(item('Line Endings', `${endings[0][0]} (${endings[0][0] === 'LF' ? 'Unix' : endings[0][0] === 'CRLF' ? 'Windows' : 'classic Mac'})`))
  else summary.push(item('Line Endings', 'Mixed', endings.map(([name, count]) => `${name}: ${formatNumber(count)}`)))
  summary.push(item('Longest Line', `${plural(stats.longest, 'character')} (line ${formatNumber(stats.longestLine)})`))
  summary.push(item('Characters', formatNumber(stats.chars)))
  summary.push(item('Final Newline', stats.endsWithNewline ? 'Yes' : 'No'))

  if (stats.nul > 0) warnings.push(`Contains ${plural(stats.nul, 'NUL byte')}; this may be binary data rather than text`)
  if (stats.controls > 0) warnings.push(`Contains ${plural(stats.controls, 'control character')} not normally found in text`)
  if (encoding === 'utf-8' && stats.invalidUtf8 > 0) {
    warnings.push(`${plural(stats.invalidUtf8, 'invalid UTF-8 sequence')}, the first at offset 0x${stats.firstInvalid.toString(16).toUpperCase()}`)
  }
  if (unitSize === 2 && (bytes.length - start) % 2 === 1) warnings.push('Odd number of bytes in UTF-16 text; the last byte is incomplete')

  const formatName = content ? (content.name === 'Script' ? 'Script' : content.name.replace(/^./, c => c.toUpperCase())) : 'Text File'
  return { formatName, summary, fields, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'text',
  name: 'Text File',
  category: 'text',
  detect: bytes => sniffEncoding(bytes) !== null,
  parse: fitted(parseText)
}
