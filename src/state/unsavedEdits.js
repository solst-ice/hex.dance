// The rules for edits that would be lost: when the bytes count as unsaved,
// and what happens to a request to open another file while they are.
// Nothing here touches the DOM or React, so the rules are tested on their own.

/**
 * Tracks whether the open file's bytes hold edits that have not been
 * downloaded. The bytes are unsaved when they differ from the file as it was
 * opened and have changed since the last download. Listeners only hear when
 * that answer flips, so typing more bytes into an already edited file wakes
 * nobody.
 */
export function createEditTracker() {
  let modifiedCount = 0
  // Bumps on every change to the bytes (edit, undo, redo, revert)
  let changes = 0
  // `changes` when the bytes were last downloaded; 0 is the file as opened
  let savedAt = 0
  const listeners = new Set()

  const isUnsaved = () => modifiedCount > 0 && changes !== savedAt

  const update = (apply) => {
    const before = isUnsaved()
    apply()
    if (isUnsaved() !== before) listeners.forEach(listener => listener())
  }

  return {
    isUnsaved,
    /** @returns {number} bytes that differ from the file as opened */
    getModifiedCount: () => modifiedCount,
    /**
     * The bytes changed. Undoing back to the original counts as a change too:
     * with nothing modified there is nothing to lose.
     * @param {number} count   bytes that now differ from the file as opened
     */
    edited(count) {
      update(() => {
        changes++
        modifiedCount = Math.max(0, count | 0)
      })
    },
    /** The current bytes were downloaded */
    saved() {
      update(() => { savedAt = changes })
    },
    /** Another file was opened, or the file was closed */
    reset() {
      update(() => {
        modifiedCount = 0
        changes = 0
        savedAt = 0
      })
    },
    /** @param {() => void} listener */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/**
 * @typedef {{ id: number, file: File, onOpen?: () => void }} OpenRequest
 *   a request to open `file` that waits for an answer; `onOpen` runs just
 *   before the file is opened, and never if the request is dropped
 *
 * @typedef {{ type: 'request', file: File, onOpen?: () => void, unsaved: boolean }
 *   | { type: 'keep' } | { type: 'discard' } | { type: 'download' }} OpenAction
 *   `request`: something asked to open a file; `keep`, `discard` and
 *   `download` are the answers to the pending request
 *
 * @typedef {Object} OpenStep
 * @property {OpenRequest|null} pending   the request waiting for an answer, if any
 * @property {OpenRequest|null} open      the request to carry out now, if any
 * @property {boolean} download           download the current bytes before opening
 */

/**
 * What to do with a request to open a file, or an answer to the pending one.
 * Without unsaved edits a request opens at once. With them it waits, and a
 * later request replaces the waiting one, so there is never more than one
 * question and it is always about the file asked for last.
 * @param {OpenRequest|null} pending
 * @param {OpenAction} action
 * @returns {OpenStep}
 */
export function nextOpenStep(pending, action) {
  const none = { pending: null, open: null, download: false }
  switch (action.type) {
    case 'request': {
      if (!action.file) return { ...none, pending }
      const request = { id: (pending?.id ?? 0) + 1, file: action.file, onOpen: action.onOpen }
      return action.unsaved
        ? { ...none, pending: request }
        : { ...none, open: request }
    }
    case 'keep':
      return none
    case 'discard':
      return { ...none, open: pending }
    case 'download':
      return pending ? { ...none, open: pending, download: true } : none
    default:
      return { ...none, pending }
  }
}
