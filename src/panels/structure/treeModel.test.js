import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ancestors, buildTreeIndex, collectLeaves, leavesIn, locate, tourSteps, visibleRows } from './treeModel.js'

const f = (name, offset, length, children) => ({ name, offset, length, ...(children ? { children } : {}) })

const FIELDS = [
  f('header', 0, 8, [f('magic', 0, 4), f('version', 4, 4)]),
  f('body', 8, 32, [f('a', 8, 16, [f('a1', 8, 8), f('a2', 16, 8)]), f('b', 24, 16)]),
  f('tail', 40, 4)
]

const names = (index, ids) => ids.map(id => index.nodes[id].field.name)

test('indexes fields depth-first and lists visible rows', () => {
  const index = buildTreeIndex(FIELDS)
  assert.equal(index.nodes.length, 9)
  assert.deepEqual(names(index, index.roots), ['header', 'body', 'tail'])
  assert.deepEqual(names(index, visibleRows(index, new Set())), ['header', 'body', 'tail'])
  const body = index.roots[1]
  assert.deepEqual(names(index, visibleRows(index, new Set([body]))), ['header', 'body', 'a', 'b', 'tail'])
  assert.deepEqual(index.nodes.map(node => node.depth), [0, 1, 1, 0, 1, 2, 2, 1, 0])
})

test('finds the innermost field holding an offset or a range', () => {
  const index = buildTreeIndex(FIELDS)
  assert.equal(index.nodes[locate(index, 5)].field.name, 'version')
  assert.equal(index.nodes[locate(index, 17)].field.name, 'a2')
  assert.equal(index.nodes[locate(index, 8, 24)].field.name, 'a')
  assert.equal(index.nodes[locate(index, 20, 30)].field.name, 'body')
  assert.equal(index.nodes[locate(index, 0, 8)].field.name, 'header')
  assert.equal(locate(index, 44), -1)
  assert.equal(locate(index, 6, 12), -1)
  assert.deepEqual(names(index, ancestors(index, locate(index, 17))), ['body', 'a'])
})

test('handles overlapping and unsorted siblings', () => {
  const index = buildTreeIndex([f('segment', 0, 100, [f('wide', 0, 100), f('narrow', 40, 10)]), f('early', 0, 4)])
  assert.equal(index.rootsOrdered, false)
  assert.equal(index.nodes[locate(index, 45)].field.name, 'narrow')
  assert.equal(index.nodes[locate(index, 2)].field.name, 'early')
})

test('tour visits top-level fields and their children when there are few', () => {
  const many = Array.from({ length: 30 }, (_, i) => f(`e${i}`, 100 + i, 1))
  const index = buildTreeIndex([...FIELDS, f('table', 100, 30, many)])
  assert.deepEqual(names(index, tourSteps(index)), ['header', 'magic', 'version', 'body', 'a', 'b', 'tail', 'table'])
})

test('collects leaves in offset order and finds those near a window', () => {
  const index = buildTreeIndex(FIELDS)
  const leaves = collectLeaves(index)
  assert.deepEqual(leaves.map(leaf => leaf.name), ['magic', 'version', 'a1', 'a2', 'b', 'tail'])
  assert.deepEqual(leavesIn(leaves, 10, 30, 10).map(leaf => leaf.name), ['a1', 'a2', 'b'])
  assert.deepEqual(leavesIn(leaves, 0, 100, 2).map(leaf => leaf.name), ['magic', 'version'])
  assert.deepEqual(leavesIn(leaves, 50, 60, 10), [])
})

test('builds an index of 100,000 fields quickly', () => {
  const children = Array.from({ length: 100000 }, (_, i) => f(`f${i}`, i * 2, 2))
  const start = performance.now()
  const index = buildTreeIndex([f('all', 0, 200000, children)])
  const rows = visibleRows(index, new Set([0]))
  assert.equal(rows.length, 100001)
  assert.equal(index.nodes[locate(index, 123457)].field.name, 'f61728')
  assert.ok(performance.now() - start < 1000)
})
