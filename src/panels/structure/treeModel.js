// Pure helpers behind the Structure tab: the visible rows for a set of
// expanded nodes, lookups by byte offset and the guided-tour steps. The index
// they work on comes from src/lib/fieldIndex.js.

/** Ids of the rows shown when the nodes in `expanded` are open, in display order. */
export function visibleRows(index, expanded) {
  const rows = []
  const stack = []
  for (let i = index.roots.length - 1; i >= 0; i--) stack.push(index.roots[i])
  while (stack.length) {
    const id = stack.pop()
    rows.push(id)
    if (!expanded.has(id)) continue
    const kids = index.nodes[id].children
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  return rows
}

const contains = (field, start, end) => field.offset <= start && field.offset + field.length >= end

// Child of a level that contains [start, end); the shortest one where siblings overlap
function childContaining(nodes, ids, ordered, start, end) {
  if (ordered) {
    let lo = 0
    let hi = ids.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (nodes[ids[mid]].field.offset <= start) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return found !== -1 && contains(nodes[ids[found]].field, start, end) ? ids[found] : -1
  }
  let best = -1
  for (const id of ids) {
    const field = nodes[id].field
    if (contains(field, start, end) && (best === -1 || field.length < nodes[best].field.length)) best = id
  }
  return best
}

/** The innermost node whose range contains [start, end), or -1. */
export function locate(index, start, end = start + 1) {
  const { nodes } = index
  let id = childContaining(nodes, index.roots, index.rootsOrdered, start, end)
  if (id === -1) return -1
  for (;;) {
    const node = nodes[id]
    const next = childContaining(nodes, node.children, node.ordered, start, end)
    if (next === -1) return id
    id = next
  }
}

/** Ids from the top-level ancestor down to `id`'s parent. */
export function ancestors(index, id) {
  const out = []
  let parent = id >= 0 && id < index.nodes.length ? index.nodes[id].parent : -1
  while (parent !== -1) {
    out.push(parent)
    parent = index.nodes[parent].parent
  }
  return out.reverse()
}

const MAX_TOUR_STEPS = 400
const TOUR_CHILDREN = 12

/**
 * Steps of the guided tour: top-level fields in file order, each followed by
 * its children when there are only a few of them.
 */
export function tourSteps(index) {
  const top = [...index.roots].sort((a, b) => index.nodes[a].field.offset - index.nodes[b].field.offset)
  const steps = []
  for (const id of top) {
    if (steps.length >= MAX_TOUR_STEPS) break
    steps.push(id)
    const kids = index.nodes[id].children
    if (kids.length >= 2 && kids.length <= TOUR_CHILDREN) {
      for (const kid of kids) {
        if (steps.length >= MAX_TOUR_STEPS) break
        steps.push(kid)
      }
    }
  }
  return steps
}

/** Identity of a field for the poster's pins: its offset and length. */
export const pinKey = (offset, length) => `${offset}:${length}`

/**
 * What to announce after the reader pins or unpins a field.
 * @param {'pinned'|'unpinned'|'full'|'invalid'} outcome   from the pin store's toggle
 */
export function pinMessage(outcome, name, limit) {
  const what = name ? String(name) : 'This field'
  switch (outcome) {
    case 'pinned': return `${what} is pinned to the poster.`
    case 'unpinned': return `${what} is no longer pinned.`
    case 'full': return `${limit} fields are pinned already, the most a poster takes. Unpin one first.`
    default: return 'This field cannot be pinned.'
  }
}
