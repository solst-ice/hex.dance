/* eslint-disable react/prop-types -- the project does not use prop-types */
import { forwardRef, memo, useEffect, useRef } from 'react'

/**
 * The index of the sections, pinned at the top of the sections column: one
 * chip per section (the current one marked) and a button that collapses or
 * expands them all. On phones the chips scroll sideways in a single row.
 * `items` carry their group; a divider between two groups shows where one
 * column ends when there are several (see sections.css).
 */
const SectionNav = forwardRef(function SectionNav(
  { items, currentId, collapsed, allCollapsed, onChoose, onToggleAll },
  ref
) {
  const listRef = useRef(null)

  // Keep the current chip in view when the row scrolls sideways; only the
  // row scrolls, never the page
  useEffect(() => {
    const list = listRef.current
    if (!list || !currentId || list.scrollWidth <= list.clientWidth) return
    const chip = list.querySelector(`[data-section="${currentId}"]`)
    if (!chip) return
    const left = chip.offsetLeft - list.offsetLeft
    const right = left + chip.offsetWidth
    const pad = 24
    if (left < list.scrollLeft + pad) list.scrollLeft = Math.max(0, left - pad)
    else if (right > list.scrollLeft + list.clientWidth - pad) list.scrollLeft = right - list.clientWidth + pad
  }, [currentId])

  return (
    <nav className="section-nav" aria-label="Sections" ref={ref}>
      <ul className="section-nav-list" ref={listRef}>
        {items.map(({ panel, badge, group }, index) => {
          const isCurrent = panel.id === currentId
          const isCollapsed = collapsed.has(panel.id)
          const startsGroup = index > 0 && group !== items[index - 1].group
          return (
            <li key={panel.id} className={startsGroup ? 'section-nav-group-start' : undefined} data-group={group}>
              <button
                type="button"
                className={`section-nav-link${isCollapsed ? ' is-collapsed' : ''}`}
                data-section={panel.id}
                aria-current={isCurrent ? 'true' : undefined}
                onClick={() => onChoose(panel.id)}
                title={panel.description ? `${panel.title}: ${panel.description}` : panel.title}
              >
                {panel.title}
                {badge !== null && <span className="section-nav-badge">{badge}</span>}
                {isCollapsed && <span className="sr-only"> (collapsed)</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        className="section-nav-toggle-all"
        onClick={onToggleAll}
        aria-label={allCollapsed ? 'Expand all sections' : 'Collapse all sections'}
        title={allCollapsed ? 'Expand all sections' : 'Collapse all sections'}
      >
        <span className={`section-nav-toggle-icon${allCollapsed ? ' is-collapsed' : ''}`} aria-hidden="true" />
        <span className="section-nav-toggle-text">{allCollapsed ? 'Expand all' : 'Collapse all'}</span>
      </button>
    </nav>
  )
})

export default memo(SectionNav)
