/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PanelSection from './PanelSection'
import SectionNav from './SectionNav'
import { PANELS, panelBadge } from '../panels/index.js'
import { useWorkspace } from '../state/hooks.js'
import {
  SECTION_GROUPS, chooseCurrentAcross, classifySections, columnCount, columnGroups, keepOnScreen, mountCandidates,
  nearestFirst, nextMounted, readCollapsed, sameSet, sectionGroup, setCollapsed, splitByGroup, toggleAll, writeCollapsed
} from '../lib/sections.js'

const EMPTY = new Set()
const NONE = []
// A section mounts once it is within this many screens (or column heights) of the visible area
const NEAR_SCREENS = 1
// Gap between the top of the area sections scroll through and a section header brought to the top
const HEADER_GAP_PX = 8
// Time between two sections mounting in one column, so each shows its real height first
const SETTLE_MS = 120
// How long a column keeps a section in place while the sections around it
// load and change height, unless the reader scrolls it first
const HOLD_MS = 1500
// Where the hex view and the sections sit side by side (see workspace.css)
const WIDE = '(min-width: 1200px)'

const ALL_SECTION_IDS = PANELS.filter(panel => (panel.placement || 'tab') === 'tab').map(panel => panel.id)

const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index])
const sameLists = (a, b) => a.length === b.length && a.every((list, index) => sameList(list, b[index]))

function storage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/*
 * A scroller is what scrolls a run of sections: the page itself when there
 * is one column (`element` is null), or a column's own scroll box when there
 * are several. Each one keeps the reader's place on its own, so a section
 * loading in one column never moves another:
 *   groups       the section groups it shows (see columnGroups)
 *   spacer       empty space after its last section (see alignTo)
 *   hold         { id, top, base, until }: keep this section's top edge at `top` while it settles
 *   reading      { element, top, base }: what the reader is looking at (see findAnchor) and where
 *   interaction  { element, top, base, until }: what the reader last clicked or typed into
 *                (`base`: the scroller's origin when `top` was taken, see originOf)
 *   scrolling    whether the reader is scrolling it (so sections ahead may load early), as opposed
 *                to having just opened a file or jumped
 *   scrollTop    where it was scrolled to, as far as we know: our own scrolls update it at once,
 *                so any other difference is the reader's (see syncScroll)
 *   readerMoved  the reader scrolled it since the last measurement
 */
function makeScroller(element, spacer, groups) {
  return {
    element,
    spacer,
    groups,
    hold: null,
    reading: null,
    interaction: null,
    scrolling: false,
    scrollTop: scrollTopOf(element),
    readerMoved: false
  }
}

function scrollTopOf(element) {
  return element ? element.scrollTop : window.scrollY
}

// How much further down it can scroll
function roomBelow({ element }) {
  return element
    ? element.scrollHeight - element.clientHeight - element.scrollTop
    : document.documentElement.scrollHeight - window.innerHeight - window.scrollY
}

// Where a scroller's content is measured from: a column's own top edge,
// which moves when the index above it changes height (that is not the
// column scrolling); the page's sections are measured from the window
function originOf({ element }) {
  return element ? element.getBoundingClientRect().top : 0
}

// Takes in any scrolling the reader has done since we last looked: what they
// look at moves by as much. Called before every correction of our own, since
// the reader's scroll can land before its scroll event (in the same frame as
// one of ours, it would otherwise be undone as if it were ours).
function syncScroll(scroller) {
  const now = scrollTopOf(scroller.element)
  const moved = now - scroller.scrollTop
  if (Math.abs(moved) < 0.5) return
  scroller.scrollTop = now
  scroller.scrolling = true
  scroller.readerMoved = true
  scroller.interaction = null
  if (scroller.reading) scroller.reading = { ...scroller.reading, top: scroller.reading.top - moved }
}

// An instant scroll of our own: a jump never animates past the sections in
// between, so they are not mounted on the way
function scrollBy(scroller, delta) {
  syncScroll(scroller)
  const target = scroller.element || window
  target.scrollBy({ top: delta, behavior: 'instant' })
  scroller.scrollTop = scrollTopOf(scroller.element)
}

// The spacer is empty space after the last section, so that any section,
// even the last one, can be brought to the top; otherwise the sections before
// it would come on screen (and load). It only ever shrinks out of sight.
function spacerHeight(spacer) {
  return spacer ? spacer.offsetHeight : 0
}

function setSpacerHeight(spacer, height) {
  if (spacer) spacer.style.height = `${Math.max(0, Math.round(height))}px`
}

function trimSpacer(scroller) {
  const height = spacerHeight(scroller.spacer)
  if (!height) return
  const below = roomBelow(scroller)
  if (below > 0) setSpacerHeight(scroller.spacer, height - Math.min(height, below))
}

// Scrolls so the element's top edge is at `top`, making room below if needed
function alignTo(scroller, element, top) {
  const delta = element.getBoundingClientRect().top - top
  if (Math.abs(delta) < 1) return
  if (delta > 0) {
    const room = roomBelow(scroller)
    if (room < delta) setSpacerHeight(scroller.spacer, spacerHeight(scroller.spacer) + delta - room)
  }
  scrollBy(scroller, delta)
}

// How far under the top of the area the reader's eye is taken to be; a
// sliver of a section showing above that is not what they are reading
const PROBE_PX = 40

// What the reader is looking at in one scroller: at the start of it, its
// first section; otherwise the top edge of the first section that starts in
// the visible area. Sections above it, including the one spanning the top of
// the area, grow upwards out of the reader's way as they load. When one
// section fills the whole area, the element just under the top (or the box
// of a list it scrolls within: a row moves when its list scrolls, which is
// not the column moving). `container` holds the scroller's sections.
function findAnchor(container, top, bottom, boxes, elements) {
  if (!container) return null
  const line = top + PROBE_PX
  // At the start of the column nothing above can grow: content grows down
  if (boxes[0] && boxes[0].top >= top - 1) return { element: elements.get(boxes[0].id), top: boxes[0].top }
  const edge = boxes.find(box => box.top >= line && box.top < bottom)
  if (edge) return { element: elements.get(edge.id), top: edge.top }
  const rect = container.getBoundingClientRect()
  let element = document.elementFromPoint(rect.left + rect.width / 2, line)
  if (!element || !container.contains(element)) return null
  for (let node = element.parentElement; node && node !== container; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) element = node
  }
  return { element, top: element.getBoundingClientRect().top }
}

/**
 * Every available 'tab' panel, in registry order, as a collapsible section,
 * under a pinned index of the sections. On wide screens the sections fill
 * one, two or three columns, by group (see columnCount and columnGroups);
 * with several, each column scrolls on its own and the page does not.
 * Sections mount when they come near the screen in their column and stop
 * reacting to changes while they are off screen (see PanelSection). Also
 * keeps `activePanelId` pointing at the current section and carries out
 * `openPanel` requests. `footer` ends the last column.
 */
function SectionStack({ panels, analysis, file, status, footer = null }) {
  const { activePanelId, reveal, revealPanel, setCurrentPanel } = useWorkspace()
  const shownIds = useMemo(() => panels.map(panel => panel.id), [panels])
  const groupOf = useMemo(() => new Map(panels.map(panel => [panel.id, sectionGroup(panel)])), [panels])

  const [collapsed, setCollapsedState] = useState(() => readCollapsed(storage()))
  // candidates: for each column, ids that may mount now, nearest first (see
  // mountCandidates); onScreen: ids with some part in their column's visible area
  const [view, setView] = useState({ candidates: NONE, onScreen: EMPTY })
  const [mountedState, setMountedState] = useState({ file, ids: EMPTY, view: null })
  // How many columns there are. The markup carries it as data-columns, set
  // before paint; this copy is for the attributes rendered here.
  const [columns, setColumns] = useState(1)

  // Mounted sections: near and expanded ones join one at a time in each
  // column, collapsed ones leave, and a new file keeps only the ones on
  // screen. Each measurement lets at most one in per column, however often
  // this renders: a newcomer only pushes away the sections after it in its
  // own column.
  let mounted = mountedState.ids
  if (mountedState.file !== file) mounted = keepOnScreen(mounted, view.onScreen)
  const fresh = mountedState.view !== view
  mounted = nextMounted(mounted, { shown: shownIds, collapsed, near: NONE })
  if (fresh) {
    for (const near of view.candidates) mounted = nextMounted(mounted, { shown: shownIds, collapsed, near, limit: 1 })
  }
  if (mounted !== mountedState.ids || file !== mountedState.file || fresh) {
    setMountedState({ file, ids: mounted, view })
  }

  const stackRef = useRef(null)
  const navRef = useRef(null)
  // The three group containers, the one that holds the last two, and the
  // spacer at the end of each group
  const column1Ref = useRef(null)
  const column2Ref = useRef(null)
  const column3Ref = useRef(null)
  const restRef = useRef(null)
  const spacer1Ref = useRef(null)
  const spacer2Ref = useRef(null)
  const spacer3Ref = useRef(null)
  const elements = useRef(new Map())
  const toggles = useRef(new Map())
  const latest = useRef(null)
  latest.current = { shownIds, groupOf, activePanelId, setCurrentPanel, status, collapsed }
  // When each section last mounted, so the next one in its column waits for it to settle
  const mountedAt = useRef(new Map())
  const settleTimer = useRef(0)
  // The scrollers of the current layout (see makeScroller), and the number
  // of columns they were made for (0 until measured)
  const scrollers = useRef([])
  const columnsRef = useRef(0)
  const lastTops = useRef(new Map())
  // Watches every section's size, so a column can undo a shift before paint
  const sizeObserver = useRef(null)

  // The scroller that shows a section
  const scrollerOf = useCallback((id) => {
    const group = latest.current.groupOf.get(id)
    return scrollers.current.find(scroller => scroller.groups.includes(group)) || null
  }, [])

  const idsIn = useCallback((scroller) => {
    const { shownIds, groupOf } = latest.current
    return shownIds.filter(id => scroller.groups.includes(groupOf.get(id)))
  }, [])

  // The area sections scroll through: under the pinned index for the page,
  // a column's own box otherwise
  const areaOf = useCallback((scroller) => {
    const { element } = scroller
    if (element) {
      const top = element.getBoundingClientRect().top + element.clientTop
      return { top, bottom: Math.min(top + element.clientHeight, window.innerHeight) }
    }
    const nav = navRef.current
    return { top: nav ? nav.getBoundingClientRect().bottom : 0, bottom: window.innerHeight }
  }, [])

  // Where a section header lands when it is brought to the top
  const targetTop = useCallback((scroller) => {
    if (scroller.element) return areaOf(scroller).top + HEADER_GAP_PX
    const nav = navRef.current
    if (!nav) return 0
    const stickyTop = parseFloat(getComputedStyle(nav).top) || 0
    return stickyTop + nav.offsetHeight + HEADER_GAP_PX
  }, [areaOf])

  // Undoes any movement of the section being read in one scroller, or of a held one
  const keepPlace = useCallback((scroller) => {
    syncScroll(scroller)
    const held = scroller.hold
    if (held) {
      const element = elements.current.get(held.id)
      if (!element || performance.now() > held.until) scroller.hold = null
      else {
        alignTo(scroller, element, held.top + originOf(scroller) - held.base)
        return
      }
    }
    // Something the reader just clicked or typed into stays put; otherwise
    // what they are looking at (see findAnchor)
    const touched = scroller.interaction
    const touchedLive = touched && touched.element.isConnected && performance.now() < touched.until
    const mark = touchedLive ? touched : scroller.reading
    if (!mark || !mark.element.isConnected) return
    alignTo(scroller, mark.element, mark.top + originOf(scroller) - mark.base)
  }, [])

  const holdSection = useCallback((scroller, id, top) => {
    scroller.hold = { id, top, base: originOf(scroller), until: performance.now() + HOLD_MS }
  }, [])

  const measure = useCallback(() => {
    const list = scrollers.current
    if (list.length === 0) return
    const { shownIds, groupOf, activePanelId, setCurrentPanel, status } = latest.current
    const now = performance.now()
    for (const scroller of list) {
      keepPlace(scroller)
      if (!scroller.hold) trimSpacer(scroller)
    }

    const nav = navRef.current
    const onScreen = new Set()
    const candidates = []
    const columnViews = []
    let wait = Infinity
    for (const scroller of list) {
      const { top, bottom } = areaOf(scroller)
      const boxes = []
      let lastMount = -Infinity
      for (const id of shownIds) {
        if (!scroller.groups.includes(groupOf.get(id))) continue
        const element = elements.current.get(id)
        if (!element) continue
        const rect = element.getBoundingClientRect()
        boxes.push({ id, top: rect.top, bottom: rect.bottom })
        lastTops.current.set(id, rect.top)
        lastMount = Math.max(lastMount, mountedAt.current.get(id) ?? -Infinity)
      }
      const screen = scroller.element ? scroller.element.clientHeight : window.innerHeight
      const views = classifySections(boxes, { top, bottom, margin: screen * NEAR_SCREENS })
      const shown = new Set(views.filter(entry => entry.onScreen).map(entry => entry.id))
      for (const id of shown) onScreen.add(id)
      const sinceLastMount = now - lastMount
      candidates.push(mountCandidates({
        near: nearestFirst(views),
        onScreen: shown,
        status,
        sinceLastMount,
        settleMs: SETTLE_MS,
        scrolling: scroller.scrolling
      }))
      if (sinceLastMount < SETTLE_MS) wait = Math.min(wait, SETTLE_MS - sinceLastMount)
      columnViews.push({ views, areaHeight: Math.max(0, bottom - Math.max(0, top)) })

      // Only once the reader has scrolled into the sections: before that,
      // content just grows downwards and there is nothing to keep in place.
      // A column is in its sections when it is scrolled at all; the page when
      // it is scrolled and the index is stuck, i.e. pushed down from its own
      // place at the top of the sections. Merely being at its sticky offset is
      // not enough: on wide screens that is also where it starts, and while
      // the header settles the offset can even push it down unscrolled.
      const scrolledIn = scroller.element
        ? scroller.element.scrollTop > 0
        : Boolean(window.scrollY > 0 && nav && stackRef.current &&
          stackRef.current.getBoundingClientRect().top < nav.getBoundingClientRect().top - 1)
      const anchor = scrolledIn ? findAnchor(scroller.element || stackRef.current, top, bottom, boxes, elements.current) : null
      scroller.reading = anchor && { ...anchor, base: originOf(scroller) }
    }
    setView(previous => (sameLists(previous.candidates, candidates) && sameSet(previous.onScreen, onScreen)
      ? previous
      : { candidates, onScreen }))
    // Look again once the last newcomer has settled
    if (wait < Infinity && !settleTimer.current) {
      settleTimer.current = setTimeout(() => {
        settleTimer.current = 0
        measure()
      }, wait + 1)
    }

    // The column the reader scrolled decides, if the current section has gone
    const index = list.findIndex(scroller => scroller.readerMoved)
    for (const scroller of list) scroller.readerMoved = false
    const current = chooseCurrentAcross(activePanelId, columnViews, index >= 0 ? index : null)
    if (current !== activePanelId) setCurrentPanel(current)
  }, [areaOf, keepPlace])

  useEffect(() => () => clearTimeout(settleTimer.current), [])

  // How far below the top of the window things in the sections must be to
  // clear the pinned header and index, for focus and find-in-page (applied as
  // scroll-margin-top in sections.css; scroll-padding on the page would also
  // push the pinned hex column's controls down). Columns start under the
  // index, so there only a small gap is needed.
  const updateSectionsTop = useCallback(() => {
    const nav = navRef.current
    if (!nav) return
    let top = HEADER_GAP_PX
    if (columnsRef.current <= 1) top += (parseFloat(getComputedStyle(nav).top) || 0) + nav.offsetHeight
    document.documentElement.style.setProperty('--sections-top', `${top}px`)
  }, [])

  // The number of columns follows the width of the sections area. Only the
  // data-columns attribute changes (sections.css decides from it which
  // containers scroll), never the markup, so no panel is remounted.
  const applyColumns = useCallback(() => {
    const stack = stackRef.current
    if (!stack) return
    const count = columnCount(stack.clientWidth, { wide: window.matchMedia(WIDE).matches })
    if (count === columnsRef.current) return

    // Keep the current section where it was on screen, as near as it can be
    const { activePanelId } = latest.current
    const element = elements.current.get(activePanelId)
    const before = columnsRef.current ? scrollerOf(activePanelId) : null
    let offset = null
    if (element && before) {
      const area = areaOf(before)
      const rect = element.getBoundingClientRect()
      if (rect.top < area.bottom && rect.bottom > area.top) offset = rect.top - area.top
    }

    columnsRef.current = count
    stack.dataset.columns = String(count)
    const spacers = [spacer1Ref.current, spacer2Ref.current, spacer3Ref.current]
    const boxes = [column1Ref.current, column2Ref.current, column3Ref.current]
    for (const spacer of spacers) setSpacerHeight(spacer, 0)
    scrollers.current = columnGroups(count).map(groups => {
      const last = groups[groups.length - 1] - 1
      const element = count === 1 ? null : groups.length === 1 ? boxes[groups[0] - 1] : restRef.current
      return makeScroller(element, spacers[last], groups)
    })
    updateSectionsTop()

    const scroller = element && offset !== null ? scrollerOf(activePanelId) : null
    if (scroller) {
      const top = Math.max(targetTop(scroller), areaOf(scroller).top + offset)
      alignTo(scroller, element, top)
      holdSection(scroller, activePanelId, top)
    }
    setColumns(count)
    measure()
  }, [areaOf, holdSection, measure, scrollerOf, targetTop, updateSectionsTop])

  const hasPanels = panels.length > 0
  useLayoutEffect(() => {
    const stack = stackRef.current
    if (!stack) return
    applyColumns()
    const observer = new ResizeObserver(applyColumns)
    observer.observe(stack)
    return () => {
      observer.disconnect()
      scrollers.current = []
      columnsRef.current = 0
    }
  }, [hasPanels, applyColumns])

  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    updateSectionsTop()
    const observer = new ResizeObserver(updateSectionsTop)
    observer.observe(nav)
    window.addEventListener('resize', updateSectionsTop)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateSectionsTop)
      document.documentElement.style.removeProperty('--sections-top')
    }
  }, [hasPanels, updateSectionsTop])

  // Measure after scrolling, resizing and any change of a section's size
  useEffect(() => {
    let frame = 0
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          measure()
        })
      }
    }
    // The column (scroll box) an event happened in, if any
    const scrollerAt = (target) => (target instanceof Node
      ? scrollers.current.find(scroller => scroller.element && scroller.element.contains(target))
      : undefined)
    // Scroll events do not bubble, so listen for them all on the way down
    const onScroll = (event) => {
      const target = event.target
      const scroller = scrollers.current.find(entry => (entry.element ? entry.element === target : target === document))
      if (scroller) syncScroll(scroller)
      if (scroller || target === document) schedule()
    }
    // The reader taking over the scrolling of a column ends its hold; outside
    // the columns (or with one column, the page) it ends every hold
    const release = (event) => {
      const own = scrollerAt(event.target)
      for (const scroller of scrollers.current) if (!own || scroller === own) scroller.hold = null
    }
    // Whatever the reader clicks or types into in a section stays put while
    // the panel reacts, e.g. a tree row they expand
    const touch = (event) => {
      const target = event.target
      const stack = stackRef.current
      if (!stack || !(target instanceof Element)) return
      const section = target.closest('section.panel-section')
      if (!section || !stack.contains(section)) return
      const scroller = scrollerOf(section.dataset.section)
      if (scroller) {
        scroller.interaction = {
          element: target, top: target.getBoundingClientRect().top, base: originOf(scroller), until: performance.now() + HOLD_MS
        }
      }
    }
    window.addEventListener('pointerdown', touch, { capture: true })
    window.addEventListener('keydown', touch, { capture: true })
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
      window.addEventListener(type, release, { passive: true, capture: true })
    }
    // Runs after layout and before paint, so a shift is undone unseen
    const observer = new ResizeObserver(() => {
      for (const scroller of scrollers.current) keepPlace(scroller)
      schedule()
    })
    if (stackRef.current) observer.observe(stackRef.current)
    observer.observe(document.body)
    for (const element of elements.current.values()) observer.observe(element)
    sizeObserver.current = observer
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('pointerdown', touch, { capture: true })
      window.removeEventListener('keydown', touch, { capture: true })
      window.removeEventListener('resize', schedule)
      for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
        window.removeEventListener(type, release, { capture: true })
      }
      observer.disconnect()
      sizeObserver.current = null
    }
  }, [measure, keepPlace, scrollerOf, hasPanels])

  // A new file: keep the current section where it was while the sections
  // around it change (e.g. after opening a file from inside a section)
  const previousFile = useRef(file)
  useLayoutEffect(() => {
    if (previousFile.current === file) return
    previousFile.current = file
    for (const scroller of scrollers.current) scroller.scrolling = false
    const { activePanelId } = latest.current
    const top = lastTops.current.get(activePanelId)
    const scroller = scrollerOf(activePanelId)
    if (scroller && top !== undefined && top < window.innerHeight && top > -window.innerHeight) {
      holdSection(scroller, activePanelId, top)
    }
  }, [file, holdSection, scrollerOf])

  // A section joined: note when, so the next one in its column waits for it to settle
  const previousMounted = useRef(mounted)
  useLayoutEffect(() => {
    const before = previousMounted.current
    previousMounted.current = mounted
    const now = performance.now()
    for (const id of mounted) if (!before.has(id)) mountedAt.current.set(id, now)
  }, [mounted])

  // After collapse all / expand all (see toggleEverything): put each column's
  // kept section back where it was. This runs before the measurement below,
  // so that what mounts next is what is on screen once the columns have
  // settled, not what was on screen before.
  const keep = useRef(null)
  useLayoutEffect(() => {
    const kept = keep.current
    if (!kept) return
    keep.current = null
    for (const { scroller, id, top } of kept) {
      const element = elements.current.get(id)
      if (!element || !scrollers.current.includes(scroller)) continue
      const target = Math.max(top, targetTop(scroller))
      scroller.scrolling = false
      alignTo(scroller, element, target)
      holdSection(scroller, id, target)
    }
  }, [collapsed, targetTop, holdSection])

  // Re-measure when sections appear, collapse or mount, or the file's state
  // changes, even if no size happens to change
  useLayoutEffect(() => {
    measure()
  }, [measure, shownIds, collapsed, mounted, status])

  // openPanel / the index: expand the section, bring its header to the top of its column
  const handledReveal = useRef(0)
  useLayoutEffect(() => {
    if (!reveal || reveal.seq === handledReveal.current) return
    const element = elements.current.get(reveal.id)
    const scroller = scrollerOf(reveal.id)
    // Not shown (yet): try again once it is
    if (!element || !scroller) return
    handledReveal.current = reveal.seq
    setCollapsedState(previous => {
      const next = setCollapsed(previous, reveal.id, false)
      if (next !== previous) writeCollapsed(storage(), next)
      return next
    })
    const top = targetTop(scroller)
    scroller.scrolling = false
    alignTo(scroller, element, top)
    holdSection(scroller, reveal.id, top)
    element.classList.remove('is-arriving')
    // Restart the arrival flash
    void element.offsetWidth
    element.classList.add('is-arriving')
    if (reveal.focus) toggles.current.get(reveal.id)?.focus({ preventScroll: true })
    measure()
  }, [reveal, shownIds, columns, targetTop, holdSection, measure, scrollerOf])

  const toggleSection = useCallback((id) => {
    setCollapsedState(previous => {
      const next = setCollapsed(previous, id)
      writeCollapsed(storage(), next)
      return next
    })
    latest.current.setCurrentPanel(id)
  }, [])

  // Collapse all / expand all, keeping the reader's place in each column:
  // the current section (or the first one on screen) stays where it is
  const toggleEverything = useCallback(() => {
    const { shownIds, activePanelId, collapsed } = latest.current
    // Collapsing everything asks for the list of sections: bring each
    // column's first header up to its top (if it is scrolled past it)
    const collapsing = !shownIds.every(id => collapsed.has(id))
    const kept = []
    for (const scroller of scrollers.current) {
      const ids = idsIn(scroller)
      const { top, bottom } = areaOf(scroller)
      const candidates = collapsing ? ids.slice(0, 1) : [activePanelId, ...ids].filter(id => ids.includes(id))
      for (const id of candidates) {
        const rect = elements.current.get(id)?.getBoundingClientRect()
        if (rect && (collapsing || (rect.bottom > top && rect.top < bottom))) {
          kept.push({ scroller, id, top: rect.top })
          break
        }
      }
    }
    keep.current = kept
    setCollapsedState(previous => {
      const next = toggleAll(previous, latest.current.shownIds, ALL_SECTION_IDS)
      writeCollapsed(storage(), next)
      return next
    })
  }, [areaOf, idsIn])

  const chooseSection = useCallback((id) => revealPanel(id, { focus: true }), [revealPanel])

  const registerSection = useCallback((id, element) => {
    const previous = elements.current.get(id)
    if (previous && previous !== element) sizeObserver.current?.unobserve(previous)
    if (element) {
      elements.current.set(id, element)
      sizeObserver.current?.observe(element)
    } else elements.current.delete(id)
  }, [])

  const registerToggle = useCallback((id, element) => {
    if (element) toggles.current.set(id, element)
    else toggles.current.delete(id)
  }, [])

  const items = useMemo(
    () => panels.map(panel => ({ panel, badge: panelBadge(panel, analysis), group: sectionGroup(panel) })),
    [panels, analysis]
  )
  // One list per group; the index lists them in the same order
  const grouped = useMemo(() => splitByGroup(items, item => item.group), [items])
  const navItems = useMemo(() => grouped.flat(), [grouped])

  if (panels.length === 0) return footer

  const currentId = shownIds.includes(activePanelId) ? activePanelId : null
  const columnRefs = [column1Ref, column2Ref, column3Ref]
  const spacerRefs = [spacer1Ref, spacer2Ref, spacer3Ref]

  // One group's sections. Whether its container is a column of its own is
  // up to data-columns; it is only named as a group when it is one.
  const renderGroup = (index) => {
    const group = SECTION_GROUPS[index]
    const isColumn = columns === 3 || (columns === 2 && index === 0)
    return (
      <div
        className="section-column"
        data-group={group.id}
        ref={columnRefs[index]}
        role={columns > 1 ? 'group' : undefined}
        aria-label={columns > 1 ? group.label : undefined}
        tabIndex={isColumn ? 0 : undefined}
      >
        {grouped[index].map(({ panel, badge }) => (
          <PanelSection
            key={panel.id}
            panel={panel}
            badge={badge}
            file={file}
            expanded={!collapsed.has(panel.id)}
            mounted={mounted.has(panel.id)}
            live={view.onScreen.has(panel.id)}
            current={panel.id === currentId}
            onToggle={toggleSection}
            onActivate={setCurrentPanel}
            register={registerSection}
            registerToggle={registerToggle}
          />
        ))}
        <div className="section-column-end" data-group={group.id} ref={spacerRefs[index]} aria-hidden="true" />
        {index === SECTION_GROUPS.length - 1 && footer && <div className="section-stack-footer">{footer}</div>}
      </div>
    )
  }

  return (
    <div className="section-stack" ref={stackRef}>
      <SectionNav
        ref={navRef}
        items={navItems}
        currentId={currentId}
        collapsed={collapsed}
        allCollapsed={shownIds.every(id => collapsed.has(id))}
        onChoose={chooseSection}
        onToggleAll={toggleEverything}
      />
      <div className="section-columns">
        {renderGroup(0)}
        <div
          className="section-column-rest"
          ref={restRef}
          role={columns === 2 ? 'group' : undefined}
          aria-label={columns === 2 ? `${SECTION_GROUPS[1].label}; ${SECTION_GROUPS[2].label}` : undefined}
          tabIndex={columns === 2 ? 0 : undefined}
        >
          {renderGroup(1)}
          {renderGroup(2)}
        </div>
      </div>
    </div>
  )
}

export default memo(SectionStack)
