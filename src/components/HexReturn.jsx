/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useRef, useState } from 'react'
import { useFile, useSelectionActions, useWorkspace } from '../state/hooks.js'

// Below this width the hex view scrolls away with the page
const NARROW = '(max-width: 1199.98px)'
// A jump counts as unseen when less than this share of the hex view shows
const SEEN_SHARE = 0.5
// The reader scrolling this share of a screen on their own dismisses the button
const DISMISS_SHARE = 0.4

function hexView() {
  return document.querySelector('.workspace .hexview')
}

function visibleShare(element) {
  const rect = element.getBoundingClientRect()
  if (rect.height <= 0) return 0
  const visible = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
  return Math.max(0, visible) / rect.height
}

/**
 * Narrow screens only: after a jump made while the hex view is scrolled
 * away, offers to show it, and then to go back to where the reader was.
 */
function HexReturn({ panels }) {
  const { subscribeJumps } = useSelectionActions()
  const { file } = useFile()
  const { activePanelId } = useWorkspace()
  // null, or { mode: 'show' | 'back', anchor, top, title?, back? }: `anchor` is
  // what the reader is looking at and `top` where it was on screen, so that
  // scrolling on their own (and not content changing height elsewhere,
  // which the browser compensates for) is what dismisses the button
  const [state, setState] = useState(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const activeRef = useRef(activePanelId)
  activeRef.current = activePanelId
  // What had focus when the jump was made (e.g. a row in a list), to return to
  const origin = useRef(null)

  useEffect(() => subscribeJumps(() => {
    if (!window.matchMedia(NARROW).matches) return
    const view = hexView()
    if (!view || visibleShare(view) >= SEEN_SHARE) return
    const focused = document.activeElement
    const anchor = focused?.closest?.('section.panel-section') ||
      document.querySelector(`section.panel-section[data-section="${activeRef.current}"]`)
    if (!anchor) return
    origin.current = focused
    setState({ mode: 'show', anchor, top: anchor.getBoundingClientRect().top })
  }), [subscribeJumps])

  // Another file makes it moot
  useEffect(() => setState(null), [file])

  useEffect(() => {
    if (!state) return
    let frame = 0
    const check = () => {
      frame = 0
      const current = stateRef.current
      if (!current) return
      const view = hexView()
      const moved = current.anchor.isConnected
        ? Math.abs(current.anchor.getBoundingClientRect().top - current.top)
        : Infinity
      if (!window.matchMedia(NARROW).matches || !view || moved > window.innerHeight * DISMISS_SHARE ||
        (current.mode === 'show' && visibleShare(view) >= SEEN_SHARE)) {
        setState(null)
      }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check) }
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [state])

  if (!state) return null

  const onClick = () => {
    if (state.mode === 'show') {
      const view = hexView()
      if (!view) return setState(null)
      const section = state.anchor.dataset.section
      const title = panels.find(panel => panel.id === section)?.title || 'the sections'
      const back = { anchor: state.anchor, top: state.anchor.getBoundingClientRect().top }
      window.scrollBy({ top: view.getBoundingClientRect().top - 8, behavior: 'instant' })
      setState({ mode: 'back', anchor: view, top: view.getBoundingClientRect().top, title, back })
    } else {
      const { back } = state
      if (back.anchor.isConnected) {
        window.scrollBy({ top: back.anchor.getBoundingClientRect().top - back.top, behavior: 'instant' })
      }
      setState(null)
      const target = origin.current
      if (target instanceof HTMLElement && target.isConnected && target !== document.body) {
        target.focus({ preventScroll: true })
      }
    }
  }

  return (
    <button type="button" className="hex-return" onClick={onClick}>
      <span className={`hex-return-arrow${state.mode === 'back' ? ' is-down' : ''}`} aria-hidden="true" />
      {state.mode === 'show' ? 'Show in hex view' : `Back to ${state.title}`}
    </button>
  )
}

export default HexReturn
