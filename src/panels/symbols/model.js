// Pure helpers behind the Symbols table: classification, filtering and
// sorting over the analysis' symbol list, without touching React.

/** What each nm-style type letter means; lowercase letters are local symbols */
export const TYPE_LETTERS = [
  ['T', 'Code (text section)'],
  ['D', 'Initialised data'],
  ['B', 'Zero-initialised data (bss)'],
  ['R', 'Read-only data'],
  ['S', 'Other section (Mach-O)'],
  ['U', 'Undefined: imported from a library'],
  ['W', 'Weak symbol (w: weak and undefined)'],
  ['V', 'Weak object (v: weak and undefined)'],
  ['I', 'Indirect: PE forwarder or GNU indirect function'],
  ['A', 'Absolute value'],
  ['C', 'Common symbol'],
  ['N', 'Debugging or non-allocated section'],
  ['u', 'GNU unique global'],
  ['?', 'Unknown section']
]

const LETTER_MEANINGS = new Map(TYPE_LETTERS.map(([letter, meaning]) => [letter, meaning]))

export function describeType(letter) {
  const exact = LETTER_MEANINGS.get(letter)
  if (exact && (letter === letter.toUpperCase() || letter === 'u')) return exact
  const upper = LETTER_MEANINGS.get(letter.toUpperCase())
  if (letter === 'w' || letter === 'v') return 'Weak, undefined: optional import'
  if (letter === 'i') return 'GNU indirect function (resolved at load time)'
  return upper ? `${upper}, local to this file` : 'Unknown'
}

export const KIND_FUNCTION = 1
export const KIND_DATA = 2
export const KIND_OTHER = 3
const FLAG_IMPORT = 1
const FLAG_EXPORT = 2

export const isImport = symbol => !symbol.address && (symbol.type === 'U' || symbol.type === 'w' || symbol.type === 'v')

function kindOf(symbol) {
  if (symbol.kind === 'function') return KIND_FUNCTION
  if (symbol.kind === 'data') return KIND_DATA
  if (symbol.kind === 'other') return KIND_OTHER
  const letter = symbol.type
  if (letter === 'T' || letter === 't' || letter === 'i' || letter === 'I') return KIND_FUNCTION
  if ('DdBbRrVvCc'.includes(letter)) return KIND_DATA
  return KIND_OTHER
}

/** The library name to show and look up: imports carry it, exports name nothing */
export function baseName(name) {
  const at = name.indexOf('@')
  return at > 0 ? name.slice(0, at) : name
}

/**
 * Precomputes per-symbol keys once per analysis so that filtering and
 * sorting 100,000+ rows stay well under a frame budget.
 * @param {import('../../analysis/types.js').SymbolEntry[]} symbols
 */
export function buildModel(symbols) {
  const count = symbols.length
  const lower = new Array(count)
  const kinds = new Uint8Array(count)
  const flags = new Uint8Array(count)
  const counts = { all: count, function: 0, data: 0, import: 0, export: 0 }
  for (let i = 0; i < count; i++) {
    const s = symbols[i]
    lower[i] = s.name.toLowerCase()
    const kind = kindOf(s)
    kinds[i] = kind
    if (kind === KIND_FUNCTION) counts.function++
    else if (kind === KIND_DATA) counts.data++
    if (isImport(s)) {
      flags[i] |= FLAG_IMPORT
      counts.import++
    } else if (/[A-Z]/.test(s.type) && s.type !== 'U') {
      flags[i] |= FLAG_EXPORT
      counts.export++
    }
  }
  return { symbols, count, lower, kinds, flags, counts, orders: new Map() }
}

export const QUICK_FILTERS = [
  ['all', 'All'],
  ['function', 'Functions'],
  ['data', 'Data'],
  ['import', 'Imports'],
  ['export', 'Exported']
]

function quickTest(model, quick) {
  switch (quick) {
    case 'function': return i => model.kinds[i] === KIND_FUNCTION
    case 'data': return i => model.kinds[i] === KIND_DATA
    case 'import': return i => (model.flags[i] & FLAG_IMPORT) !== 0
    case 'export': return i => (model.flags[i] & FLAG_EXPORT) !== 0
    default: return null
  }
}

// Fixed-width key that orders 64-bit addresses exactly; rows without an address sort last
function addressKey(symbol) {
  if (!symbol.address) return '~'
  const digits = symbol.address.replace(/^0x/i, '').toLowerCase()
  return digits.padStart(16, '0')
}

/** Row indices in the requested order (the parser's name order is the default) */
export function sortedOrder(model, key) {
  const cached = model.orders.get(key)
  if (cached) return cached
  const indices = new Uint32Array(model.count)
  for (let i = 0; i < model.count; i++) indices[i] = i
  if (key === 'type') {
    indices.sort((a, b) => {
      const ta = model.symbols[a].type
      const tb = model.symbols[b].type
      return ta === tb ? a - b : ta < tb ? -1 : 1
    })
  } else if (key === 'address') {
    const keys = model.symbols.map(addressKey)
    indices.sort((a, b) => (keys[a] === keys[b] ? a - b : keys[a] < keys[b] ? -1 : 1))
  }
  model.orders.set(key, indices)
  return indices
}

/**
 * Indices of the rows to show, in display order.
 * @param {{ query?: string, quick?: string, sortKey?: string, descending?: boolean,
 *   tag?: string|null, tagOf?: (index: number) => string|null, alias?: (index: number) => string|null }} options
 *   `alias` supplies a second searchable name per row (demangled names)
 */
export function filterRows(model, { query = '', quick = 'all', sortKey = 'name', descending = false, tag = null, tagOf = null, alias = null } = {}) {
  const order = sortedOrder(model, sortKey)
  const needle = query.trim().toLowerCase()
  const test = quickTest(model, quick)
  const result = new Uint32Array(model.count)
  let n = 0
  for (let k = 0; k < order.length; k++) {
    const i = order[descending ? order.length - 1 - k : k]
    if (test && !test(i)) continue
    if (tag && (!tagOf || tagOf(i) !== tag)) continue
    if (needle && !model.lower[i].includes(needle)) {
      const other = alias ? alias(i) : null
      if (!other || !other.toLowerCase().includes(needle)) continue
    }
    result[n++] = i
  }
  return result.subarray(0, n)
}

/** Capability tags used by the imports, most frequent first */
export function capabilitySummary(model, tagOf) {
  const counts = new Map()
  for (let i = 0; i < model.count; i++) {
    if (!(model.flags[i] & FLAG_IMPORT)) continue
    const tag = tagOf(i)
    if (tag) counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}
