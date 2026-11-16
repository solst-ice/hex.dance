// An index over `analysis.fields` (a tree of byte ranges) and its leaves, used
// by the Structure tab and the anatomy dock. Pure; no DOM.

/**
 * @typedef {Object} TreeNode
 * @property {number} id
 * @property {import('../analysis/types.js').Field} field
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
