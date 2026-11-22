// The tree a poster plan works on: the analysis fields, checked and sorted,
// with the coarse regions that no field describes added as extra nodes, runs
// of fields that carry nothing merged into one node, and runs of siblings
// with the same layout recognised as repeats. Everything is computed lazily
// and bounded: a hostile tree costs at most VISIT_BUDGET nodes, and no loop
// runs over a file-sized range.

import { kindOf, regionKindOf } from './palette.js'

// Bound on tree nodes looked at per poster, whatever the parser produced
export const VISIT_BUDGET = 20000
// Siblings examined per list; longer lists are cut (and the cut is reported)
export const SIBLING_CAP = 4096
// A run of at least this many siblings with the same layout is a repeat
export const REPEAT_MIN = 4
// A run of siblings with the same layout but different names counts as a
// repeat only when it makes up this share of its list (a table)
const TABLE_SHARE = 0.75
const SIG_CHILDREN = 24
const SIG_BUDGET = 200000
const ZERO_CAP_FIELD = 4096
const ZERO_CAP_TOTAL = 1 << 18
const REGION_CAP = 2048
const REGION_DESCENT = 16
const PIN_CAP = 64
const SMALL_PADDING = 64
const PIN_DESCENT = 32
const SUMMARY_ENTRIES = 128
const SUMMARY_CHILDREN = 24
const POINTER_SCAN = 64
const PAD_NAME = /(^|[\s_.-])(reserved|padding|unused|pad)\d*($|[\s_.-])|(^|_)res\d*$/i
// A run of neighbouring fields whose bytes are all one value other than zero
// (0x0D, 0xFF, 0xCC...) merges into one box when it has at least this many
// fields and bytes; a run of two such fields, or one field of FILL_ALONE
// bytes or more, merges with nothing but counts as dull
export const FILL_RUN_FIELDS = 3
export const FILL_RUN_BYTES = 8
const FILL_ALONE = 8
// Readable text: bytes looked at (the first and last TEXT_EDGE, and
// TEXT_SAMPLES pieces of TEXT_SAMPLE between), and the shares that make text
export const TEXT_MIN = 32
const TEXT_EDGE = 512
const TEXT_SAMPLES = 6
const TEXT_SAMPLE = 64

const isCount = n => Number.isSafeInteger(n) && n >= 0

export function validNode(node, size) {
  return Boolean(node) && typeof node === 'object' && isCount(node.offset) && Number.isFinite(node.length) &&
    Math.floor(node.length) >= 1 && node.offset < size
}

const text = v => (v === undefined || v === null ? '' : String(v))

/**
 * Leading number of a value such as '0x200', '96', '0x0 (none)' or
 * '3,617 bytes'. Returns null when the text does not start with a number.
 * @returns {{ n: bigint, hex: boolean } | null}
 */
export function leadingNumber(value) {
  const m = /^\s*(-?)(0x[0-9a-f]+|\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?![.\d])/i.exec(text(value).slice(0, 40))
  if (!m) return null
  const hex = /^0x/i.test(m[2])
  try {
    const n = BigInt(hex ? m[2] : m[2].replace(/,/g, ''))
    return { n: m[1] ? -n : n, hex }
  } catch {
    return null
  }
}

/** True when a value text says "nothing": zero, empty or none. */
export function zeroText(value) {
  const s = text(value).trim().toLowerCase()
  if (s === '' || /^(empty|none|\(none\)|null|n\/a|-|0x0*|false)$/.test(s)) return true
  const lead = leadingNumber(s)
  return Boolean(lead) && lead.n === 0n
}

const printable = b => (b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d
const letter = b => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)

/**
 * Whether bytes [start, end) read as text: at least 90% printable ASCII, tab,
 * CR or LF, at least a third letters, and at least eight different bytes, over
 * the first and last TEXT_EDGE bytes and TEXT_SAMPLES samples between (at
 * most about 1.4 KB looked at, whatever the length).
 * @param {Uint8Array|null} bytes
 */
export function readableText(bytes, start, end) {
  const stats = textStats(bytes, start, end)
  return Boolean(stats) && stats.good >= stats.total * 0.9 && stats.letters * 3 >= stats.total && stats.distinct >= 8
}

/**
 * Whether bytes [start, end) read as lines of text, the kind worth setting
 * out as a listing: readable as above, with hardly anything unprintable
 * (95% printable, at most 2% NUL bytes) and with the spaces and line ends
 * that words need (5% or more). A table of NUL-separated names is readable
 * text but not this.
 */
export function readableProse(bytes, start, end) {
  const stats = textStats(bytes, start, end)
  return Boolean(stats) && stats.good >= stats.total * 0.95 && stats.letters * 3 >= stats.total && stats.distinct >= 8 &&
    stats.nuls * 50 <= stats.total && stats.spaces * 20 >= stats.total
}

// What the sampled bytes of [start, end) hold, or null when there is nothing to judge
function textStats(bytes, start, end) {
  if (!(bytes instanceof Uint8Array) || !isCount(start) || !(end - start >= TEXT_MIN) || end > bytes.length) return null
  const pieces = []
  if (end - start <= 2 * TEXT_EDGE + TEXT_SAMPLES * TEXT_SAMPLE) pieces.push([start, end])
  else {
    pieces.push([start, start + TEXT_EDGE], [end - TEXT_EDGE, end])
    const between = end - start - 2 * TEXT_EDGE
    for (let k = 1; k <= TEXT_SAMPLES; k++) {
      const at = start + TEXT_EDGE + Math.floor((between * k) / (TEXT_SAMPLES + 1)) - TEXT_SAMPLE / 2
      pieces.push([at, at + TEXT_SAMPLE])
    }
  }
  let total = 0
  let good = 0
  let letters = 0
  let nuls = 0
  let spaces = 0
  const seen = new Set()
  for (const [a, b] of pieces) {
    for (let i = a; i < b; i++) {
      const v = bytes[i]
      total++
      if (printable(v)) good++
      if (letter(v)) letters++
      if (v === 0) nuls++
      else if (v === 0x20 || v === 0x09 || v === 0x0A || v === 0x0D) spaces++
      if (seen.size < 8) seen.add(v)
    }
  }
  return total > 0 ? { total, good, letters, nuls, spaces, distinct: seen.size } : null
}

/** A name with indices and numbers taken out, to compare entries of a list. */
export function nameStem(name) {
  return text(name).slice(0, 80)
    .replace(/^\s*(\[[^\]]*\]|#\d+)\s*/, '')
    .replace(/:.*$/, '')
    .replace(/0x[0-9a-f]+|\d+/gi, '#')
    .trim()
    .toLowerCase()
}

/**
 * @param {Object} input
 * @param {import('../../analysis/types.js').Analysis|null} input.analysis
 * @param {number} input.size
 * @param {Uint8Array} [input.bytes]
 * @param {Array<{ offset: number, length: number }>} [input.pins]
 * @param {boolean} [input.withRegions]  add regions no field covers (tour mode)
 */
export function createTree({ analysis, size, bytes, pins = [], withRegions = false }) {
  const tree = new PosterTree(analysis, size, bytes)
  if (tree.source === 'fields' && withRegions) tree.addRegions(analysis.regions)
  tree.findPins(pins)
  return tree
}

class PosterTree {
  constructor(analysis, size, bytes) {
    this.size = size
    this.bytes = bytes instanceof Uint8Array && bytes.length >= size ? bytes : null
    this.visits = 0
    this.truncated = false
    this.cutLists = 0
    this.sigBudget = SIG_BUDGET
    this.zeroBudget = ZERO_CAP_TOTAL
    this.nextId = 0
    this.nextRepeat = 0
    this.pinned = []
    this.pinsIgnored = 0
    this.regionNodes = 0
    const fields = Array.isArray(analysis?.fields) ? analysis.fields : []
    const regions = Array.isArray(analysis?.regions) ? analysis.regions : []
    this.root = { id: -1, level: 0, offset: 0, end: size, parent: null, isRoot: true }
    let roots = this.list(fields, this.root)
    if (roots.length) this.source = 'fields'
    else {
      roots = this.list(regions, this.root, region => this.regionSource(region))
      this.source = roots.length ? 'regions' : 'none'
    }
    this.root.raw = roots
  }

  regionSource(region) {
    const kind = ['header', 'code', 'data', 'table', 'metadata', 'padding', 'other'].includes(region.kind) ? region.kind : 'other'
    return {
      name: region.name,
      offset: region.offset,
      length: region.length,
      kind: regionKindOf(region.kind),
      value: kind,
      description: 'From the file map; no fields inside',
      padding: kind === 'padding'
    }
  }

  node(src, parent, region = false) {
    const offset = src.offset
    const end = Math.min(this.size, offset + Math.floor(src.length), parent.end)
    return {
      id: this.nextId++,
      src,
      name: text(src.name),
      value: text(src.value),
      description: text(src.description),
      kind: kindOf(src.kind),
      rawKind: text(src.kind),
      offset,
      end,
      level: parent.level + 1,
      parent,
      region,
      merged: null,
      raw: null,
      units: null
    }
  }

  /**
   * Checked, sorted, non-overlapping children inside `parent`, at most
   * SIBLING_CAP of them and within the visit budget.
   */
  list(array, parent, map = null) {
    if (!Array.isArray(array) || array.length === 0) return []
    if (array.length > SIBLING_CAP) this.cutLists++
    const count = Math.min(array.length, SIBLING_CAP)
    const out = []
    let sorted = true
    for (let i = 0; i < count; i++) {
      if (this.visits >= VISIT_BUDGET) {
        this.truncated = true
        break
      }
      this.visits++
      const raw = array[i]
      if (!validNode(raw, this.size)) continue
      const src = map ? map(raw) : raw
      if (src.offset < parent.offset || src.offset >= parent.end) continue
      const node = this.node(src, parent, Boolean(map))
      if (node.end <= node.offset) continue
      if (out.length && node.offset < out[out.length - 1].offset) sorted = false
      out.push(node)
    }
    if (!sorted) out.sort((a, b) => a.offset - b.offset || b.end - a.end)
    const kept = []
    let lastEnd = -1
    for (const node of out) {
      if (node.offset < lastEnd) continue
      kept.push(node)
      lastEnd = node.end
    }
    return kept
  }

  rawChildren(node) {
    if (node.isRoot) return node.raw
    if (node.raw === null) node.raw = node.region ? [] : this.list(node.src.children, node)
    return node.raw
  }

  hasChildren(node) {
    return !node.merged && this.rawChildren(node).length > 0
  }

  /**
   * Adds the regions that no field describes: each goes under the deepest
   * field that holds it, when that field's children leave its bytes alone.
   * At any level a region may hold whole fields that cover under half of it
   * (a section's data holding an import directory); those move under it.
   */
  addRegions(regions) {
    if (!Array.isArray(regions)) return
    const count = Math.min(regions.length, REGION_CAP)
    let lastEnd = -1
    for (let i = 0; i < count; i++) {
      const r = regions[i]
      if (!validNode(r, this.size) || r.offset < lastEnd) continue
      const end = Math.min(this.size, r.offset + Math.floor(r.length))
      lastEnd = end
      // Alignment gaps between sections say nothing worth a box
      if (r.kind === 'padding' && end - r.offset < SMALL_PADDING) continue
      let container = this.root
      for (let depth = 0; depth < REGION_DESCENT; depth++) {
        const holder = this.find(this.rawChildren(container), r.offset, end)
        if (!holder) break
        container = holder
      }
      if (!container.isRoot && container.offset === r.offset && container.end === end) continue
      if (this.visits >= VISIT_BUDGET) {
        this.truncated = true
        return
      }
      this.visits++
      const siblings = this.rawChildren(container)
      // Siblings touching the region: they must lie wholly inside it
      let lo = lowerBound(siblings, r.offset)
      if (lo > 0 && siblings[lo - 1].end > r.offset) lo--
      let hi = lo
      let covered = 0
      let partial = false
      while (hi < siblings.length && siblings[hi].offset < end) {
        const s = siblings[hi]
        if (s.offset < r.offset || s.end > end) partial = true
        covered += Math.min(s.end, end) - Math.max(s.offset, r.offset)
        hi++
      }
      if (partial || covered * 2 >= end - r.offset) continue
      const region = this.node(this.regionSource(r), container, true)
      region.end = Math.min(end, container.end)
      const inside = siblings.slice(lo, hi)
      for (const child of inside) reparent(child, region)
      region.raw = inside.length ? this.withPieces(region, inside) : inside
      siblings.splice(lo, hi - lo, region)
      this.regionNodes++
    }
  }

  /**
   * The fields inside a region, with the bytes around them as pieces of the
   * region ("Section 1, first 80 bytes", "Section 1, the rest"), so that what
   * the region holds besides those fields can still get a label.
   */
  withPieces(region, inside) {
    const out = []
    const piece = (offset, end, name) => {
      const node = this.node({ ...region.src, name, offset, length: end - offset, description: 'Bytes no field describes' }, region, true)
      node.raw = []
      node.piece = true
      out.push(node)
    }
    let at = region.offset
    let middles = 0
    const hexAt = n => '0x' + n.toString(16).toUpperCase()
    for (const child of inside) {
      const gap = child.offset - at
      if (at === region.offset && gap >= 1) piece(at, child.offset, `${region.name}, first ${formatNumber(gap)} byte${gap === 1 ? '' : 's'}`)
      else if (at > region.offset && gap >= 64 && middles++ < 32) piece(at, child.offset, `${region.name}, from ${hexAt(at)}`)
      out.push(child)
      at = child.end
    }
    if (region.end > at) piece(at, region.end, at === region.offset ? region.name : `${region.name}, the rest`)
    return out
  }

  find(siblings, start, end) {
    const i = lowerBound(siblings, start + 1) - 1
    if (i < 0) return null
    const s = siblings[i]
    return s.offset <= start && s.end >= end ? s : null
  }

  /** The node at exactly a pinned range, if there is one. */
  findPins(pins) {
    if (!Array.isArray(pins)) return
    for (const pin of pins.slice(0, PIN_CAP)) {
      if (!pin || !isCount(pin.offset) || !Number.isFinite(pin.length) || pin.length < 1) {
        this.pinsIgnored++
        continue
      }
      const end = pin.offset + Math.floor(pin.length)
      let container = this.root
      let match = null
      for (let depth = 0; depth < PIN_DESCENT && !match; depth++) {
        const holder = this.find(this.rawChildren(container), pin.offset, end)
        if (!holder) break
        if (holder.offset === pin.offset && holder.end === end) match = holder
        container = holder
      }
      // A parent and its only child can share a range: prefer the outer one,
      // which is what the Structure section shows first
      if (!match || match.pinned) {
        if (!match) this.pinsIgnored++
        continue
      }
      match.pinned = true
      for (let p = match.parent; p && !p.isRoot; p = p.parent) p.hasPin = true
      this.pinned.push(match)
    }
  }

  /**
   * The one value all of a node's bytes hold, -1 when they differ, or null
   * when that is not known (no bytes, or past the check limits).
   */
  fillOf(node) {
    if (node.fill !== undefined) return node.fill
    let fill = null
    const length = node.end - node.offset
    if (this.bytes && length <= ZERO_CAP_FIELD && length <= this.zeroBudget) {
      this.zeroBudget -= length
      const v = this.bytes[node.offset]
      fill = v
      for (let i = node.offset + 1; i < node.end; i++) {
        if (this.bytes[i] !== v) {
          fill = -1
          break
        }
      }
    }
    node.fill = fill
    return fill
  }

  allZero(node) {
    const fill = this.fillOf(node)
    return fill === null ? null : fill === 0
  }

  /** Whether a node may be folded into a box with its neighbours at all. */
  mergeable(node) {
    return !node.merged && !node.pinned && !node.hasPin && node.kind !== 'magic' && !this.pointerOf(node)
  }

  /**
   * The value a node is filled with, when it may join a run of one repeated
   * byte other than zero; null otherwise.
   */
  fillerByte(node) {
    if (!this.mergeable(node)) return null
    const fill = this.fillOf(node)
    return fill !== null && fill > 0 ? fill : null
  }

  /** Dull: nothing set, reserved, or one repeated byte (see mergeDull). */
  isFiller(node) {
    return Boolean(this.dull(node)) || node.fillDull === true
  }

  /** Why a node carries nothing ('zero' or 'reserved'), or null when it does. */
  dull(node) {
    if (node.dullness !== undefined) return node.dullness
    let why = null
    if (node.merged) why = node.merged.reason
    else if (this.mergeable(node)) {
      const reserved = node.rawKind === 'padding' || node.src.padding === true || PAD_NAME.test(node.name)
      const zero = this.allZero(node)
      if (zero === true) why = 'zero'
      else if (reserved) why = 'reserved'
      else if (zero === null && node.src.value !== undefined && node.src.value !== null && zeroText(node.value)) {
        why = !this.hasChildren(node) || this.rawChildren(node).every(c => zeroText(c.value) || c.rawKind === 'padding') ? 'zero' : null
      }
    }
    node.dullness = why
    return why
  }

  /**
   * Children as the poster shows them: runs of fields that carry nothing are
   * merged into one node, and runs with the same layout become repeats.
   * @returns {Array<object>}  nodes, and repeats ({ type: 'repeat' })
   */
  units(node) {
    if (node.units) return node.units
    const raw = node.merged ? [] : this.rawChildren(node)
    node.units = this.findRepeats(this.mergeDull(raw, node), node)
    return node.units
  }

  mergeDull(raw, parent) {
    // Runs of one repeated byte other than zero first
    const filled = new Map()
    for (let i = 0; i < raw.length;) {
      const v = this.fillerByte(raw[i])
      if (v === null) {
        i++
        continue
      }
      let j = i + 1
      while (j < raw.length && raw[j].offset === raw[j - 1].end && this.fillerByte(raw[j]) === v) j++
      const bytes = raw[j - 1].end - raw[i].offset
      if (j - i >= FILL_RUN_FIELDS && bytes >= FILL_RUN_BYTES) filled.set(i, { end: j, fill: v })
      else if ((j - i >= 2 && bytes >= FILL_RUN_BYTES) || bytes >= FILL_ALONE) for (let k = i; k < j; k++) raw[k].fillDull = true
      i = j
    }
    const out = []
    let run = []
    const flush = () => {
      if (run.length >= 2) out.push(this.mergedNode(run, parent))
      else out.push(...run)
      run = []
    }
    for (let i = 0; i < raw.length; i++) {
      const node = raw[i]
      const fillRun = filled.get(i)
      if (fillRun) {
        flush()
        out.push(this.mergedNode(raw.slice(i, fillRun.end), parent, fillRun.fill))
        i = fillRun.end - 1
        continue
      }
      const why = this.dull(node)
      if (why && (run.length === 0 || run[run.length - 1].end === node.offset)) run.push(node)
      else {
        flush()
        if (why) run.push(node)
        else out.push(node)
      }
    }
    flush()
    return out
  }

  /** One box for a run of fields; `fill` is the byte they all hold, when that is what joins them. */
  mergedNode(run, parent, fill = null) {
    const first = run[0]
    const last = run[run.length - 1]
    let reason
    if (fill !== null) reason = 'fill'
    else {
      const reasons = new Set(run.map(n => this.dull(n)))
      reason = reasons.size === 1 ? [...reasons][0] : 'mixed'
    }
    const what = run.every(n => n.region) ? 'regions' : 'fields'
    const says = reason === 'fill'
      ? `all ${fill.toString(16).toUpperCase().padStart(2, '0')}`
      : reason === 'zero' ? (this.bytes ? 'all zero' : 'all zero or empty') : reason === 'reserved' ? 'reserved or padding' : 'zero or reserved'
    const merged = { count: run.length, first: first.name, last: last.name, reason }
    if (fill !== null) merged.fill = fill
    return {
      id: this.nextId++,
      src: { name: '', offset: first.offset, length: last.end - first.offset },
      name: `${first.name} to ${last.name}`,
      value: `${run.length} ${what}, ${says}`,
      // The name and value say it all
      description: '',
      kind: 'padding',
      rawKind: 'padding',
      offset: first.offset,
      end: last.end,
      level: parent.level + 1,
      parent,
      region: run.every(n => n.region),
      merged,
      dullness: reason,
      raw: [],
      units: []
    }
  }

  signature(node, withStem) {
    if (node.merged) return `m${node.id}`
    const kids = node.region ? node.raw : node.src.children
    const stem = nameStem(node.name)
    if (!Array.isArray(kids) || kids.length === 0) return `L${node.end - node.offset}|${node.kind}|${stem}`
    let sig = `C${node.kind}|${kids.length}`
    const n = Math.min(kids.length, SIG_CHILDREN)
    if ((this.sigBudget -= n) < 0) return `u${node.id}`
    for (let i = 0; i < n; i++) {
      const k = kids[i]
      sig += k && typeof k === 'object' ? `|${text(k.name).slice(0, 40)}:${text(k.kind)}:${Array.isArray(k.children) && k.children.length ? 1 : 0}` : '|?'
    }
    return withStem ? `${sig}|${stem}` : sig
  }

  findRepeats(list, parent) {
    if (list.length < REPEAT_MIN) return list
    const loose = list.map(n => this.signature(n, false))
    const runs = []
    let i = 0
    while (i < list.length) {
      let j = i + 1
      while (j < list.length && loose[j] === loose[i] && loose[i][0] !== 'm' && loose[i][0] !== 'u') j++
      // Inside a table (never at the top level, where unrelated records can share a shape)
      if (j - i >= REPEAT_MIN && !parent.isRoot && (j - i) >= TABLE_SHARE * list.length) runs.push([i, j])
      else if (j - i >= REPEAT_MIN) {
        // Same layout but not a table: names must match as well
        let a = i
        while (a < j) {
          const stem = nameStem(list[a].name)
          let b = a + 1
          while (b < j && nameStem(list[b].name) === stem) b++
          if (b - a >= REPEAT_MIN) runs.push([a, b])
          a = b
        }
      }
      i = j
    }
    if (!runs.length) return list
    const out = []
    let at = 0
    for (const [a, b] of runs) {
      out.push(...list.slice(at, a))
      out.push(this.repeat(list.slice(a, b), parent))
      at = b
    }
    out.push(...list.slice(at))
    return out
  }

  repeat(members, parent) {
    const id = this.nextRepeat++
    const shownIdx = [0]
    for (let k = 1; k < members.length - 1; k++) if (members[k].pinned || members[k].hasPin) shownIdx.push(k)
    shownIdx.push(members.length - 1)
    const unit = members.every(m => m.region) ? 'regions' : 'entries'
    const rep = { type: 'repeat', id, parent, members, count: members.length, unit, cut: parent.isRoot ? false : listCut(parent), summary: null }
    rep.shown = shownIdx.map((index, k) => {
      const entry = members[index]
      entry.rep = { rep, index, role: k === 0 ? 'first' : k === shownIdx.length - 1 ? 'last' : 'pinned' }
      return entry
    })
    return rep
  }

  /** What the entries of a repeat share, in plain words. */
  summarise(rep) {
    if (rep.summary) return rep.summary
    const members = rep.members
    const examined = members.slice(0, SUMMARY_ENTRIES)
    const lengths = members.map(m => m.end - m.offset)
    const min = Math.min(...lengths)
    const max = Math.max(...lengths)
    const unit = rep.unit
    const size = min === max ? `of ${plural(min, 'byte')}` : `of ${formatNumber(min)} to ${plural(max, 'byte')}`
    const sentences = [`${formatNumber(rep.count)} ${unit} ${size}${rep.cut ? ' (the list is longer; only the first ' + formatNumber(SIBLING_CAP) + ' were read)' : ''}.`]

    const childLists = examined.map(m => (m.region ? [] : Array.isArray(m.src.children) ? m.src.children.slice(0, SUMMARY_CHILDREN) : []))
    const width = Math.min(...childLists.map(c => c.length))
    const shared = []
    const zeros = []
    const steps = []
    for (let j = 0; j < width && examined.length >= 2; j++) {
      const name = text(childLists[0][j]?.name)
      if (!name) continue
      // Only values every entry states
      if (childLists.some(c => c[j]?.value === undefined || c[j]?.value === null)) continue
      const values = childLists.map(c => text(c[j].value))
      if (values.every(v => v === values[0])) {
        if (zeroText(values[0])) zeros.push(name)
        else shared.push(`${truncateText(name, 28)} ${shortValue(values[0])}`)
        continue
      }
      const numbers = values.map(leadingNumber)
      if (numbers.some(n => !n)) continue
      const step = numbers[1].n - numbers[0].n
      if (step === 0n) continue
      let constant = true
      for (let k = 2; k < numbers.length && constant; k++) constant = numbers[k].n - numbers[k - 1].n === step
      if (constant) steps.push({ name: truncateText(name, 28), step, hex: numbers[0].hex })
    }
    if (shared.length) sentences.push(`All the same: ${listWords(shared.slice(0, 4), shared.length - 4, 'more')}.`)
    if (zeros.length) sentences.push(zeros.length === 1 ? `${zeros[0]} is zero or empty in every one.` : `${listWords(zeros.slice(0, 2), zeros.length - 2, 'other fields')} are zero or empty in every one.`)
    if (steps.length) {
      const parts = steps.slice(0, 3).map((s, k) => {
        const up = s.step > 0n
        const amount = formatBig(up ? s.step : -s.step, s.hex)
        return k === 0 ? `${s.name} goes ${up ? 'up' : 'down'} by ${amount} each time` : `${s.name} by ${amount}`
      })
      sentences.push(`${parts.join(', ')}.`)
    }
    if (!shared.length && !steps.length && examined.every((m, k) => k === 0 || m.offset === examined[k - 1].end)) {
      sentences.push(unit === 'regions' ? 'Each starts where the one before ends.' : 'They follow one another with no gaps.')
    }
    const stems = new Map()
    for (const m of examined) {
      const name = text(m.name).replace(/^\s*(\[[^\]]*\]|#\d+)\s*/, '').trim()
      stems.set(name, (stems.get(name) || 0) + 1)
    }
    if (stems.size > 1 && stems.size < examined.length) {
      const names = [...stems].slice(0, 5).map(([n, c]) => (c > 1 ? `${truncateText(n, 20)} ×${c}` : truncateText(n, 20)))
      sentences.push(`Names: ${listWords(names, stems.size - 5, 'more')}.`)
    }
    if (examined.length < members.length && (shared.length || steps.length || zeros.length)) {
      sentences.push(`(Checked across the first ${formatNumber(examined.length)}.)`)
    }
    rep.summary = sentences.join(' ')
    return rep.summary
  }

  /** The first pointer at or under a node, looking at a few nodes only. */
  pointerOf(node) {
    if (node.ptr !== undefined) return node.ptr
    node.ptr = this.findPointer(node)
    return node.ptr
  }

  /**
   * A node's own pointer, or the first one among a few of its descendants.
   * When a parser sets the same target on a header and on its pointer field
   * (a section header and its PointerToRawData), the field's position is
   * the more precise one, so that one is returned.
   */
  findPointer(node) {
    if (node.merged) return null
    const own = isCount(node.src.target) && node.src.target < this.size ? node.src.target : null
    if (node.region) return own === null ? null : { offset: node.offset, length: node.end - node.offset, target: own }
    let budget = POINTER_SCAN
    let first = null
    const queue = Array.isArray(node.src.children) ? [node.src.children] : []
    for (let q = 0; q < queue.length && budget > 0; q++) {
      const kids = queue[q]
      for (let i = 0; i < kids.length && budget > 0; i++, budget--) {
        const k = kids[i]
        if (!validNode(k, this.size) || k === node.src) continue
        if (isCount(k.target) && k.target < this.size) {
          const found = { offset: k.offset, length: Math.floor(k.length), target: k.target }
          if (own === null || k.target === own) return found
          first = first || found
        }
        if (Array.isArray(k.children) && k.children.length) queue.push(k.children)
      }
    }
    if (own !== null) return { offset: node.offset, length: node.end - node.offset, target: own }
    return first
  }

  /** Shows one more entry of a repeat as a box of its own. */
  showEntry(rep, index) {
    const entry = rep.members[index]
    entry.rep = { rep, index, role: 'more' }
    rep.shown = [...rep.shown, entry].sort((a, b) => a.rep.index - b.rep.index)
  }

  hideEntry(rep, index) {
    const entry = rep.members[index]
    rep.shown = rep.shown.filter(n => n !== entry)
    if (entry.rep?.role === 'more') delete entry.rep
  }
}

function reparent(node, parent) {
  node.parent = parent
  const shift = parent.level + 1 - node.level
  if (shift === 0) return
  // Levels below are fixed up as they are created; only already-built ones move
  const stack = [node]
  let guard = 0
  while (stack.length && guard++ < VISIT_BUDGET) {
    const n = stack.pop()
    n.level += shift
    if (Array.isArray(n.raw)) stack.push(...n.raw)
  }
}

function listCut(node) {
  return !node.region && !node.merged && Array.isArray(node.src?.children) && node.src.children.length > SIBLING_CAP
}

function lowerBound(list, offset) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].offset < offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function formatNumber(n) {
  return Math.round(n).toLocaleString('en-US')
}

function plural(n, word) {
  return `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`
}

function formatBig(n, hex) {
  return hex ? '0x' + n.toString(16).toUpperCase() : n.toLocaleString('en-US')
}

function truncateText(value, max) {
  const chars = Array.from(text(value))
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('').trimEnd() + '…'
}

// A value as short as it can be: '0xA0000000 (Executable, …)' becomes '0xA0000000'
function shortValue(value) {
  const v = text(value)
  const cut = v.indexOf(' (')
  return truncateText(cut > 0 && (v.length > 24 || cut <= 12) ? v.slice(0, cut) : v, 24)
}

function listWords(items, more, moreWord) {
  const all = more > 0 ? [...items, `${formatNumber(more)} ${moreWord}`] : items
  if (all.length <= 1) return all.join('')
  return `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`
}
