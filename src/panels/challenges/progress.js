// Which challenge a loaded File belongs to, and which challenges are solved.
// Files are tracked by object identity, so a user's own file that happens to
// share a challenge's name is never mistaken for one.

const STORAGE_KEY = 'hexdance.challenges.solved'

/** @type {WeakMap<File, string>} */
const challengeFiles = new WeakMap()

/** Hints revealed so far, per challenge id, for this page session. */
const revealedHints = new Map()

export function rememberChallengeFile(file, id) {
  challengeFiles.set(file, id)
}

/** @returns {string|null} */
export function challengeIdForFile(file) {
  return (file && challengeFiles.get(file)) || null
}

export function hintsRevealed(id) {
  return revealedHints.get(id) || 0
}

export function setHintsRevealed(id, count) {
  revealedHints.set(id, count)
}

/** @returns {Set<string>} */
export function loadSolved() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** @param {Set<string>} solved */
export function saveSolved(solved) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...solved]))
  } catch {
    // storage blocked or full: progress just isn't remembered
  }
}
