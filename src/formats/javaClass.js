import { item } from './shared.js'
import { chargeText } from './budget.js'
import { FieldList, clip, field, hexOffset, plural } from './fieldTree.js'

function javaRelease(major) {
  if (major >= 49) return `Java ${major - 44}`
  return { 45: 'Java 1.0 / 1.1', 46: 'Java 1.2', 47: 'Java 1.3', 48: 'Java 1.4' }[major] || null
}

const u16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1]
const u32 = (bytes, offset) => ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0

// Constant pool tags: [name, size of the entry after the tag byte]
const CONSTANT_TAGS = {
  1: ['Utf8', -1],
  3: ['Integer', 4],
  4: ['Float', 4],
  5: ['Long', 8],
  6: ['Double', 8],
  7: ['Class', 2],
  8: ['String', 2],
  9: ['Fieldref', 4],
  10: ['Methodref', 4],
  11: ['InterfaceMethodref', 4],
  12: ['NameAndType', 4],
  15: ['MethodHandle', 3],
  16: ['MethodType', 2],
  17: ['Dynamic', 4],
  18: ['InvokeDynamic', 4],
  19: ['Module', 2],
  20: ['Package', 2]
}

const CLASS_FLAGS = [
  [0x0001, 'public'], [0x0010, 'final'], [0x0020, 'super'], [0x0200, 'interface'],
  [0x0400, 'abstract'], [0x1000, 'synthetic'], [0x2000, 'annotation'], [0x4000, 'enum'], [0x8000, 'module']
]
const FIELD_FLAGS = [
  [0x0001, 'public'], [0x0002, 'private'], [0x0004, 'protected'], [0x0008, 'static'], [0x0010, 'final'],
  [0x0040, 'volatile'], [0x0080, 'transient'], [0x1000, 'synthetic'], [0x4000, 'enum']
]
const METHOD_FLAGS = [
  [0x0001, 'public'], [0x0002, 'private'], [0x0004, 'protected'], [0x0008, 'static'], [0x0010, 'final'],
  [0x0020, 'synchronized'], [0x0040, 'bridge'], [0x0080, 'varargs'], [0x0100, 'native'], [0x0400, 'abstract'],
  [0x0800, 'strict'], [0x1000, 'synthetic']
]

function flagsValue(value, table) {
  const names = table.filter(([bit]) => value & bit).map(([, name]) => name)
  return `${hexOffset(value)}${names.length ? ` (${names.join(' ')})` : ''}`
}

class Truncated extends Error {}

/**
 * Walks the class file. Throws Truncated when the file ends early; everything
 * built so far is kept in `top`.
 */
function walk(bytes, top, state) {
  const need = (at, n) => {
    if (at + n > bytes.length) throw new Truncated()
  }
  const decoder = new TextDecoder('utf-8')
  const strings = new Map()
  const classes = new Map()
  const utf8 = index => strings.get(index)
  const className = index => {
    const name = utf8(classes.get(index))
    return name === undefined ? `#${index}` : name.replace(/\//g, '.')
  }
  const ref = index => (strings.has(index) ? `#${index} "${clip(strings.get(index), 60)}"` : `#${index}`)

  let p = 10
  need(8, 2)
  const poolCount = u16(bytes, 8)
  top.push(field('constant_pool_count', 8, 2, { value: `${poolCount} (${Math.max(0, poolCount - 1)} entries)`, kind: 'count', description: 'One more than the number of entries: index 0 is never used' }))
  const pool = new FieldList(1000, 'constants')
  const poolStart = p
  try {
    for (let index = 1; index < poolCount; index++) {
      need(p, 1)
      const tag = bytes[p]
      const info = CONSTANT_TAGS[tag]
      if (!info) throw new Error(`unknown constant pool tag ${tag} at ${hexOffset(p)}`)
      let size = info[1]
      if (size === -1) {
        need(p + 1, 2)
        size = 2 + u16(bytes, p + 1)
      }
      need(p + 1, size)
      let value
      if (tag === 1) {
        const text = decoder.decode(bytes.subarray(p + 3, p + 1 + size))
        chargeText(text.length)
        strings.set(index, text.length > 512 ? text.slice(0, 512) : text)
        value = `"${clip(text, 80)}"`
      } else if (tag === 7) {
        classes.set(index, u16(bytes, p + 1))
        value = `name ${u16(bytes, p + 1)}`
      } else if (tag === 3) {
        value = String(u32(bytes, p + 1) | 0)
      } else if (tag === 5) {
        value = String((BigInt(u32(bytes, p + 1)) << 32n | BigInt(u32(bytes, p + 5))) - ((bytes[p + 1] & 0x80) ? 1n << 64n : 0n))
      } else if (size === 2) {
        value = `#${u16(bytes, p + 1)}`
      } else if (size === 4 && tag !== 4) {
        value = `#${u16(bytes, p + 1)}, #${u16(bytes, p + 3)}`
      }
      if (pool.full) {
        pool.skip(p, 1 + size)
      } else {
        pool.push(field(`#${index} ${info[0]}`, p, 1 + size, {
          value,
          kind: tag === 1 ? 'string' : 'data',
          children: [
            field('Tag', p, 1, { value: `${tag} (${info[0]})`, kind: 'header' }),
            tag === 1 ? field('Length', p + 1, 2, { value: `${size - 2} bytes`, kind: 'size' }) : null,
            tag === 1 && size > 2 ? field('Bytes', p + 3, size - 2, { value, kind: 'string', description: 'Modified UTF-8: NUL is two bytes and characters outside the BMP are surrogate pairs' }) : null,
            tag !== 1 ? field('Value', p + 1, size, { value, kind: 'data' }) : null
          ].filter(Boolean)
        }))
      }
      p += 1 + size
      // Long and Double take two pool slots
      if (tag === 5 || tag === 6) index++
    }
  } finally {
    if (p > poolStart) {
      top.push(field('constant_pool', poolStart, p - poolStart, {
        value: plural(pool.count, 'entry', 'entries'),
        kind: 'header',
        description: 'Every name, type descriptor, string literal and numeric constant the class uses; the rest of the file refers to them by index',
        children: pool.toArray()
      }))
    }
  }

  need(p, 8)
  const access = u16(bytes, p)
  const thisClass = u16(bytes, p + 2)
  const superClass = u16(bytes, p + 4)
  state.className = className(thisClass)
  state.superName = superClass === 0 ? null : className(superClass)
  top.push(
    field('access_flags', p, 2, { value: flagsValue(access, CLASS_FLAGS), kind: 'flags' }),
    field('this_class', p + 2, 2, { value: `#${thisClass} ${state.className}`, kind: 'header', description: 'Constant pool index of this class' }),
    field('super_class', p + 4, 2, { value: superClass === 0 ? '0 (none: java.lang.Object)' : `#${superClass} ${state.superName}`, kind: 'header' })
  )
  p += 6
  const interfaces = u16(bytes, p)
  top.push(field('interfaces_count', p, 2, { value: interfaces, kind: 'count' }))
  p += 2
  if (interfaces > 0) {
    need(p, interfaces * 2)
    const list = []
    for (let i = 0; i < interfaces && i < 1000; i++) list.push(field(`Interface ${i}`, p + i * 2, 2, { value: className(u16(bytes, p + i * 2)), kind: 'header' }))
    top.push(field('interfaces', p, interfaces * 2, { kind: 'header', children: list }))
    p += interfaces * 2
  }

  const attributes = (at, owner) => {
    need(at, 2)
    const count = u16(bytes, at)
    const children = [field('attributes_count', at, 2, { value: count, kind: 'count' })]
    let q = at + 2
    for (let i = 0; i < count; i++) {
      need(q, 6)
      const length = u32(bytes, q + 2)
      need(q + 6, length)
      const name = utf8(u16(bytes, q)) || `#${u16(bytes, q)}`
      if (i < 64) {
        children.push(field(name, q, 6 + length, {
          value: plural(length, 'byte'),
          kind: 'header',
          description: `${owner} attribute`,
          children: [
            field('attribute_name_index', q, 2, { value: ref(u16(bytes, q)), kind: 'header' }),
            field('attribute_length', q + 2, 4, { value: length, kind: 'size' }),
            length > 0 ? field('info', q + 6, length, { kind: 'data' }) : null
          ].filter(Boolean)
        }))
      }
      q += 6 + length
    }
    return { children, end: q, count }
  }

  const members = (label, flags) => {
    need(p, 2)
    const count = u16(bytes, p)
    top.push(field(`${label}_count`, p, 2, { value: count, kind: 'count' }))
    p += 2
    const start = p
    const list = new FieldList(1000, label)
    try {
      for (let i = 0; i < count; i++) {
        need(p, 8)
        const memberStart = p
        const name = utf8(u16(bytes, p + 2)) || `#${u16(bytes, p + 2)}`
        const descriptor = utf8(u16(bytes, p + 4)) || `#${u16(bytes, p + 4)}`
        const attrs = attributes(p + 6, label === 'fields' ? 'Field' : 'Method')
        p = attrs.end
        if (list.full) {
          list.skip(memberStart, p - memberStart)
          continue
        }
        list.push(field(`${name}`, memberStart, p - memberStart, {
          value: clip(descriptor, 80),
          kind: 'header',
          children: [
            field('access_flags', memberStart, 2, { value: flagsValue(u16(bytes, memberStart), flags), kind: 'flags' }),
            field('name_index', memberStart + 2, 2, { value: ref(u16(bytes, memberStart + 2)), kind: 'header' }),
            field('descriptor_index', memberStart + 4, 2, { value: ref(u16(bytes, memberStart + 4)), kind: 'header', description: 'Type descriptor, e.g. (I)V for a method taking an int and returning void' }),
            ...attrs.children
          ]
        }))
      }
    } finally {
      if (p > start) top.push(field(label, start, p - start, { value: plural(list.count, label === 'fields' ? 'field' : 'method'), kind: 'header', children: list.toArray() }))
    }
    return count
  }

  state.fields = members('fields', FIELD_FLAGS)
  state.methods = members('methods', METHOD_FLAGS)
  const attrs = attributes(p, 'Class')
  const sourceFile = attrs.children.find(child => child.name === 'SourceFile')
  if (sourceFile) {
    const at = sourceFile.offset + 6
    state.sourceFile = utf8(u16(bytes, at))
  }
  top.push(field('attributes', p, attrs.end - p, { value: plural(attrs.count, 'attribute'), kind: 'header', children: attrs.children }))
  p = attrs.end
  if (p < bytes.length) {
    top.push(field('Trailing data', p, bytes.length - p, { kind: 'data', description: 'Bytes after the end of the class file; the JVM rejects such files' }))
    state.trailing = bytes.length - p
  }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'java-class',
  name: 'Java class file',
  category: 'executable',
  // 0xCAFEBABE starts both universal Mach-O binaries and Java class files. In a
  // universal binary the next u32 is the (small) architecture count; in a class
  // file it holds the minor and major version, and major versions start at 45.
  detect: bytes => bytes.length >= 8 &&
    bytes[0] === 0xCA && bytes[1] === 0xFE && bytes[2] === 0xBA && bytes[3] === 0xBE &&
    u16(bytes, 6) >= 45,
  parse(bytes) {
    const minor = u16(bytes, 4)
    const major = u16(bytes, 6)
    const release = javaRelease(major)
    const summary = [
      item('Format', 'Java class file'),
      item('Class File Version', `${major}.${minor}`)
    ]
    if (release) summary.push(item('Java Release', `${release}${minor === 0xFFFF ? ' (preview features)' : ''}`))
    const warnings = []
    const fields = [
      field('magic', 0, 4, { value: '0xCAFEBABE', kind: 'magic', description: 'Java class file magic. Universal Mach-O binaries start with the same four bytes' }),
      field('minor_version', 4, 2, { value: minor === 0xFFFF ? '65535 (preview features)' : minor, kind: 'header' }),
      field('major_version', 6, 2, { value: release ? `${major} (${release})` : major, kind: 'header', description: release ? `Needs ${release} or later; from Java 5 on, the major version is the release plus 44` : 'Class file format version' })
    ]
    const state = {}
    try {
      walk(bytes, fields, state)
    } catch (err) {
      warnings.push(err instanceof Truncated ? 'File is truncated' : `Could not read the class structure (${err.message})`)
    }
    if (state.className) summary.push(item('Class', state.className))
    if (state.superName) summary.push(item('Superclass', state.superName))
    if (state.fields !== undefined && state.methods !== undefined) summary.push(item('Members', `${plural(state.fields, 'field')}, ${plural(state.methods, 'method')}`))
    if (state.sourceFile) summary.push(item('Source File', state.sourceFile))
    if (state.trailing) warnings.push(`${plural(state.trailing, 'byte')} of data after the end of the class`)
    const regions = []
    const pool = fields.find(f => f.name === 'constant_pool')
    regions.push({ name: 'Header', offset: 0, length: 10, kind: 'header' })
    if (pool) regions.push({ name: 'Constant pool', offset: pool.offset, length: pool.length, kind: 'table' })
    for (const name of ['fields', 'methods', 'attributes']) {
      const f = fields.find(x => x.name === name)
      if (f) regions.push({ name: name[0].toUpperCase() + name.slice(1), offset: f.offset, length: f.length, kind: name === 'methods' ? 'code' : 'metadata' })
    }
    return { summary, fields, regions, warnings }
  }
}
