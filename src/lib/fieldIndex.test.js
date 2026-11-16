import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTreeIndex, collectLeaves, leavesIn } from './fieldIndex.js'

const f = (name, offset, length, children) => ({ name, offset, length, ...(children ? { children } : {}) })

const FIELDS = [
  f('header', 0, 8, [f('magic', 0, 4), f('version', 4, 4)]),
  f('body', 8, 32, [f('a', 8, 16, [f('a1', 8, 8), f('a2', 16, 8)]), f('b', 24, 16)]),
  f('tail', 40, 4)
]

test('indexes fields depth-first and notes which levels are ordered', () => {
  const index = buildTreeIndex(FIELDS)
  assert.equal(index.nodes.length, 9)
  assert.deepEqual(index.roots.map(id => index.nodes[id].field.name), ['header', 'body', 'tail'])
  assert.equal(index.rootsOrdered, true)
  const a = index.nodes.find(node => node.field.name === 'a')
  assert.equal(a.depth, 1)
  assert.deepEqual(a.children.map(id => index.nodes[id].field.name), ['a1', 'a2'])
  assert.equal(buildTreeIndex([f('wide', 0, 100), f('inside', 10, 4)]).rootsOrdered, false)
  assert.deepEqual(buildTreeIndex(null), { nodes: [], roots: [], rootsOrdered: true })
})

test('collects leaves in offset order and finds those near a window', () => {
  const index = buildTreeIndex(FIELDS)
  const leaves = collectLeaves(index)
  assert.deepEqual(leaves.map(leaf => leaf.name), ['magic', 'version', 'a1', 'a2', 'b', 'tail'])
  assert.deepEqual(leavesIn(leaves, 10, 30, 10).map(leaf => leaf.name), ['a1', 'a2', 'b'])
  assert.deepEqual(leavesIn(leaves, 0, 100, 2).map(leaf => leaf.name), ['magic', 'version'])
  assert.deepEqual(leavesIn(leaves, 50, 60, 10), [])
  // a long leaf that starts before the window still counts
  const long = collectLeaves(buildTreeIndex([f('big', 0, 1000), f('small', 1000, 4)]))
  assert.deepEqual(leavesIn(long, 500, 600, 10).map(leaf => leaf.name), ['big'])
})
