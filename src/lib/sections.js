// Rules for the stacked panel sections, kept free of the DOM so they can be
// tested on their own: which sections are collapsed (remembered across files
// and visits), which are mounted, which are on screen, and which is current.

export const COLLAPSED_KEY = 'hexdance.sections.collapsed'

/**
 * @typedef {{ id: string, top: number, bottom: number }} SectionBox
 *   a section's position relative to the viewport (getBoundingClientRect)
 *
 * @typedef {Object} SectionView
 * @property {string} id
 * @property {boolean} near       within about one screen of the visible area: may mount
 * @property {boolean} onScreen   some of it is in the visible area: may react to changes
 * @property {number} visible     pixels of it in the visible area
 * @property {number} distance    pixels between it and the visible area (0 when on screen)
 * @property {number} height
 */

/**
 * @param {Pick<Storage, 'getItem'>|null|undefined} storage
 * @returns {Set<string>}
 */
export function readCollapsed(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(COLLAPSED_KEY) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * @param {Pick<Storage, 'setItem'>|null|undefined} storage
 * @param {Set<string>} collapsed
 */
export function writeCollapsed(storage, collapsed) {
  try {
    storage?.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed].sort()))
  } catch {
    // Storage unavailable or full: the choice lasts for this visit only
  }
}

/** @param {Set<string>} collapsed  @param {string} id  @param {boolean} [collapse]  defaults to toggling */
export function setCollapsed(collapsed, id, collapse = !collapsed.has(id)) {
  if (collapse === collapsed.has(id)) return collapsed
  const next = new Set(collapsed)
  if (collapse) next.add(id)
  else next.delete(id)
  return next
}

/** Whether every one of `ids` is collapsed (so the index offers "Expand all"). */
export function allCollapsed(collapsed, ids) {
  return ids.length > 0 && ids.every(id => collapsed.has(id))
}

/**
 * "Collapse all" collapses every section, including ones the current file
 * does not show, so the choice holds for the next file too; "Expand all"
 * expands every section.
 * @param {Set<string>} collapsed  @param {string[]} shownIds  @param {string[]} allIds
 */
export function toggleAll(collapsed, shownIds, allIds) {
  return allCollapsed(collapsed, shownIds) ? new Set() : new Set(allIds)
}

/**
 * Where each section is relative to the visible area, which runs from
 * `top` (under the sticky header and section index) to `bottom`.
 * @param {SectionBox[]} boxes
 * @param {{ top: number, bottom: number, margin: number }} area
 *   `margin`: how far beyond the visible area a section counts as near
 * @returns {SectionView[]}
 */
export function classifySections(boxes, { top, bottom, margin }) {
  return boxes.map(box => {
    const visible = Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top))
    const onScreen = box.bottom > top && box.top < bottom
    return {
      id: box.id,
      near: box.bottom > top - margin && box.top < bottom + margin,
      onScreen,
      visible,
      distance: onScreen ? 0 : Math.max(top - box.bottom, box.top - bottom),
      height: Math.max(0, box.bottom - box.top)
    }
  })
}

/**
 * The ids of the near sections, nearest first: those on screen in page
 * order, then the rest by their distance from the visible area.
 * @param {SectionView[]} views
 * @returns {string[]}
 */
export function nearestFirst(views) {
  return views
    .map((view, index) => ({ view, index }))
    .filter(({ view }) => view.near)
    .sort((a, b) => a.view.distance - b.view.distance || a.index - b.index)
    .map(({ view }) => view.id)
}

/**
 * The current section stays current while any of it is visible. Otherwise
 * the first section that is substantially visible (half of it, or a quarter
 * of the visible area for tall ones) takes over, else the most visible one.
 * With no section visible at all (the column is scrolled away), the current
 * one stays; with none chosen yet, the first one is taken.
 * @param {string|null} currentId
 * @param {SectionView[]} views   in page order
 * @param {number} areaHeight     height of the visible area
 * @returns {string|null}
 */
export function chooseCurrent(currentId, views, areaHeight) {
  if (views.length === 0) return currentId
  const current = views.find(view => view.id === currentId)
  if (current && current.visible > 0) return currentId
  const substantial = views.find(view => view.visible > 0 &&
    view.visible >= Math.min(view.height * 0.5, areaHeight * 0.25))
  if (substantial) return substantial.id
  let best = null
  for (const view of views) if (view.visible > 0 && (!best || view.visible > best.visible)) best = view
  if (best) return best.id
  return current ? currentId : views[0].id
}

/**
 * Which near sections may mount now. Mounting is paced so that a newcomer
 * shows its real height before the next one is chosen (panels are short
 * while a file loads, and a run of short sections would let far too many in):
 * nothing while the file's bytes are being read and nothing within
 * `settleMs` of the last mount. Sections off screen but near only mount
 * ahead of a reader who is scrolling (`scrolling`) once the analysis is in;
 * opening a file or jumping to a section mounts only what is on screen.
 * @param {{ near: string[], onScreen: Set<string>, status: string, sinceLastMount: number,
 *   settleMs: number, scrolling: boolean }} state
 * @returns {string[]}
 */
export function mountCandidates({ near, onScreen, status, sinceLastMount, settleMs, scrolling }) {
  if (status === 'reading' || status === 'idle' || sinceLastMount < settleMs) return []
  if (status === 'analyzing' || !scrolling) return near.filter(id => onScreen.has(id))
  return near
}

/**
 * Sections mount once they are expanded and near the visible area, and stay
 * mounted while they are expanded and shown. At most `limit` sections join
 * per call, nearest first: a section that mounts usually grows past its
 * placeholder and pushes the ones after it away, so the caller measures
 * again before letting more in. Returns `mounted` itself when nothing changes.
 * @param {Set<string>} mounted
 * @param {{ shown: string[], collapsed: Set<string>, near: string[], limit?: number }} state
 *   `near`: ids nearest first (see nearestFirst)
 * @returns {Set<string>}
 */
export function nextMounted(mounted, { shown, collapsed, near, limit = Infinity }) {
  const joining = new Set()
  for (const id of near) {
    if (joining.size >= limit) break
    if (!mounted.has(id) && !collapsed.has(id) && shown.includes(id)) joining.add(id)
  }
  const next = new Set()
  for (const id of shown) {
    if (collapsed.has(id)) continue
    if (mounted.has(id) || joining.has(id)) next.add(id)
  }
  return sameSet(next, mounted) ? mounted : next
}

/**
 * When another file is opened, only the sections on screen stay mounted;
 * the rest go back to their placeholders.
 * @param {Set<string>} mounted  @param {Set<string>} onScreen
 */
export function keepOnScreen(mounted, onScreen) {
  const next = new Set([...mounted].filter(id => onScreen.has(id)))
  return sameSet(next, mounted) ? mounted : next
}

/** @param {Set<unknown>} a  @param {Set<unknown>} b */
export function sameSet(a, b) {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

/*
 * Columns. On wide screens the sections area holds one or two columns
 * beside the hex column: two when both fit at a readable width. What goes
 * in which column is by meaning, the same for every file: each 'tab' panel
 * belongs to a group, the first group has the first column and the others
 * share the second.
 */

/** The groups of sections, in order; `label` names a group's column for assistive tech. */
export const SECTION_GROUPS = [
  { id: 1, label: 'What the file is' },
  { id: 2, label: 'Finding things in the bytes' },
  { id: 3, label: 'Seeing and playing' }
]

// Narrowest a column may be, and the space between two columns
export const MIN_COLUMN_PX = 640
export const COLUMN_GAP_PX = 24
// The most columns of sections beside the hex column, however wide the screen
export const MAX_COLUMNS = 2
// Widest a column may be; MAX_COLUMNS of them, with the gap, cap the sections area
export const MAX_COLUMN_PX = 1100
export const MAX_SECTIONS_PX = MAX_COLUMN_PX * MAX_COLUMNS + COLUMN_GAP_PX * (MAX_COLUMNS - 1)

/**
 * How many columns a sections area of `width` pixels holds: two when both
 * fit at `MIN_COLUMN_PX` each, otherwise one. Narrow screens (where the
 * sections run under the hex view) always get one.
 * @param {number} width  @param {{ wide?: boolean }} [options]
 * @returns {1|2}
 */
export function columnCount(width, { wide = true } = {}) {
  if (!wide || !(width > 0)) return 1
  return width >= MAX_COLUMNS * MIN_COLUMN_PX + (MAX_COLUMNS - 1) * COLUMN_GAP_PX ? MAX_COLUMNS : 1
}

/**
 * Which groups each column shows: with two columns the first group has a
 * column of its own and the others share the second.
 * @param {number} count
 * @returns {number[][]}
 */
export function columnGroups(count) {
  if (count >= 2) return [[1], [2, 3]]
  return [[1, 2, 3]]
}

/** A panel's group, 1 to 3; panels without a valid one join the first. */
export function sectionGroup(panel) {
  const group = panel?.group
  return SECTION_GROUPS.some(entry => entry.id === group) ? group : 1
}

/**
 * Splits items (in registry order) by group, keeping their order within
 * each group. Returns one list per entry of SECTION_GROUPS, empty ones included.
 * @template T
 * @param {T[]} items  @param {(item: T) => number} groupOf
 * @returns {T[][]}
 */
export function splitByGroup(items, groupOf) {
  const lists = SECTION_GROUPS.map(() => [])
  for (const item of items) {
    const index = SECTION_GROUPS.findIndex(entry => entry.id === groupOf(item))
    lists[Math.max(0, index)].push(item)
  }
  return lists
}

/**
 * The current section across several columns, each scrolling on its own.
 * The current one stays while any of it is visible in its column. Otherwise
 * the choice is made among the sections of the column the reader scrolled
 * (`scrolled`, an index into `columns`), or else of the current section's
 * own column (the first column when there is none), as chooseCurrent does
 * for one column. With nothing visible in that column, the current section
 * stays.
 * @param {string|null} currentId
 * @param {{ views: SectionView[], areaHeight: number }[]} columns
 * @param {number|null} [scrolled]
 * @returns {string|null}
 */
export function chooseCurrentAcross(currentId, columns, scrolled = null) {
  if (columns.length === 1) return chooseCurrent(currentId, columns[0].views, columns[0].areaHeight)
  const all = columns.flatMap(column => column.views)
  if (all.length === 0) return currentId
  const current = all.find(view => view.id === currentId)
  if (current && current.visible > 0) return currentId
  let index = scrolled ?? columns.findIndex(column => column.views.some(view => view.id === currentId))
  if (!(index >= 0 && index < columns.length)) index = 0
  const column = columns[index]
  if (!column.views.some(view => view.visible > 0)) return current ? currentId : all[0].id
  return chooseCurrent(currentId, column.views, column.areaHeight)
}
