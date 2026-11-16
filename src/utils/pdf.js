// Only the start and end of large files are scanned: the header, linearization
// dictionary and first objects live at the start, the trailer and the objects
// written by incremental updates at the end.
const SCAN_WINDOW = 1024 * 1024
const MAX_OBJECT_TEXT = 64 * 1024
const MAX_STRING_BYTES = 2048
const MAX_DISPLAY_LENGTH = 200

const INFO_FIELDS = [
  ['Title', 'Title'],
  ['Author', 'Author'],
  ['Subject', 'Subject'],
  ['Creator', 'Creator'],
  ['Producer', 'Producer'],
  ['CreationDate', 'Creation Date'],
  ['ModDate', 'Modified Date']
]

function bytesToLatin1(bytes, start, end) {
  let out = ''
  for (let i = start; i < end; i += 8192) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, end)))
  }
  return out
}

function scanText(bytes) {
  if (bytes.length <= SCAN_WINDOW * 2) return bytesToLatin1(bytes, 0, bytes.length)
  return bytesToLatin1(bytes, 0, SCAN_WINDOW) + '\n' +
    bytesToLatin1(bytes, bytes.length - SCAN_WINDOW, bytes.length)
}

// Maps object number to the text of its latest definition (without stream data)
function collectObjects(text) {
  const objects = new Map()
  // Bounded repetition keeps the scan linear on long runs of digits, which an
  // unbounded \d+ would re-scan from every starting position
  const header = /(\d{1,10})\s+\d{1,5}\s+obj\b/g
  let match
  while ((match = header.exec(text)) !== null) {
    const start = header.lastIndex
    let end = text.indexOf('endobj', start)
    if (end === -1) end = text.length
    let body = text.slice(start, Math.min(end, start + MAX_OBJECT_TEXT))
    const streamAt = body.indexOf('stream')
    if (streamAt !== -1) body = body.slice(0, streamAt)
    objects.set(match[1], body)
    // Continue after endobj so binary stream data is never mistaken for objects
    header.lastIndex = end
  }
  return objects
}

function lastMatch(text, regex) {
  let result = null
  let match
  const global = new RegExp(regex.source, 'g')
  while ((match = global.exec(text)) !== null) result = match
  return result
}

function readCount(objectText) {
  const match = objectText && /\/Count\s+(\d{1,9})\b/.exec(objectText)
  return match ? parseInt(match[1], 10) : null
}

function findPageCount(text, objects) {
  const root = lastMatch(text, /\/Root\s+(\d+)\s+\d+\s+R/)
  if (root) {
    const pagesRef = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(objects.get(root[1]) || '')
    const count = pagesRef && readCount(objects.get(pagesRef[1]))
    if (count !== null && count !== undefined) return count
  }

  // Page tree root unreachable (e.g. not in the scanned window or inside an
  // object stream): every intermediate node counts its descendants, so the
  // largest /Count among /Type /Pages nodes is the best available answer.
  let best = null
  for (const body of objects.values()) {
    if (!/\/Type\s*\/Pages\b/.test(body)) continue
    const count = readCount(body)
    if (count !== null && (best === null || count > best)) best = count
  }
  if (best !== null) return best

  const linearized = /\/Linearized\b[^>]{0,512}?\/N\s+(\d{1,9})\b/.exec(text)
  return linearized ? parseInt(linearized[1], 10) : null
}

function parseLiteralString(text, start) {
  const out = []
  let depth = 1
  let i = start + 1
  while (i < text.length && out.length < MAX_STRING_BYTES) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }
      if (next in escapes) {
        out.push(escapes[next])
        i += 2
      } else if (next >= '0' && next <= '7') {
        let octal = ''
        let j = i + 1
        while (j < text.length && octal.length < 3 && text[j] >= '0' && text[j] <= '7') octal += text[j++]
        out.push(parseInt(octal, 8) & 0xFF)
        i = j
      } else if (next === '\r' || next === '\n') {
        i += next === '\r' && text[i + 2] === '\n' ? 3 : 2
      } else {
        i += 1
      }
      continue
    }
    if (ch === '(') depth++
    if (ch === ')' && --depth === 0) break
    out.push(text.charCodeAt(i) & 0xFF)
    i++
  }
  return out
}

function parseHexString(text, start) {
  const end = text.indexOf('>', start)
  const digits = text.slice(start + 1, end === -1 ? text.length : end).replace(/[^0-9A-Fa-f]/g, '')
  const out = []
  for (let i = 0; i < digits.length && out.length < MAX_STRING_BYTES; i += 2) {
    out.push(parseInt(digits.slice(i, i + 2).padEnd(2, '0'), 16))
  }
  return out
}

function decodeTextString(bytes) {
  const data = Uint8Array.from(bytes)
  try {
    if (data[0] === 0xFE && data[1] === 0xFF) return new TextDecoder('utf-16be').decode(data.subarray(2))
    if (data[0] === 0xFF && data[1] === 0xFE) return new TextDecoder('utf-16le').decode(data.subarray(2))
    if (data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) return new TextDecoder('utf-8').decode(data.subarray(3))
  } catch {
    // Fall through to the single-byte interpretation
  }
  // PDFDocEncoding matches Latin-1 for printable characters
  return String.fromCharCode(...data)
}

function cleanText(str) {
  let out = ''
  for (const ch of str) {
    const code = ch.codePointAt(0)
    const isControl = code < 0x20 || (code >= 0x7F && code <= 0x9F) || code === 0xFFFD
    out += isControl ? ' ' : ch
  }
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > MAX_DISPLAY_LENGTH ? out.slice(0, MAX_DISPLAY_LENGTH) + '…' : out
}

function readStringValue(dictText, key, objects) {
  const match = new RegExp(`/${key}(?![A-Za-z0-9])\\s*`).exec(dictText)
  if (!match) return null
  const at = match.index + match[0].length
  const ch = dictText[at]
  if (ch === '(') return decodeTextString(parseLiteralString(dictText, at))
  if (ch === '<' && dictText[at + 1] !== '<') return decodeTextString(parseHexString(dictText, at))
  const ref = /^(\d+)\s+\d+\s+R/.exec(dictText.slice(at, at + 32))
  if (ref && objects.has(ref[1])) {
    const target = objects.get(ref[1])
    const valueAt = target.search(/[(<]/)
    if (valueAt === -1) return null
    return readStringValue(`/${key} ` + target.slice(valueAt), key, new Map())
  }
  return null
}

function findInfoDictionary(text, objects) {
  const infoRef = lastMatch(text, /\/Info\s+(\d+)\s+\d+\s+R/)
  if (infoRef) return objects.get(infoRef[1]) || null
  // No trailer reference in the scanned text: use the last untyped
  // dictionary that carries document information keys
  let candidate = null
  for (const body of objects.values()) {
    if (/\/(?:Producer|Creator|CreationDate|ModDate)\b/.test(body) && !/\/Type\b/.test(body)) candidate = body
  }
  return candidate
}

export function formatPDFDate(value) {
  const match = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-])?(\d{2})?'?(\d{2})?'?/.exec(value.trim())
  if (!match) return value
  const [, year, month, day, hour, minute, second, zone, zoneHour, zoneMinute] = match
  let out = year
  if (month) out += `-${month}`
  if (day) out += `-${day}`
  if (hour) out += ` ${hour}:${minute || '00'}${second ? `:${second}` : ''}`
  if (hour && zone === 'Z') out += ' UTC'
  else if (hour && zone && zoneHour) out += ` ${zone}${zoneHour}:${zoneMinute || '00'}`
  return out
}

export function parsePDF(buffer) {
  const metadata = new Set()
  const bytes = new Uint8Array(buffer)
  const head = bytesToLatin1(bytes, 0, Math.min(bytes.length, 32))
  const version = /^%PDF-(\d+\.\d+)/.exec(head)
  metadata.add(`Version: PDF ${version ? version[1] : 'unknown'}`)

  try {
    const text = scanText(bytes)
    const objects = collectObjects(text)

    const pages = findPageCount(text, objects)
    if (pages !== null) metadata.add(`Pages: ${pages}`)

    if (lastMatch(text, /\/Encrypt\s+(?:\d+\s+\d+\s+R|<<)/)) {
      metadata.add('Encrypted: Yes')
      return metadata
    }

    const infoText = findInfoDictionary(text, objects)
    if (!infoText) return metadata
    for (const [key, label] of INFO_FIELDS) {
      const raw = readStringValue(infoText, key, objects)
      if (raw === null) continue
      const value = cleanText(key.endsWith('Date') ? formatPDFDate(raw) : raw)
      if (value) metadata.add(`${label}: ${value}`)
    }
  } catch (err) {
    metadata.add(`Warning: Could not read document structure (${err.message})`)
  }

  return metadata
}
