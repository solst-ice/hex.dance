// Records in-place byte edits so they can be undone, redone and reverted.
// Only touched offsets are stored, so memory and time grow with the number of
// edits, never with the size of the file.

const GRANULE = 8

export class EditLog {
  constructor() {
    this.original = new Map() // offset -> value before the first edit
    this.modified = new Set() // offsets whose value differs from the original
    this.undoStack = []
    this.redoStack = []
    this.granules = new Map() // offset / 8 -> revision, so views can tell what changed
    this.seq = 0
  }

  get modifiedCount() { return this.modified.size }
  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }

  isModified(offset) {
    return this.modified.has(offset)
  }

  originalValue(bytes, offset) {
    return this.original.has(offset) ? this.original.get(offset) : bytes[offset]
  }

  // Highest revision of any byte in [start, end); 0 if none were ever edited
  revision(start, end) {
    if (!this.granules.size) return 0
    let rev = 0
    for (let g = Math.floor(start / GRANULE); g * GRANULE < end; g++) {
      const r = this.granules.get(g)
      if (r > rev) rev = r
    }
    return rev
  }

  set(bytes, offset, value) {
    if (!this.original.has(offset)) this.original.set(offset, bytes[offset])
    bytes[offset] = value
    if (value === this.original.get(offset)) this.modified.delete(offset)
    else this.modified.add(offset)
    this.granules.set(Math.floor(offset / GRANULE), ++this.seq)
  }

  // Writes one byte. Writes sharing a `group` key with the last step are
  // folded into it (the two nibbles of one hex digit pair are one step).
  write(bytes, offset, value, { group } = {}) {
    if (!(offset >= 0 && offset < bytes.length)) return false
    const v = value & 0xff
    const before = bytes[offset]
    if (v === before) return false
    const last = this.undoStack[this.undoStack.length - 1]
    if (group != null && last && last.group === group && last[0].offset === offset) {
      last[0].after = v
    } else {
      const step = [{ offset, before, after: v }]
      step.group = group
      this.undoStack.push(step)
    }
    this.redoStack.length = 0
    this.set(bytes, offset, v)
    return true
  }

  undo(bytes) {
    const step = this.undoStack.pop()
    if (!step) return null
    for (let i = step.length - 1; i >= 0; i--) this.set(bytes, step[i].offset, step[i].before)
    step.group = undefined
    this.redoStack.push(step)
    return span(step)
  }

  redo(bytes) {
    const step = this.redoStack.pop()
    if (!step) return null
    for (const change of step) this.set(bytes, change.offset, change.after)
    this.undoStack.push(step)
    return span(step)
  }

  // Restores every modified byte as one undoable step
  revertAll(bytes) {
    if (!this.modified.size) return null
    const step = [...this.modified].sort((a, b) => a - b).map(offset => ({
      offset, before: bytes[offset], after: this.original.get(offset)
    }))
    for (const change of step) this.set(bytes, change.offset, change.after)
    this.undoStack.push(step)
    this.redoStack.length = 0
    return span(step)
  }
}

function span(step) {
  let start = Infinity
  let end = -Infinity
  for (const { offset } of step) {
    if (offset < start) start = offset
    if (offset + 1 > end) end = offset + 1
  }
  return { start, end, count: step.length }
}
