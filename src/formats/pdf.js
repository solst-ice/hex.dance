import { item, startsWith } from './shared.js'
import { FieldList, field, hexOffset, plural } from './fieldTree.js'
import { pointAt } from './pointers.js'

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


// ---- structure: objects, cross-reference tables and trailers -------------

const TOKEN = /(\d{1,10})[ \t\r\n\f\0]{1,16}(\d{1,5})[ \t\r\n\f\0]{1,16}obj\b|\bxref\b|\btrailer\b|\bstartxref\b|%%EOF/g
const MAX_DICT_SCAN = 64 * 1024

function skipSpace(text, at, end) {
  while (at < end && /[ \t\r\n\f\0]/.test(text[at])) at++
  return at
}

function trimEnd(text, start, end) {
  while (end > start && /[ \t\r\n\f\0]/.test(text[end - 1])) end--
  return end
}

// End of a << >> dictionary that starts at `at`, or -1
function dictionaryEnd(text, at, end) {
  let depth = 0
  const stop = Math.min(end, at + MAX_DICT_SCAN)
  for (let i = at; i < stop - 1; i++) {
    const ch = text[i]
    if (ch === '(') {
      // Skip literal strings, which may contain unbalanced brackets
      let nest = 1
      i++
      while (i < stop && nest > 0) {
        if (text[i] === '\\') i++
        else if (text[i] === '(') nest++
        else if (text[i] === ')') nest--
        i++
      }
      i--
    } else if (ch === '<' && text[i + 1] === '<') {
      depth++
      i++
    } else if (ch === '>' && text[i + 1] === '>') {
      depth--
      i++
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function objectField(text, base, match, windowEnd) {
  const start = match.index
  const headerEnd = start + match[0].length
  const number = match[1]
  const generation = match[2]
  const bodyStart = skipSpace(text, headerEnd, windowEnd)
  const children = [field('Object header', base + start, headerEnd - start, {
    value: `${number} ${generation} obj`,
    kind: 'header',
    description: 'Object number and generation; other objects refer to this one as "' + number + ' ' + generation + ' R"'
  })]
  let value
  let cursor = bodyStart
  let typeName = null

  if (text.startsWith('<<', bodyStart)) {
    const dictEnd = dictionaryEnd(text, bodyStart, windowEnd)
    const stop = dictEnd === -1 ? Math.min(windowEnd, bodyStart + 200) : dictEnd
    const dict = text.slice(bodyStart, stop)
    const type = /\/Type\s*\/([A-Za-z0-9]{1,40})/.exec(dict)
    typeName = type ? type[1] : null
    if (dictEnd !== -1) {
      children.push(field('Dictionary', base + bodyStart, dictEnd - bodyStart, { value: typeName ? `/${typeName}` : `${plural(dictEnd - bodyStart, 'byte')}`, kind: 'header', description: 'Key/value pairs between << and >>' }))
      cursor = dictEnd
    }
    const afterDict = skipSpace(text, cursor, windowEnd)
    if (dictEnd !== -1 && text.startsWith('stream', afterDict)) {
      let dataStart = afterDict + 6
      if (text[dataStart] === '\r') dataStart++
      if (text[dataStart] === '\n') dataStart++
      const lengthMatch = /\/Length\s+(\d{1,10})(?!\s+\d+\s+R)/.exec(dict)
      const filter = /\/Filter\s*\/([A-Za-z0-9]{1,40})/.exec(dict)
      let dataEnd = -1
      if (lengthMatch) {
        const guess = dataStart + parseInt(lengthMatch[1], 10)
        const near = skipSpace(text, guess, windowEnd)
        if (guess <= windowEnd && text.startsWith('endstream', near)) dataEnd = guess
      }
      if (dataEnd === -1) {
        const found = text.indexOf('endstream', dataStart)
        dataEnd = found === -1 ? windowEnd : trimEnd(text, dataStart, found)
      }
      children.push(field('stream keyword', base + afterDict, 6, { value: 'stream', kind: 'header' }))
      if (dataEnd > dataStart) {
        children.push(field('Stream data', base + dataStart, dataEnd - dataStart, {
          value: `${plural(dataEnd - dataStart, 'byte')}${filter ? `, /${filter[1]}` : ''}`,
          kind: 'data',
          description: filter ? `Stream contents, encoded with the ${filter[1]} filter` : 'Stream contents'
        }))
      }
      const endstream = text.indexOf('endstream', dataEnd)
      if (endstream !== -1) {
        children.push(field('endstream keyword', base + endstream, 9, { value: 'endstream', kind: 'header' }))
        cursor = endstream + 9
      } else {
        cursor = windowEnd
      }
      value = typeName ? `/${typeName} stream` : 'stream'
    }
  }

  let end
  const endobj = cursor >= windowEnd ? -1 : text.indexOf('endobj', cursor)
  if (endobj === -1) {
    end = windowEnd
    if (!children.some(child => child.name === 'Dictionary' || child.name === 'Stream data') && bodyStart < windowEnd) {
      children.push(field('Value', base + bodyStart, windowEnd - bodyStart, { kind: 'data', description: 'Cut off by the end of the scanned area' }))
    }
  } else {
    const valueEnd = trimEnd(text, cursor, endobj)
    if (!children.some(child => child.name === 'Dictionary') && valueEnd > bodyStart && cursor === bodyStart) {
      const raw = text.slice(bodyStart, Math.min(valueEnd, bodyStart + 60))
      children.push(field('Value', base + bodyStart, valueEnd - bodyStart, { value: raw.replace(/\s+/g, ' '), kind: 'data' }))
    }
    children.push(field('endobj keyword', base + endobj, 6, { value: 'endobj', kind: 'header' }))
    end = endobj + 6
  }
  if (!value) value = typeName ? `/${typeName}` : undefined
  return {
    end,
    field: field(`Object ${number} ${generation}`, base + start, end - start, {
      value,
      kind: 'header',
      description: 'An indirect object: a numbered value that the cross-reference table locates by byte offset',
      children
    })
  }
}

const SUBSECTION = /[ \t\r\n\f\0]*(\d{1,10})[ \t]+(\d{1,10})[ \t]*(?:\r\n|\r|\n)/y
const XREF_ENTRY = /^(\d{10}) (\d{5}) ([nf])/

// Whether an offset, when it falls inside the scanned text, starts the object it should
function checkTarget(text, base, target, number) {
  const at = target - base
  if (at < 0 || at >= text.length) return ''
  const match = /^(\d{1,10})[ \t\r\n\f\0]{1,16}\d{1,5}[ \t\r\n\f\0]{1,16}obj\b/.exec(text.slice(at, at + 40))
  if (!match) return ' (no object there)'
  return parseInt(match[1], 10) === number ? ' (verified)' : ` (finds object ${match[1]})`
}

function xrefField(text, base, at, windowEnd, size) {
  const children = [field('xref keyword', base + at, 4, { value: 'xref', kind: 'header' })]
  let p = at + 4
  let total = 0
  for (let sections = 0; sections < 1000; sections++) {
    SUBSECTION.lastIndex = p
    const match = SUBSECTION.exec(text)
    if (!match) break
    const first = parseInt(match[1], 10)
    const count = parseInt(match[2], 10)
    const headerStart = match.index + match[0].length - match[0].trimStart().length
    const entries = new FieldList(1000, 'entries')
    let q = SUBSECTION.lastIndex
    let n = 0
    while (n < count && q + 18 <= windowEnd) {
      const entry = XREF_ENTRY.exec(text.slice(q, q + 18))
      if (!entry) break
      const length = Math.min(20, windowEnd - q)
      if (entries.full) {
        entries.skip(base + q, length)
      } else {
        const inUse = entry[3] === 'n'
        const target = parseInt(entry[1], 10)
        entries.push(pointAt(field(`Object ${first + n}`, base + q, length, {
          value: inUse ? `at ${hexOffset(target)}, generation ${parseInt(entry[2], 10)}${checkTarget(text, base, target, first + n)}` : `free, generation ${parseInt(entry[2], 10)}`,
          kind: inUse ? 'offset' : 'padding',
          description: inUse ? 'In use: 10-digit byte offset of the object, 5-digit generation, "n"' : 'Free entry: links to the next free object number, "f"'
        }), inUse ? target : null, size))
      }
      q += length
      n++
    }
    total += n
    const subChildren = [field('Subsection header', base + headerStart, SUBSECTION.lastIndex - headerStart, { value: `${first} ${count}`, kind: 'count', description: 'First object number and number of entries' }), ...entries.toArray()]
    const subEnd = q
    children.push(field(`Objects ${first}–${first + Math.max(count, 1) - 1}`, base + headerStart, subEnd - headerStart, { value: plural(count, 'entry', 'entries'), kind: 'header', children: subChildren }))
    p = subEnd
    if (n < count) break
  }
  const end = p
  return {
    end,
    field: field('Cross-reference table', base + at, end - at, {
      value: plural(total, 'entry', 'entries'),
      kind: 'header',
      description: 'Maps object numbers to byte offsets, so a reader can jump straight to any object. Each entry is exactly 20 bytes',
      children
    })
  }
}

function trailerField(text, base, at, windowEnd) {
  const children = [field('trailer keyword', base + at, 7, { value: 'trailer', kind: 'header' })]
  const dictStart = skipSpace(text, at + 7, windowEnd)
  let end = at + 7
  let value
  if (text.startsWith('<<', dictStart)) {
    const dictEnd = dictionaryEnd(text, dictStart, windowEnd)
    if (dictEnd !== -1) {
      const dict = text.slice(dictStart, dictEnd)
      const parts = []
      const root = /\/Root\s+(\d+\s+\d+)\s+R/.exec(dict)
      const size = /\/Size\s+(\d+)/.exec(dict)
      const prev = /\/Prev\s+(\d+)/.exec(dict)
      if (root) parts.push(`root ${root[1]} R`)
      if (size) parts.push(`size ${size[1]}`)
      if (prev) parts.push(`previous xref at ${hexOffset(parseInt(prev[1], 10))}`)
      value = parts.join(', ') || undefined
      children.push(field('Trailer dictionary', base + dictStart, dictEnd - dictStart, {
        value,
        kind: 'header',
        description: '/Root points to the document catalog, /Size is the number of objects, /Prev links to an earlier cross-reference section'
      }))
      end = dictEnd
    }
  }
  return { end, field: field('Trailer', base + at, end - at, { value, kind: 'header', description: 'Tells a reader where the document catalog is and how the file was updated', children }) }
}

function pointsAt(text, base, target) {
  const at = target - base
  if (at < 0 || at >= text.length) return ''
  if (text.startsWith('xref', at)) return ', points to a cross-reference table'
  if (/^\d{1,10}[ \t\r\n\f\0]{1,16}\d{1,5}[ \t\r\n\f\0]{1,16}obj\b/.test(text.slice(at, at + 40))) return ', points to a cross-reference stream'
  return ', points to neither a table nor a stream'
}

function startxrefField(text, base, at, windowEnd, size) {
  const match = /^startxref[ \t\r\n\f\0]{1,16}(\d{1,12})/.exec(text.slice(at, Math.min(windowEnd, at + 40)))
  if (!match) return { end: at + 9, field: field('startxref', base + at, 9, { value: 'startxref', kind: 'header' }) }
  const numberAt = at + match[0].length - match[1].length
  const target = parseInt(match[1], 10)
  return {
    end: at + match[0].length,
    field: field('startxref', base + at, match[0].length, {
      value: hexOffset(target),
      kind: 'header',
      description: 'Byte offset of the last cross-reference section; a reader starts here, near the end of the file',
      children: [
        field('startxref keyword', base + at, 9, { value: 'startxref', kind: 'header' }),
        pointAt(field('Offset', base + numberAt, match[1].length, { value: `${target} (${hexOffset(target)})${pointsAt(text, base, target)}`, kind: 'offset' }), target, size)
      ]
    })
  }
}

function scanWindow(bytes, start, end, list, regions) {
  const text = bytesToLatin1(bytes, start, end)
  const addRegion = (name, offset, length, kind) => {
    const last = regions[regions.length - 1]
    if (last && last.name === name && offset - (last.offset + last.length) < 256) last.length = offset + length - last.offset
    else if (regions.length < 200) regions.push({ name, offset, length, kind })
  }
  const regex = new RegExp(TOKEN.source, 'g')
  let match
  while ((match = regex.exec(text)) !== null) {
    let result
    const token = match[0]
    if (match[1] !== undefined) {
      if (list.full) {
        const endobj = text.indexOf('endobj', regex.lastIndex)
        const stop = endobj === -1 ? text.length : endobj + 6
        list.skip(start + match.index, stop - match.index)
        addRegion('Objects', start + match.index, stop - match.index, 'data')
        regex.lastIndex = stop
        continue
      }
      result = objectField(text, start, match, text.length)
      addRegion('Objects', start + match.index, result.end - match.index, 'data')
    } else if (token === 'xref') {
      result = xrefField(text, start, match.index, text.length, bytes.length)
      addRegion('Cross-reference table', start + match.index, result.end - match.index, 'table')
    } else if (token === 'trailer') {
      result = trailerField(text, start, match.index, text.length)
      addRegion('Trailer', start + match.index, result.end - match.index, 'metadata')
    } else if (token === 'startxref') {
      result = startxrefField(text, start, match.index, text.length, bytes.length)
      addRegion('Trailer', start + match.index, result.end - match.index, 'metadata')
    } else {
      result = { end: match.index + 5, field: field('End-of-file marker', start + match.index, 5, { value: '%%EOF', kind: 'header', description: 'Ends a revision of the file; incremental updates append more objects and another %%EOF' }) }
      addRegion('Trailer', start + match.index, 5, 'metadata')
    }
    list.push(result.field)
    regex.lastIndex = Math.max(result.end, match.index + 1)
  }
}

function pdfStructure(bytes, headerLength) {
  const fields = []
  const regions = headerLength ? [{ name: 'Header', offset: 0, length: headerLength, kind: 'header' }] : []
  let headStart = headerLength
  // A comment of high bytes right after the header tells transfer tools the file is binary
  const line = bytesToLatin1(bytes, headerLength, Math.min(bytes.length, headerLength + 64))
  const binary = /^(\r\n|\r|\n)(%[\x80-\xFF]{4,}[^\r\n]{0,16})/.exec(line)
  if (binary) {
    const at = headerLength + binary[1].length
    fields.push(field('Binary marker', at, binary[2].length, {
      value: `${binary[2].length - 1} high bytes`,
      kind: 'magic',
      description: 'A comment of bytes above 127, so transfer tools treat the file as binary rather than text'
    }))
    headStart = at + binary[2].length
  }
  const headEnd = Math.min(bytes.length, SCAN_WINDOW)
  const head = new FieldList(1000, 'items')
  if (headStart < headEnd) scanWindow(bytes, headStart, headEnd, head, regions)
  fields.push(...head.toArray())
  if (bytes.length > SCAN_WINDOW) {
    const tailStart = Math.max(headEnd, bytes.length - SCAN_WINDOW)
    if (tailStart > headEnd) {
      fields.push(field('Not scanned', headEnd, tailStart - headEnd, {
        kind: 'data',
        value: formatSize(tailStart - headEnd),
        description: 'Only the first and last megabyte of large PDFs are scanned, to keep analysis fast'
      }))
      regions.push({ name: 'Not scanned', offset: headEnd, length: tailStart - headEnd, kind: 'other' })
    }
    const tail = new FieldList(1000, 'items')
    scanWindow(bytes, tailStart, bytes.length, tail, regions)
    fields.push(...tail.toArray())
  }
  return { fields, regions }
}

function formatSize(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : plural(n, 'byte')
}

function parsePDF(bytes) {
  const summary = []
  const warnings = []
  const head = bytesToLatin1(bytes, 0, Math.min(bytes.length, 32))
  const version = /^%PDF-(\d+\.\d+)/.exec(head)
  summary.push(item('Version', `PDF ${version ? version[1] : 'unknown'}`))
  const headerLength = version ? version[0].length : Math.min(bytes.length, 5)
  const fields = headerLength === 0 ? [] : [{
    name: 'Header',
    offset: 0,
    length: headerLength,
    value: head.slice(0, headerLength),
    kind: 'magic',
    description: 'PDF signature and version'
  }]
  let regions = []
  const result = () => ({ summary, fields, regions, warnings })

  try {
    const structure = pdfStructure(bytes, headerLength)
    fields.push(...structure.fields)
    regions = structure.regions
  } catch (err) {
    warnings.push(`Could not map the file structure (${err.message})`)
  }

  try {
    const text = scanText(bytes)
    const objects = collectObjects(text)

    const pages = findPageCount(text, objects)
    if (pages !== null) summary.push(item('Pages', pages))

    if (lastMatch(text, /\/Encrypt\s+(?:\d+\s+\d+\s+R|<<)/)) {
      summary.push(item('Encrypted', 'Yes'))
      return result()
    }

    const infoText = findInfoDictionary(text, objects)
    if (!infoText) return result()
    for (const [key, label] of INFO_FIELDS) {
      const raw = readStringValue(infoText, key, objects)
      if (raw === null) continue
      const value = cleanText(key.endsWith('Date') ? formatPDFDate(raw) : raw)
      if (value) summary.push(item(label, value))
    }
  } catch (err) {
    warnings.push(`Could not read document structure (${err.message})`)
  }

  return result()
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'pdf',
  name: 'PDF Document',
  category: 'document',
  detect: bytes => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2D]),
  parse: parsePDF
}
