import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COLLAPSED_KEY, COLUMN_GAP_PX, MAX_COLUMNS, MAX_COLUMN_PX, MAX_SECTIONS_PX, MIN_COLUMN_PX, SECTION_GROUPS, allCollapsed, chooseCurrent,
  chooseCurrentAcross, classifySections, columnCount, columnGroups, keepOnScreen, mountCandidates, nearestFirst, nextMounted,
  readCollapsed, sameSet, sectionGroup, setCollapsed, splitByGroup, toggleAll, writeCollapsed
} from './sections.js'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value) }
  }
}

test('reads and writes the collapsed sections, tolerating bad or missing storage', () => {
  const storage = memoryStorage()
  assert.deepEqual([...readCollapsed(storage)], [])
  writeCollapsed(storage, new Set(['strings', 'hashes']))
  assert.equal(storage.data[COLLAPSED_KEY], '["hashes","strings"]')
  assert.deepEqual([...readCollapsed(storage)].sort(), ['hashes', 'strings'])

  assert.equal(readCollapsed(memoryStorage({ [COLLAPSED_KEY]: '{not json' })).size, 0)
  assert.deepEqual([...readCollapsed(memoryStorage({ [COLLAPSED_KEY]: '["a", 3, null]' }))], ['a'])
  assert.equal(readCollapsed(memoryStorage({ [COLLAPSED_KEY]: '"a"' })).size, 0)
  assert.equal(readCollapsed(null).size, 0)
  const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(readCollapsed(throwing).size, 0)
  assert.doesNotThrow(() => writeCollapsed(throwing, new Set(['a'])))
})

test('toggles one section and keeps the set when nothing changes', () => {
  const none = new Set()
  const one = setCollapsed(none, 'strings')
  assert.deepEqual([...one], ['strings'])
  assert.equal(setCollapsed(one, 'strings', true), one)
  assert.deepEqual([...setCollapsed(one, 'strings')], [])
  assert.equal(setCollapsed(none, 'strings', false), none)
})

test('collapse all covers every section; expand all clears them', () => {
  const shown = ['overview', 'strings']
  const all = ['overview', 'symbols', 'strings']
  assert.equal(allCollapsed(new Set(), shown), false)
  assert.equal(allCollapsed(new Set(), []), false)
  const collapsed = toggleAll(new Set(['strings']), shown, all)
  assert.deepEqual([...collapsed].sort(), ['overview', 'strings', 'symbols'])
  assert.equal(allCollapsed(collapsed, shown), true)
  assert.equal(toggleAll(collapsed, shown, all).size, 0)
})

test('classifies sections against the visible area', () => {
  const area = { top: 100, bottom: 900, margin: 800 }
  const views = classifySections([
    { id: 'far-above', top: -1600, bottom: -800 },
    { id: 'above', top: -500, bottom: 120 },
    { id: 'hidden-under-index', top: 20, bottom: 100 },
    { id: 'middle', top: 300, bottom: 500 },
    { id: 'below', top: 1200, bottom: 1300 },
    { id: 'far-below', top: 1800, bottom: 2000 }
  ], area)
  const byId = Object.fromEntries(views.map(view => [view.id, view]))
  assert.deepEqual(views.map(view => view.id),
    ['far-above', 'above', 'hidden-under-index', 'middle', 'below', 'far-below'])
  assert.equal(byId['far-above'].near, false)
  assert.equal(byId.above.near, true)
  assert.equal(byId.above.onScreen, true)
  assert.equal(byId.above.visible, 20)
  assert.equal(byId['hidden-under-index'].onScreen, false)
  assert.equal(byId.middle.visible, 200)
  assert.equal(byId.middle.height, 200)
  assert.equal(byId.below.near, true)
  assert.equal(byId.below.onScreen, false)
  assert.equal(byId['far-below'].near, false)
})

test('keeps the current section while any of it shows', () => {
  const views = [
    { id: 'a', visible: 10, height: 600 },
    { id: 'b', visible: 500, height: 500 }
  ]
  assert.equal(chooseCurrent('a', views, 800), 'a')
})

test('moves to the first substantially visible section once the current one is gone', () => {
  const views = [
    { id: 'gone', visible: 0, height: 400 },
    { id: 'sliver', visible: 30, height: 600 },
    { id: 'short', visible: 60, height: 100 },
    { id: 'big', visible: 500, height: 2000 }
  ]
  assert.equal(chooseCurrent('gone', views, 800), 'short')
  // A tall section counts once it fills a quarter of the visible area
  assert.equal(chooseCurrent('gone', [views[0], { id: 'tall', visible: 200, height: 3000 }], 800), 'tall')
  // Nothing substantial: the most visible one
  assert.equal(chooseCurrent('gone', [
    { id: 'x', visible: 20, height: 1000 },
    { id: 'y', visible: 40, height: 1000 }
  ], 800), 'y')
})

test('keeps the current section while the column is scrolled away, and starts with the first', () => {
  const offscreen = [{ id: 'a', visible: 0, height: 100 }, { id: 'b', visible: 0, height: 100 }]
  assert.equal(chooseCurrent('b', offscreen, 800), 'b')
  assert.equal(chooseCurrent(null, offscreen, 800), 'a')
  assert.equal(chooseCurrent('not-shown', offscreen, 800), 'a')
  assert.equal(chooseCurrent('a', [], 800), 'a')
})

test('orders near sections: on screen in page order, then by distance', () => {
  const views = classifySections([
    { id: 'above', top: -300, bottom: -100 },
    { id: 'first', top: 50, bottom: 300 },
    { id: 'second', top: 300, bottom: 700 },
    { id: 'below', top: 900, bottom: 1000 },
    { id: 'far', top: 3000, bottom: 3100 }
  ], { top: 0, bottom: 800, margin: 800 })
  assert.deepEqual(views.map(view => view.distance), [100, 0, 0, 100, 2200])
  assert.deepEqual(nearestFirst(views), ['first', 'second', 'above', 'below'])
})

test('mounts expanded sections once near, keeps them while expanded and shown', () => {
  const shown = ['a', 'b', 'c', 'd']
  let mounted = new Set()
  mounted = nextMounted(mounted, { shown, collapsed: new Set(['b']), near: ['a', 'b'] })
  assert.deepEqual([...mounted], ['a'])
  // Scrolled on: a stays mounted although it is no longer near
  mounted = nextMounted(mounted, { shown, collapsed: new Set(['b']), near: ['c'] })
  assert.deepEqual([...mounted], ['a', 'c'])
  // Unchanged input keeps the identity
  assert.equal(nextMounted(mounted, { shown, collapsed: new Set(['b']), near: ['c'] }), mounted)
  // Collapsing unmounts; a section the file no longer shows is dropped
  mounted = nextMounted(mounted, { shown: ['b', 'c', 'd'], collapsed: new Set(['c']), near: [] })
  assert.deepEqual([...mounted], [])
})

test('lets sections in one at a time, nearest first, when limited', () => {
  const shown = ['a', 'b', 'c', 'd', 'e']
  const collapsed = new Set(['c'])
  let mounted = nextMounted(new Set(), { shown, collapsed, near: ['c', 'd', 'b', 'e'], limit: 1 })
  assert.deepEqual([...mounted], ['d'])
  mounted = nextMounted(mounted, { shown, collapsed, near: ['c', 'd', 'b', 'e'], limit: 1 })
  assert.deepEqual([...mounted], ['b', 'd'])
})

test('paces mounting while a file loads and right after a mount', () => {
  const near = ['b', 'a', 'c']
  const onScreen = new Set(['b'])
  const base = { near, onScreen, settleMs: 150, sinceLastMount: 1000, scrolling: true }
  assert.deepEqual(mountCandidates({ ...base, status: 'reading' }), [])
  assert.deepEqual(mountCandidates({ ...base, status: 'idle' }), [])
  assert.deepEqual(mountCandidates({ ...base, status: 'analyzing' }), ['b'])
  assert.deepEqual(mountCandidates({ ...base, status: 'ready' }), near)
  assert.deepEqual(mountCandidates({ ...base, status: 'error' }), near)
  assert.deepEqual(mountCandidates({ ...base, status: 'ready', sinceLastMount: 20 }), [])
  // Opened or jumped to, not scrolled: only what is on screen
  assert.deepEqual(mountCandidates({ ...base, status: 'ready', scrolling: false }), ['b'])
})

test('expand all mounts only the sections near the visible area', () => {
  const shown = ['a', 'b', 'c', 'd', 'e']
  const mounted = nextMounted(new Set(), { shown, collapsed: new Set(), near: ['d', 'e'] })
  assert.deepEqual([...mounted], ['d', 'e'])
})

test('a new file keeps only the sections on screen', () => {
  const mounted = new Set(['a', 'b', 'c'])
  assert.deepEqual([...keepOnScreen(mounted, new Set(['b', 'x']))], ['b'])
  assert.equal(keepOnScreen(mounted, new Set(['a', 'b', 'c'])), mounted)
})

test('compares sets by content', () => {
  assert.equal(sameSet(new Set([1, 2]), new Set([2, 1])), true)
  assert.equal(sameSet(new Set([1]), new Set([1, 2])), false)
  assert.equal(sameSet(new Set([1, 3]), new Set([1, 2])), false)
})

test('fits one or two columns by the width of the sections area', () => {
  assert.equal(columnCount(1168), 1)
  assert.equal(columnCount(MIN_COLUMN_PX * 2 + COLUMN_GAP_PX - 1), 1)
  assert.equal(columnCount(MIN_COLUMN_PX * 2 + COLUMN_GAP_PX), 2)
  // 2560px window with today's hex column
  assert.equal(columnCount(1548), 2)
  // Room for three, on a 3440px window and far wider: never more than two beside the hex column
  assert.equal(columnCount(MIN_COLUMN_PX * 3 + COLUMN_GAP_PX * 2), 2)
  assert.equal(columnCount(2428), 2)
  assert.equal(columnCount(10000), 2)
  assert.equal(MAX_COLUMNS, 2)
  // Narrow screens, and nothing measured yet
  assert.equal(columnCount(5000, { wide: false }), 1)
  assert.equal(columnCount(0), 1)
  assert.equal(columnCount(NaN), 1)
  assert.equal(MAX_SECTIONS_PX, MAX_COLUMN_PX * 2 + COLUMN_GAP_PX)
})

test('puts the first group in a column of its own, the others after it', () => {
  assert.deepEqual(columnGroups(1), [[1, 2, 3]])
  assert.deepEqual(columnGroups(2), [[1], [2, 3]])
  assert.deepEqual(SECTION_GROUPS.map(group => group.id), [1, 2, 3])
})

test('splits sections by group, keeping their order', () => {
  assert.equal(sectionGroup({ group: 2 }), 2)
  assert.equal(sectionGroup({ group: 7 }), 1)
  assert.equal(sectionGroup({}), 1)
  const items = [
    { id: 'overview', group: 1 }, { id: 'strings', group: 2 }, { id: 'preview', group: 1 },
    { id: 'dance', group: 3 }, { id: 'odd' }
  ]
  assert.deepEqual(splitByGroup(items, sectionGroup).map(list => list.map(item => item.id)),
    [['overview', 'preview', 'odd'], ['strings'], ['dance']])
  assert.deepEqual(splitByGroup([], sectionGroup), [[], [], []])
})

test('chooses the current section across columns', () => {
  const column = (...views) => ({ views: views.map(([id, visible, height = 400]) => ({ id, visible, height })), areaHeight: 800 })
  const columns = [
    column(['a', 0], ['b', 300]),
    column(['c', 0], ['d', 400]),
    column(['e', 200], ['f', 0])
  ]
  // Still visible in its own column: stays, whichever column scrolled
  assert.equal(chooseCurrentAcross('b', columns, 2), 'b')
  // Gone: chosen among the sections of the column that scrolled
  assert.equal(chooseCurrentAcross('c', columns, 2), 'e')
  assert.equal(chooseCurrentAcross('c', columns, 0), 'b')
  // Nothing scrolled: its own column
  assert.equal(chooseCurrentAcross('c', columns), 'd')
  // None yet: the first column
  assert.equal(chooseCurrentAcross(null, columns), 'b')
  // The column that scrolled shows nothing: the current one stays
  const empty = [column(['a', 300]), column(['c', 0]), column()]
  assert.equal(chooseCurrentAcross('c', empty, 1), 'c')
  assert.equal(chooseCurrentAcross('c', empty, 2), 'c')
  // One column: as chooseCurrent
  assert.equal(chooseCurrentAcross('a', [column(['a', 0], ['b', 300])]), 'b')
  assert.equal(chooseCurrentAcross('a', [column()]), 'a')
})
