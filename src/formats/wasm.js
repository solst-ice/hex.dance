import { ByteReader, capFields, field, fitted, formatNumber, plural, printable, readULEB, utf8 } from './reader.js'
import { formatBytes, item } from './shared.js'

const MAX_SECTIONS = 1000
const MAX_ITEMS = 100000
const MAX_ITEM_FIELDS = 100

const SECTION_NAMES = ['Custom', 'Type', 'Import', 'Function', 'Table', 'Memory', 'Global', 'Export', 'Start', 'Element', 'Code', 'Data', 'Data count', 'Tag']
const SECTION_DESCRIPTIONS = [
  'Named extra data (debug info, names, producers)', 'Function signatures', 'Functions, tables, memories and globals taken from the host',
  'Signature index of each defined function', 'Tables of references', 'Linear memories', 'Global variables', 'Names exposed to the host',
  'Function run at instantiation', 'Table initialisers', 'Function bodies', 'Memory initialisers', 'Number of data segments', 'Exception tags'
]
const KINDS = ['function', 'table', 'memory', 'global', 'tag']
const VALUE_TYPES = { 0x7F: 'i32', 0x7E: 'i64', 0x7D: 'f32', 0x7C: 'f64', 0x7B: 'v128', 0x70: 'funcref', 0x6F: 'externref' }

class Cursor {
  constructor(bytes, pos, end) {
    this.bytes = bytes
    this.pos = pos
    this.end = end
    this.ok = true
  }

  uleb() {
    const result = readULEB(this.bytes, this.pos, this.end, 10)
    if (!result) {
      this.ok = false
      return 0
    }
    this.pos = result.next
    return result.value
  }

  byte() {
    if (this.pos >= this.end) {
      this.ok = false
      return 0
    }
    return this.bytes[this.pos++]
  }

  name() {
    const length = this.uleb()
    if (!this.ok || this.pos + length > this.end) {
      this.ok = false
      return ''
    }
    const text = utf8(this.bytes, this.pos, Math.min(length, 1024))
    this.pos += length
    return text
  }

  limits() {
    const flags = this.byte()
    const min = this.uleb()
    const max = flags & 1 ? this.uleb() : null
    return { min, max, shared: (flags & 2) !== 0, memory64: (flags & 4) !== 0 }
  }
}

function describeLimits({ min, max, shared, memory64 }, unit) {
  return `${formatNumber(min)}${max !== null ? `–${formatNumber(max)}` : '+'} ${unit}${shared ? ', shared' : ''}${memory64 ? ', 64-bit' : ''}`
}

function parseWasm(bytes) {
  const r = new ByteReader(bytes, true)
  const warnings = []
  const regions = []
  const summary = []
  const symbols = []
  const version = r.u32(4)
  const fields = [field('Header', 0, Math.min(8, bytes.length), undefined, 'Module preamble', 'header', [
    field('Magic', 0, 4, '\\0asm', 'WebAssembly signature', 'magic'),
    field('Version', 4, 4, version === 1 ? '1 (core module)' : (version & 0xFFFF) === 0x0D ? `0x${version.toString(16)} (component)` : version, 'Binary format version')
  ])]
  if (bytes.length < 8) {
    warnings.push('File is truncated inside the header')
    return { summary, fields, warnings }
  }
  regions.push({ name: 'Header', offset: 0, length: 8, kind: 'header' })

  const sectionFields = []
  const customNames = []
  const counts = {}
  let importedFunctions = 0
  let definedFunctions = 0
  let memories = []
  let start = null
  let pos = 8
  let sections = 0
  let lastId = 0
  const functionNames = new Map()

  while (pos < bytes.length && sections < MAX_SECTIONS) {
    sections++
    const id = bytes[pos]
    const sizeResult = readULEB(bytes, pos + 1, bytes.length, 5)
    if (!sizeResult) {
      warnings.push(`Section header at offset ${pos} is truncated`)
      break
    }
    const size = sizeResult.value
    const contentStart = sizeResult.next
    const declaredEnd = contentStart + size
    const end = Math.min(declaredEnd, bytes.length)
    if (declaredEnd > bytes.length) warnings.push(`${SECTION_NAMES[id] || `Section ${id}`} section runs past the end of the file`)
    if (id > 13) warnings.push(`Unknown section id ${id} at offset ${pos}`)
    if (id !== 0 && id !== 12 && id < lastId && id <= 11) warnings.push(`${SECTION_NAMES[id]} section is out of order`)
    if (id !== 0) lastId = id

    const name = SECTION_NAMES[id] || `Unknown (${id})`
    const children = [
      field('Section ID', pos, 1, `${id} (${name})`, 'Section kind', 'magic'),
      field('Size', pos + 1, contentStart - pos - 1, formatNumber(size), 'Content bytes (LEB128)', 'size')
    ]
    const c = new Cursor(bytes, contentStart, end)
    const itemFields = []
    let label = name
    const vectorCount = () => {
      const count = c.uleb()
      counts[id] = count
      children.push(field('Count', contentStart, c.pos - contentStart, formatNumber(count), 'Entries in this section', 'count'))
      return Math.min(count, MAX_ITEMS)
    }

    if (id === 0) {
      const customName = c.name()
      label = `Custom "${printable(customName, 60)}"`
      if (customNames.length < 256) customNames.push(customName)
      children.push(field('Name', contentStart, c.pos - contentStart, printable(customName, 80), 'Custom section name', 'string'))
      if (customName === 'name') readNameSection(bytes, c.pos, end, functionNames)
      if (c.pos < end) children.push(field('Payload', c.pos, end - c.pos, formatBytes(end - c.pos), 'Custom data', 'data'))
    } else if (id === 2) {
      const count = vectorCount()
      for (let i = 0; i < count && c.ok; i++) {
        const itemStart = c.pos
        const module = c.name()
        const fieldName = c.name()
        const kind = c.byte()
        let detail = ''
        if (kind === 0) {
          detail = `type ${c.uleb()}`
          functionNames.set(importedFunctions, `${module}.${fieldName}`)
          importedFunctions++
        } else if (kind === 1) {
          const ref = VALUE_TYPES[c.byte()] || 'ref'
          detail = `${ref}, ${describeLimits(c.limits(), 'entries')}`
        } else if (kind === 2) {
          const limits = c.limits()
          memories.push({ ...limits, imported: true })
          detail = describeLimits(limits, 'pages')
        } else if (kind === 3) {
          detail = `${VALUE_TYPES[c.byte()] || 'type'}${c.byte() ? ', mutable' : ''}`
        } else if (kind === 4) {
          c.byte()
          detail = `type ${c.uleb()}`
        } else {
          c.ok = false
        }
        if (!c.ok) break
        const kindName = KINDS[kind] || `kind ${kind}`
        if (symbols.length < MAX_ITEMS) symbols.push({ name: `${module}.${fieldName}`, type: 'U', note: `imported ${kindName}, ${detail}` })
        if (itemFields.length < MAX_ITEM_FIELDS + 1) itemFields.push(field(printable(`${module}.${fieldName}`, 100), itemStart, c.pos - itemStart, `${kindName} (${detail})`, 'Import: module, name and description', 'string'))
      }
    } else if (id === 3) {
      definedFunctions = vectorCount()
    } else if (id === 5) {
      const count = vectorCount()
      for (let i = 0; i < count && c.ok && i < 100; i++) {
        const itemStart = c.pos
        const limits = c.limits()
        if (!c.ok) break
        memories.push({ ...limits, imported: false })
        itemFields.push(field(`Memory ${i}`, itemStart, c.pos - itemStart, describeLimits(limits, 'pages'), '64 KiB pages', 'size'))
      }
    } else if (id === 7) {
      const count = vectorCount()
      for (let i = 0; i < count && c.ok; i++) {
        const itemStart = c.pos
        const exportName = c.name()
        const kind = c.byte()
        const index = c.uleb()
        if (!c.ok) break
        const kindName = KINDS[kind] || `kind ${kind}`
        const type = kind === 0 ? 'T' : kind === 3 ? 'D' : kind === 2 ? 'D' : kind === 1 ? 'D' : 'T'
        if (symbols.length < MAX_ITEMS) symbols.push({ name: exportName, type, address: `0x${index.toString(16).toUpperCase()}`, note: `exported ${kindName} ${index}` })
        if (itemFields.length < MAX_ITEM_FIELDS + 1) itemFields.push(field(printable(exportName, 100), itemStart, c.pos - itemStart, `${kindName} ${index}`, 'Export: name, kind and index', 'string'))
      }
    } else if (id === 8) {
      start = c.uleb()
      children.push(field('Function index', contentStart, c.pos - contentStart, start, 'Called when the module is instantiated'))
    } else if (id === 10) {
      const count = vectorCount()
      for (let i = 0; i < count && c.ok; i++) {
        const bodyStart = c.pos
        const bodySize = c.uleb()
        if (!c.ok || c.pos + bodySize > end) {
          c.ok = false
          break
        }
        c.pos += bodySize
        const index = importedFunctions + i
        if (itemFields.length <= MAX_ITEM_FIELDS) {
          const fname = functionNames.get(index)
          itemFields.push(field(`Function ${index}`, bodyStart, c.pos - bodyStart, fname ? `${printable(fname, 60)}, ${formatBytes(bodySize)}` : formatBytes(bodySize), 'Size-prefixed function body', 'code'))
        } else {
          // Only the span matters for the "more not shown" entry
          itemFields.push({ name: '', offset: bodyStart, length: c.pos - bodyStart })
        }
      }
    } else if (id === 1 || id === 4 || id === 6 || id === 9 || id === 11 || id === 13) {
      vectorCount()
    } else if (id === 12) {
      counts[12] = c.uleb()
      children.push(field('Data segment count', contentStart, c.pos - contentStart, counts[12], 'Lets code validate data.drop', 'count'))
    }
    if (!c.ok) warnings.push(`${name} section is malformed or truncated`)
    if (itemFields.length) {
      const listed = capFields(itemFields, MAX_ITEM_FIELDS, 'more')
      children.push(...listed)
    }
    sectionFields.push(field(label, pos, end - pos, formatBytes(size), SECTION_DESCRIPTIONS[id] || 'Unknown section', 'header', children))
    regions.push({ name: label, offset: pos, length: end - pos, kind: id === 10 ? 'code' : id === 11 ? 'data' : id === 0 ? 'metadata' : 'table' })
    pos = declaredEnd
  }
  if (sections >= MAX_SECTIONS && pos < bytes.length) warnings.push(`Stopped after ${MAX_SECTIONS} sections`)
  fields.push(...capFields(sectionFields, 200, 'more sections'))

  // Name exported and imported functions from the name section where it helps
  for (const symbol of symbols) {
    if (symbol.type !== 'T' || !symbol.note.startsWith('exported function')) continue
    const index = parseInt(symbol.address, 16)
    const internal = functionNames.get(index)
    if (internal && internal !== symbol.name) symbol.note += ` (${printable(internal, 60)})`
  }

  summary.push(item('Version', version === 1 ? '1 (MVP core module)' : `0x${version.toString(16)}`))
  summary.push(item('Sections', formatNumber(sectionFields.length)))
  summary.push(item('Functions', `${formatNumber(definedFunctions)} defined, ${formatNumber(importedFunctions)} imported`))
  if (counts[1] !== undefined) summary.push(item('Types', formatNumber(counts[1])))
  summary.push(item('Imports', formatNumber(counts[2] || 0)))
  summary.push(item('Exports', formatNumber(counts[7] || 0)))
  memories.slice(0, 4).forEach((memory, index) => summary.push(item(`Memory ${index}`, `${describeLimits(memory, 'pages')} (${formatBytes(memory.min * 65536)} initial)${memory.imported ? ', imported' : ''}`)))
  if (counts[6] !== undefined) summary.push(item('Globals', formatNumber(counts[6])))
  if (counts[11] !== undefined) summary.push(item('Data Segments', formatNumber(counts[11])))
  if (start !== null) summary.push(item('Start Function', start))
  if (customNames.length) summary.push(item('Custom Sections', customNames.slice(0, 20).map(n => printable(n, 40)).join(', ') + (customNames.length > 20 ? ', …' : '')))
  if (functionNames.size > importedFunctions) summary.push(item('Debug Names', `Yes (${plural(functionNames.size, 'function name')})`))

  return { formatName: version === 1 ? 'WebAssembly Module' : 'WebAssembly Component', summary, fields, regions, symbols, warnings }
}

// Function names from the "name" custom section (subsection 1)
function readNameSection(bytes, start, end, names) {
  const c = new Cursor(bytes, start, end)
  let guard = 0
  while (c.pos < end && c.ok && guard++ < 16) {
    const id = c.byte()
    const size = c.uleb()
    const subEnd = Math.min(c.pos + size, end)
    if (id === 1) {
      const inner = new Cursor(bytes, c.pos, subEnd)
      const count = Math.min(inner.uleb(), MAX_ITEMS)
      for (let i = 0; i < count && inner.ok; i++) {
        const index = inner.uleb()
        const name = inner.name()
        if (inner.ok && !names.has(index)) names.set(index, name)
      }
    }
    c.pos = subEnd
  }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'wasm',
  name: 'WebAssembly Module',
  category: 'executable',
  detect: bytes => bytes.length >= 8 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6D,
  parse: fitted(parseWasm)
}
