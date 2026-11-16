// Pure helpers behind the Structure tab: an index over `analysis.fields`,
// the visible rows for a set of expanded nodes, lookups by byte offset, the
// guided-tour steps and the leaf ranges used to colour the hex view.

/**
 * @typedef {Object} TreeNode
 * @property {number} id
 * @property {import('../../analysis/types.js').Field} field
 * @property {number} depth
 * @property {number} parent        -1 for top-level fields
 * @property {number[]} children
 * @property {boolean} ordered      children sorted by offset without overlaps, so they can be binary-searched
 *
 * @typedef {{ nodes: TreeNode[], roots: number[], rootsOrdered: boolean }} TreeIndex
 */

function isOrdered(nodes, ids) {
  let end = -Infinity
  let start = -Infinity
  for (const id of ids) {
    const { offset, length } = nodes[id].field
    if (offset < end || offset < start) return false
    start = offset
    end = offset + length
  }
  return true
}

/** @returns {TreeIndex} */
export function buildTreeIndex(fields) {
  const nodes = []
  const roots = []
  const stack = []
  const list = Array.isArray(fields) ? fields : []
  for (let i = list.length - 1; i >= 0; i--) stack.push([list[i], -1, 0])
  while (stack.length) {
    const [field, parent, depth] = stack.pop()
    if (!field) continue
    const id = nodes.length
    nodes.push({ id, field, depth, parent, children: [], ordered: true })
    if (parent === -1) roots.push(id)
    else nodes[parent].children.push(id)
    const kids = field.children
    if (Array.isArray(kids)) {
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], id, depth + 1])
    }
  }
  for (const node of nodes) node.ordered = isOrdered(nodes, node.children)
  return { nodes, roots, rootsOrdered: isOrdered(nodes, roots) }
}

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

/**
 * Leaf fields as byte ranges sorted by start: leaves keep nested structures
 * readable when they are coloured.
 * @returns {{ start: number, end: number, kind: string, name: string }[]}
 */
export function collectLeaves(index) {
  const leaves = []
  for (const node of index.nodes) {
    if (node.children.length > 0) continue
    const { offset, length, kind, name } = node.field
    if (length > 0) leaves.push({ start: offset, end: offset + length, kind: kind || 'other', name })
  }
  leaves.sort((a, b) => a.start - b.start || a.end - b.end)
  return leaves
}

/** Up to `max` leaves overlapping [from, to), starting from the first one that ends after `from`. */
export function leavesIn(leaves, from, to, max) {
  // Leaves are sorted by start, and a long leaf can start well before `from`,
  // so search by start and then step back over leaves that still overlap
  let lo = 0
  let hi = leaves.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (leaves[mid].start < from) lo = mid + 1
    else hi = mid
  }
  let first = lo
  for (let back = 0; first > 0 && back < 64; back++) {
    if (leaves[first - 1].end > from) first--
    else break
  }
  const out = []
  for (let i = first; i < leaves.length && out.length < max; i++) {
    const leaf = leaves[i]
    if (leaf.start >= to) break
    if (leaf.end > from) out.push(leaf)
  }
  return out
}

export function formatOffset(n) {
  return `0x${n.toString(16).toUpperCase()}`
}

export function formatLength(n) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'byte' : 'bytes'}`
}
