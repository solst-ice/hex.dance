/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PanelSection from './PanelSection'
import SectionNav from './SectionNav'
import { PANELS, panelBadge } from '../panels/index.js'
import { useWorkspace } from '../state/hooks.js'
import {
  chooseCurrent, classifySections, keepOnScreen, mountCandidates, nearestFirst, nextMounted, readCollapsed, sameSet, setCollapsed,
  toggleAll, writeCollapsed
} from '../lib/sections.js'

const EMPTY = new Set()
const NONE = []
// A section mounts once it is within this many screens of the visible area
const NEAR_SCREENS = 1
// Gap between the section index and a section header brought to the top
const HEADER_GAP_PX = 8
// Time between two sections mounting, so each shows its real height first
const SETTLE_MS = 120
// How long the page keeps a section in place while the sections around it
// load and change height, unless the reader scrolls first
const HOLD_MS = 1500

const ALL_SECTION_IDS = PANELS.filter(panel => (panel.placement || 'tab') === 'tab').map(panel => panel.id)

const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index])

function storage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// An instant scroll of our own: a jump never animates past the sections in
// between, so they are not mounted on the way. `ownScroll` marks it so the
// scroll event it causes does not count as the reader's.
function scrollPage(delta, ownScroll) {
  ownScroll.current = true
  window.scrollBy({ top: delta, behavior: 'instant' })
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

function trimSpacer(spacer) {
  const height = spacerHeight(spacer)
  if (!height) return
  const below = document.documentElement.scrollHeight - window.innerHeight - window.scrollY
  if (below > 0) setSpacerHeight(spacer, height - Math.min(height, below))
}

// Scrolls so the element's top edge is at `top`, making room below if needed
function alignTo(element, top, spacer, ownScroll) {
  const delta = element.getBoundingClientRect().top - top
  if (Math.abs(delta) < 1) return
  if (delta > 0) {
    const room = document.documentElement.scrollHeight - window.innerHeight - window.scrollY
    if (room < delta) setSpacerHeight(spacer, spacerHeight(spacer) + delta - room)
  }
  scrollPage(delta, ownScroll)
}

// How far under the index the reader's eye is taken to be; a sliver of a
// section showing above that is not what they are reading
const PROBE_PX = 40

// What the reader is looking at: the top edge of the first section that
// starts in the visible area. Sections above it, including the one spanning
// the top of the area, grow upwards out of the reader's way as they load.
// When one section fills the whole area, the element just under the index
// (or the box of a list it scrolls within: a row moves when its list
// scrolls, which is not the page moving).
function findAnchor(stack, top, bottom, boxes, elements) {
  if (!stack) return null
  const line = top + PROBE_PX
  const edge = boxes.find(box => box.top >= line && box.top < bottom)
  if (edge) return { element: elements.get(edge.id), top: edge.top }
  const rect = stack.getBoundingClientRect()
  let element = document.elementFromPoint(rect.left + rect.width / 2, line)
  if (!element || !stack.contains(element)) return null
  for (let node = element.parentElement; node && node !== stack; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) element = node
  }
  return { element, top: element.getBoundingClientRect().top }
}

/**
 * Every available 'tab' panel, in registry order, as a collapsible section,
 * under a pinned index of the sections. Sections mount when they come near
 * the screen and stop reacting to changes while they are off screen (see
 * PanelSection). Also keeps `activePanelId` pointing at the current section
 * and carries out `openPanel` requests.
 */
function SectionStack({ panels, analysis, file, status }) {
  const { activePanelId, reveal, revealPanel, setCurrentPanel } = useWorkspace()
  const shownIds = useMemo(() => panels.map(panel => panel.id), [panels])

  const [collapsed, setCollapsedState] = useState(() => readCollapsed(storage()))
  // candidates: ids that may mount now, nearest first (see mountCandidates);
  // onScreen: ids with some part in the visible area
  const [view, setView] = useState({ candidates: NONE, onScreen: EMPTY })
  const [mountedState, setMountedState] = useState({ file, ids: EMPTY, view: null })

  // Mounted sections: near and expanded ones join one at a time, collapsed
  // ones leave, and a new file keeps only the ones on screen. Each
  // measurement lets at most one in, however often this renders.
  let mounted = mountedState.ids
  if (mountedState.file !== file) mounted = keepOnScreen(mounted, view.onScreen)
  const fresh = mountedState.view !== view
  mounted = nextMounted(mounted, { shown: shownIds, collapsed, near: fresh ? view.candidates : NONE, limit: 1 })
  if (mounted !== mountedState.ids || file !== mountedState.file || fresh) {
    setMountedState({ file, ids: mounted, view })
  }

  const stackRef = useRef(null)
  const navRef = useRef(null)
  const elements = useRef(new Map())
  const toggles = useRef(new Map())
  const latest = useRef(null)
  latest.current = { shownIds, activePanelId, setCurrentPanel, status, collapsed }
  const lastMount = useRef(-Infinity)
  const settleTimer = useRef(0)
  // Whether the reader is scrolling through the sections (so the ones ahead
  // may load early), as opposed to having just opened a file or jumped
  const scrolling = useRef(false)
  // Set while a scroll of our own is under way, so it does not count as the reader's
  const ownScroll = useRef(false)
  // { id, top, until }: keep this section's top edge at `top` while the page settles
  const hold = useRef(null)
  // Empty space after the last section (see alignTo)
  const spacerRef = useRef(null)
  const lastTops = useRef(new Map())
  // What the reader is looking at (see findAnchor) and where it was. Sections
  // above it change height as they mount and load; the page scrolls by as
  // much so that it stays put. The browser's own scroll anchoring is off for
  // the sections (it anchors to whatever is hidden under the index).
  const reading = useRef(null)
  // { element, top, until }: what the reader last clicked or typed into
  const interaction = useRef(null)

  // Top of the area sections scroll through: just under the pinned index
  const areaTop = useCallback(() => {
    const nav = navRef.current
    return nav ? nav.getBoundingClientRect().bottom : 0
  }, [])

  // Where a section header lands when it is brought to the top
  const targetTop = useCallback(() => {
    const nav = navRef.current
    if (!nav) return 0
    const stickyTop = parseFloat(getComputedStyle(nav).top) || 0
    return stickyTop + nav.offsetHeight + HEADER_GAP_PX
  }, [])

  // Undoes any movement of the section being read, or of a held one
  const keepPlace = useCallback(() => {
    const held = hold.current
    if (held) {
      const element = elements.current.get(held.id)
      if (!element || performance.now() > held.until) hold.current = null
      else {
        alignTo(element, held.top, spacerRef.current, ownScroll)
        return
      }
    }
    // Something the reader just clicked or typed into stays put; otherwise
    // what they are looking at (see findAnchor)
    const touched = interaction.current
    const touchedLive = touched && touched.element.isConnected && performance.now() < touched.until
    const mark = touchedLive ? touched : reading.current
    if (!mark || !mark.element.isConnected) return
    alignTo(mark.element, mark.top, spacerRef.current, ownScroll)
  }, [])

  const measure = useCallback(() => {
    const { shownIds, activePanelId, setCurrentPanel } = latest.current
    const now = performance.now()
    keepPlace()
    if (!hold.current) trimSpacer(spacerRef.current)

    const top = areaTop()
    const bottom = window.innerHeight
    const boxes = []
    for (const id of shownIds) {
      const element = elements.current.get(id)
      if (!element) continue
      const rect = element.getBoundingClientRect()
      boxes.push({ id, top: rect.top, bottom: rect.bottom })
      lastTops.current.set(id, rect.top)
    }
    const views = classifySections(boxes, { top, bottom, margin: bottom * NEAR_SCREENS })
    const onScreen = new Set(views.filter(entry => entry.onScreen).map(entry => entry.id))
    const sinceLastMount = now - lastMount.current
    const candidates = mountCandidates({
      near: nearestFirst(views),
      onScreen,
      status: latest.current.status,
      sinceLastMount,
      settleMs: SETTLE_MS,
      scrolling: scrolling.current
    })
    setView(previous => (sameList(previous.candidates, candidates) && sameSet(previous.onScreen, onScreen)
      ? previous
      : { candidates, onScreen }))
    // Look again once the last newcomer has settled
    if (sinceLastMount < SETTLE_MS && !settleTimer.current) {
      settleTimer.current = setTimeout(() => {
        settleTimer.current = 0
        measure()
      }, SETTLE_MS - sinceLastMount + 1)
    }

    const current = chooseCurrent(activePanelId, views, Math.max(0, bottom - Math.max(0, top)))
    if (current !== activePanelId) setCurrentPanel(current)

    // Only while the index is pinned, i.e. the reader is in the sections
    const nav = navRef.current
    const pinned = nav && nav.getBoundingClientRect().top <= (parseFloat(getComputedStyle(nav).top) || 0) + 1
    reading.current = pinned ? findAnchor(stackRef.current, top, bottom, boxes, elements.current) : null
  }, [areaTop, keepPlace])

  useEffect(() => () => clearTimeout(settleTimer.current), [])

  // Measure after scrolling, resizing and any change of the page's height
  useEffect(() => {
    let frame = 0
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; ownScroll.current = false; measure() })
    }
    let lastY = window.scrollY
    const onScroll = () => {
      const moved = window.scrollY - lastY
      lastY = window.scrollY
      if (ownScroll.current) ownScroll.current = false
      else {
        // The reader's own scrolling moves what they look at by as much
        scrolling.current = true
        interaction.current = null
        if (reading.current) reading.current = { ...reading.current, top: reading.current.top - moved }
      }
      schedule()
    }
    // The reader taking over the scrolling ends any hold
    const release = () => { hold.current = null }
    // Whatever the reader clicks or types into in the sections stays put
    // while the panel reacts, e.g. a tree row they expand
    const touch = (event) => {
      const stack = stackRef.current
      const target = event.target
      if (!stack || !(target instanceof Element) || !stack.contains(target) || navRef.current?.contains(target)) return
      interaction.current = { element: target, top: target.getBoundingClientRect().top, until: performance.now() + HOLD_MS }
    }
    window.addEventListener('pointerdown', touch, { capture: true })
    window.addEventListener('keydown', touch, { capture: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', schedule)
    for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
      window.addEventListener(type, release, { passive: true, capture: true })
    }
    // Runs after layout and before paint, so a shift is undone unseen
    const observer = new ResizeObserver(() => {
      keepPlace()
      schedule()
    })
    if (stackRef.current) observer.observe(stackRef.current)
    observer.observe(document.body)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pointerdown', touch, { capture: true })
      window.removeEventListener('keydown', touch, { capture: true })
      window.removeEventListener('resize', schedule)
      for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
        window.removeEventListener(type, release, { capture: true })
      }
      observer.disconnect()
    }
  }, [measure, keepPlace])

  const holdSection = useCallback((id, top) => {
    hold.current = { id, top, until: performance.now() + HOLD_MS }
  }, [])

  // A new file: keep the current section where it was while the sections
  // around it change (e.g. after opening a file from inside a section)
  const previousFile = useRef(file)
  useLayoutEffect(() => {
    if (previousFile.current === file) return
    previousFile.current = file
    scrolling.current = false
    const { activePanelId } = latest.current
    const top = lastTops.current.get(activePanelId)
    if (activePanelId && top !== undefined && top < window.innerHeight && top > -window.innerHeight) {
      holdSection(activePanelId, top)
    }
  }, [file, holdSection])

  // A section joined: note when, so the next one waits for it to settle
  const previousMounted = useRef(mounted)
  useLayoutEffect(() => {
    const before = previousMounted.current
    previousMounted.current = mounted
    if ([...mounted].some(id => !before.has(id))) lastMount.current = performance.now()
  }, [mounted])

  // Re-measure when sections appear, collapse or mount, or the file's state
  // changes, even if the page's height happens not to change
  useLayoutEffect(() => {
    measure()
  }, [measure, shownIds, collapsed, mounted, status])

  const hasPanels = panels.length > 0
  // How far below the top of the window things in the sections column must
  // be to clear the pinned header and index, for focus and find-in-page
  // (applied as scroll-margin-top in sections.css; scroll-padding on the
  // page would also push the pinned hex column's controls down)
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const root = document.documentElement
    const update = () => {
      const stickyTop = parseFloat(getComputedStyle(nav).top) || 0
      root.style.setProperty('--sections-top', `${stickyTop + nav.offsetHeight + HEADER_GAP_PX}px`)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(nav)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      root.style.removeProperty('--sections-top')
    }
  }, [hasPanels])

  // openPanel / the index: expand the section, bring its header to the top
  const handledReveal = useRef(0)
  useLayoutEffect(() => {
    if (!reveal || reveal.seq === handledReveal.current) return
    const element = elements.current.get(reveal.id)
    // Not shown (yet): try again once it is
    if (!element) return
    handledReveal.current = reveal.seq
    setCollapsedState(previous => {
      const next = setCollapsed(previous, reveal.id, false)
      if (next !== previous) writeCollapsed(storage(), next)
      return next
    })
    const top = targetTop()
    scrolling.current = false
    alignTo(element, top, spacerRef.current, ownScroll)
    holdSection(reveal.id, top)
    element.classList.remove('is-arriving')
    // Restart the arrival flash
    void element.offsetWidth
    element.classList.add('is-arriving')
    if (reveal.focus) toggles.current.get(reveal.id)?.focus({ preventScroll: true })
    measure()
  }, [reveal, shownIds, targetTop, holdSection, measure])

  const toggleSection = useCallback((id) => {
    setCollapsedState(previous => {
      const next = setCollapsed(previous, id)
      writeCollapsed(storage(), next)
      return next
    })
    latest.current.setCurrentPanel(id)
  }, [])

  // Collapse all / expand all, keeping the reader's place: the current
  // section (or the first one on screen) stays where it is
  const keep = useRef(null)
  const toggleEverything = useCallback(() => {
    const { shownIds, activePanelId, collapsed } = latest.current
    const top = areaTop()
    // Collapsing everything asks for the list of sections: bring the first
    // header up under the index (if the page is scrolled past it)
    const collapsing = !shownIds.every(id => collapsed.has(id))
    const candidates = collapsing ? shownIds.slice(0, 1) : [activePanelId, ...shownIds]
    for (const id of candidates) {
      if (collapsing) {
        const rect = elements.current.get(id)?.getBoundingClientRect()
        if (rect) keep.current = { id, top: rect.top }
        break
      }
      const rect = elements.current.get(id)?.getBoundingClientRect()
      if (rect && rect.bottom > top && rect.top < window.innerHeight) {
        keep.current = { id, top: rect.top }
        break
      }
    }
    setCollapsedState(previous => {
      const next = toggleAll(previous, latest.current.shownIds, ALL_SECTION_IDS)
      writeCollapsed(storage(), next)
      return next
    })
  }, [areaTop])

  useLayoutEffect(() => {
    const kept = keep.current
    if (!kept) return
    keep.current = null
    const element = elements.current.get(kept.id)
    if (!element) return
    const target = Math.max(kept.top, targetTop())
    scrolling.current = false
    alignTo(element, target, spacerRef.current, ownScroll)
    holdSection(kept.id, target)
  }, [collapsed, targetTop, holdSection])

  const chooseSection = useCallback((id) => revealPanel(id, { focus: true }), [revealPanel])

  const registerSection = useCallback((id, element) => {
    if (element) elements.current.set(id, element)
    else elements.current.delete(id)
  }, [])

  const registerToggle = useCallback((id, element) => {
    if (element) toggles.current.set(id, element)
    else toggles.current.delete(id)
  }, [])

  const items = useMemo(
    () => panels.map(panel => ({ panel, badge: panelBadge(panel, analysis) })),
    [panels, analysis]
  )

  if (panels.length === 0) return null

  const currentId = shownIds.includes(activePanelId) ? activePanelId : null

  return (
    <div className="section-stack" ref={stackRef}>
      <SectionNav
        ref={navRef}
        items={items}
        currentId={currentId}
        collapsed={collapsed}
        allCollapsed={shownIds.every(id => collapsed.has(id))}
        onChoose={chooseSection}
        onToggleAll={toggleEverything}
      />
      {items.map(({ panel, badge }) => (
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
      <div className="section-stack-end" ref={spacerRef} aria-hidden="true" />
    </div>
  )
}

export default memo(SectionStack)
