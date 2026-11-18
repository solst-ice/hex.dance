import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEditTracker, nextOpenStep } from './unsavedEdits.js'

test('a file as opened has nothing unsaved', () => {
  const tracker = createEditTracker()
  assert.equal(tracker.isUnsaved(), false)
  assert.equal(tracker.getModifiedCount(), 0)
})

test('an edit makes the bytes unsaved and a download clears it', () => {
  const tracker = createEditTracker()
  tracker.edited(1)
  assert.equal(tracker.isUnsaved(), true)
  assert.equal(tracker.getModifiedCount(), 1)
  tracker.saved()
  assert.equal(tracker.isUnsaved(), false)
  // Still modified compared with the file as opened, but nothing to lose
  assert.equal(tracker.getModifiedCount(), 1)
})

test('an edit after a download makes the bytes unsaved again', () => {
  const tracker = createEditTracker()
  tracker.edited(1)
  tracker.saved()
  tracker.edited(2)
  assert.equal(tracker.isUnsaved(), true)
})

test('undoing or reverting back to the original clears it', () => {
  const tracker = createEditTracker()
  tracker.edited(1)
  tracker.edited(2)
  tracker.edited(1) // undo
  assert.equal(tracker.isUnsaved(), true)
  tracker.edited(0) // undo back to the original
  assert.equal(tracker.isUnsaved(), false)
  tracker.edited(3) // redo
  assert.equal(tracker.isUnsaved(), true)
  tracker.edited(0) // revert all
  assert.equal(tracker.isUnsaved(), false)
})

test('undoing after a download counts as unsaved while bytes stay modified', () => {
  const tracker = createEditTracker()
  tracker.edited(1)
  tracker.edited(2)
  tracker.saved()
  tracker.edited(1)
  assert.equal(tracker.isUnsaved(), true)
})

test('a downloaded file that is reverted and edited again is unsaved', () => {
  const tracker = createEditTracker()
  tracker.edited(1)
  tracker.saved()
  tracker.edited(0)
  assert.equal(tracker.isUnsaved(), false)
  tracker.edited(1)
  assert.equal(tracker.isUnsaved(), true)
})

test('reset forgets everything', () => {
  const tracker = createEditTracker()
  tracker.edited(4)
  tracker.reset()
  assert.equal(tracker.isUnsaved(), false)
  assert.equal(tracker.getModifiedCount(), 0)
  tracker.edited(1)
  assert.equal(tracker.isUnsaved(), true)
})

test('listeners only hear when unsaved flips', () => {
  const tracker = createEditTracker()
  let calls = 0
  const stop = tracker.subscribe(() => calls++)
  tracker.edited(1)
  tracker.edited(2)
  tracker.edited(3)
  assert.equal(calls, 1)
  tracker.saved()
  assert.equal(calls, 2)
  tracker.saved()
  assert.equal(calls, 2)
  tracker.edited(4)
  assert.equal(calls, 3)
  stop()
  tracker.reset()
  assert.equal(calls, 3)
})

const fileA = { name: 'a.bin' }
const fileB = { name: 'b.bin' }

test('a request without unsaved edits opens at once', () => {
  const step = nextOpenStep(null, { type: 'request', file: fileA, unsaved: false })
  assert.equal(step.pending, null)
  assert.equal(step.open.file, fileA)
  assert.equal(step.download, false)
})

test('a request with unsaved edits waits', () => {
  const step = nextOpenStep(null, { type: 'request', file: fileA, unsaved: true })
  assert.equal(step.open, null)
  assert.equal(step.pending.file, fileA)
})

test('a later request replaces the pending one', () => {
  const onOpenA = () => {}
  const first = nextOpenStep(null, { type: 'request', file: fileA, onOpen: onOpenA, unsaved: true })
  const second = nextOpenStep(first.pending, { type: 'request', file: fileB, unsaved: true })
  assert.equal(second.open, null)
  assert.equal(second.pending.file, fileB)
  assert.equal(second.pending.onOpen, undefined)
  assert.notEqual(second.pending.id, first.pending.id)
})

test('a request that no longer needs asking opens and drops the pending one', () => {
  const first = nextOpenStep(null, { type: 'request', file: fileA, unsaved: true })
  const second = nextOpenStep(first.pending, { type: 'request', file: fileB, unsaved: false })
  assert.equal(second.pending, null)
  assert.equal(second.open.file, fileB)
})

test('keep drops the request and opens nothing', () => {
  const { pending } = nextOpenStep(null, { type: 'request', file: fileA, unsaved: true })
  assert.deepEqual(nextOpenStep(pending, { type: 'keep' }), { pending: null, open: null, download: false })
})

test('discard opens the pending file without downloading', () => {
  const { pending } = nextOpenStep(null, { type: 'request', file: fileA, unsaved: true })
  const step = nextOpenStep(pending, { type: 'discard' })
  assert.equal(step.pending, null)
  assert.equal(step.open, pending)
  assert.equal(step.download, false)
})

test('download downloads and then opens the pending file', () => {
  const { pending } = nextOpenStep(null, { type: 'request', file: fileA, unsaved: true })
  const step = nextOpenStep(pending, { type: 'download' })
  assert.equal(step.open, pending)
  assert.equal(step.download, true)
})

test('an answer with nothing pending does nothing', () => {
  for (const type of ['keep', 'discard', 'download']) {
    assert.deepEqual(nextOpenStep(null, { type }), { pending: null, open: null, download: false })
  }
})

test('a request without a file changes nothing', () => {
  const { pending } = nextOpenStep(null, { type: 'request', file: fileA, unsaved: true })
  const step = nextOpenStep(pending, { type: 'request', file: null, unsaved: true })
  assert.equal(step.pending, pending)
  assert.equal(step.open, null)
})
