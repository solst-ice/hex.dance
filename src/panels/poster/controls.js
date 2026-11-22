// Pure helpers behind the Poster section's controls: which "Include"
// switches can do anything for a file, the options the controls hand to
// buildPoster, and the sentence that says what the poster shows. No DOM.

import { hexOffset } from './layout.js'

export const MODES = ['tour', 'auto', 'selection', 'field']
export const DEFAULT_MODE = 'tour'
export const PAGE_PROPORTIONS = [['landscape', 'Landscape'], ['portrait', 'Portrait'], ['square', 'Square'], ['tall', 'Tall']]
export const TALL_MAX_ROWS = 120
export const INCLUDE = [
  ['pointers', 'Pointers'],
  ['unusual', "What's unusual"],
  ['text', 'Readable text'],
  ['tiles', 'Section tiles'],
  ['memory', 'Memory map']
]
export const DEFAULT_SHOW = { pointers: true, unusual: true, text: true, tiles: true, memory: true }

// Tree nodes looked at when searching for a pointer field, whatever the parser produced
const TARGET_VISITS = 20000

/** Whether any field in the tree points somewhere, looking at no more than `budget` nodes. */
export function hasPointerField(fields, budget = TARGET_VISITS) {
  const stack = Array.isArray(fields) ? [fields] : []
  let visits = 0
  while (stack.length) {
    const list = stack.pop()
    for (let i = 0; i < list.length; i++) {
      if (++visits > budget) return false
      const field = list[i]
      if (!field) continue
      if (Number.isSafeInteger(field.target) && field.target >= 0) return true
      if (Array.isArray(field.children) && field.children.length) stack.push(field.children)
    }
  }
  return false
}

// Sections looked at when counting those that take up memory
const SECTION_VISITS = 1024

/** How many sections take up memory (have a size there), up to `enough`. */
function sectionsInMemory(sections, enough = 2) {
  let n = 0
  for (const s of sections.slice(0, SECTION_VISITS)) {
    if (typeof s?.memSize === 'number' && s.memSize > 0 && Number.isFinite(s.memSize) && ++n >= enough) break
  }
  return n
}

/**
 * Which "Include" switches can change the poster of this file. A guess from
 * the analysis, for before a poster is built; the poster's own `available`
 * is exact. Readable text is found by the planner, so it is never guessed.
 * @param {import('../../analysis/types.js').Analysis|null} analysis
 * @returns {{ pointers: boolean, unusual: boolean, text: boolean, tiles: boolean, memory: boolean }}
 */
export function includeChoices(analysis) {
  const list = Array.isArray(analysis?.image?.sections) ? analysis.image.sections : []
  const regions = Array.isArray(analysis?.regions) ? analysis.regions.length : 0
  return {
    pointers: hasPointerField(analysis?.fields),
    unusual: Array.isArray(analysis?.unusual) && analysis.unusual.length > 0,
    text: false,
    tiles: list.length > 0 || regions >= 3,
    // One section is one wedge: the diagram needs two that take up memory
    memory: sectionsInMemory(list) >= 2
  }
}

/**
 * The options the Poster section passes to buildPoster.
 * @param {Object} state
 * @param {{ bytesPerRow: number, depth: number, maxLabels: number, style: string, proportion: string }} state.options
 * @param {string} state.mode          'tour' | 'auto' | 'selection' | 'field'
 * @param {{ start: number, end: number }|null} state.range
 * @param {number} state.fieldIndex
 * @param {Array<{ offset: number, length: number }>} state.pins
 * @param {{ pointers: boolean, unusual: boolean, text: boolean, tiles: boolean, memory: boolean }} state.show
 */
export function posterOptions({ options, mode, range, fieldIndex, pins, show }) {
  const out = {
    mode: MODES.includes(mode) ? mode : DEFAULT_MODE,
    range: range || null,
    fieldIndex: Number.isSafeInteger(fieldIndex) ? fieldIndex : 0,
    bytesPerRow: options.bytesPerRow,
    depth: options.depth,
    maxLabels: options.maxLabels,
    style: options.style,
    proportion: options.proportion,
    pins: (pins || []).map(pin => ({ offset: pin.offset, length: pin.length })),
    show: {
      pointers: show?.pointers !== false,
      unusual: show?.unusual !== false,
      text: show?.text !== false,
      tiles: show?.tiles !== false,
      memory: show?.memory !== false
    }
  }
  // A tall page has room for more rows; otherwise the planner's default holds
  if (options.proportion === 'tall') out.maxRows = TALL_MAX_ROWS
  return out
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/**
 * Rows drawn, grouped into the separate places of the file they come from:
 * rows next to each other in the file are one place.
 * @returns {{ rows: number, places: Array<{ start: number, end: number }> }}
 */
export function shownPlaces(items) {
  const places = []
  let rows = 0
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.type !== 'row') continue
    rows++
    const last = places[places.length - 1]
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end)
    else places.push({ start: item.start, end: item.end })
  }
  return { rows, places }
}

/** Pinned fields that have a label on the poster. */
export function pinnedOnPoster(plan, pins) {
  const labels = Array.isArray(plan?.labels) ? plan.labels : []
  return (pins || []).filter(pin => labels.some(label => label.offset === pin.offset && label.length === pin.length)).length
}

/**
 * The sentence under the controls. True whatever the mode: rows can come
 * from anywhere in the file, with breaks between them.
 * @param {ReturnType<import('./plan.js').planPoster>} plan
 * @param {{ pins?: Array<{ offset: number, length: number }> }} [extra]
 * @returns {string}
 */
export function describePlan(plan, { pins = [] } = {}) {
  if (!plan) return ''
  const { rows, places } = shownPlaces(plan.items)
  if (rows === 0) return 'Nothing to show.'
  const labels = Array.isArray(plan.labels) ? plan.labels.length : 0
  const limit = Number.isFinite(plan.maxRows) ? ` (at most ${plan.maxRows}, long runs collapsed)` : ''
  const first = places[0]
  const last = places[places.length - 1]
  let text
  if (places.length === 1) {
    text = `Showing ${hexOffset(first.start)}–${hexOffset(first.end - 1)} in ${plural(rows, 'row')}${limit} with ${plural(labels, 'label')}.`
  } else {
    text = `Showing ${plural(rows, 'row')}${limit} from ${places.length} places between ${hexOffset(first.start)} and ${hexOffset(last.end - 1)}, with ${plural(labels, 'label')}.`
  }
  const omitted = Number.isSafeInteger(plan.omittedLabels) ? plan.omittedLabels : 0
  if (omitted > 0) text += ` ${plural(omitted, 'more field')} ${omitted === 1 ? 'is' : 'are'} not labelled.`
  // Pins only shape the whole-file poster; in the other modes the hint under the chips says so
  if (pins.length && (plan.mode === undefined || plan.mode === 'tour')) {
    // The planner's own count: a pinned field with children is labelled through them
    const counted = plan.pins?.labelled
    const labelled = Number.isSafeInteger(counted) ? Math.min(counted, pins.length) : pinnedOnPoster(plan, pins)
    if (labelled === pins.length) text += pins.length === 1 ? ' The pinned field is labelled.' : ` All ${pins.length} pinned fields are labelled.`
    else text += ` ${labelled} of ${plural(pins.length, 'pinned field')} ${labelled === 1 ? 'is' : 'are'} labelled.`
  }
  return text
}
