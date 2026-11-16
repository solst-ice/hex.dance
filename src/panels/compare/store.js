import { useSyncExternalStore } from 'react'
import { DEFAULT_GAP } from './diff.js'

// The second file outlives the tab (tabs unmount while hidden) and the main
// file (so another A can be compared with the same B).

/**
 * @typedef {Object} SecondFile
 * @property {number} id
 * @property {string} name
 * @property {Uint8Array} bytes
 * @property {File|null} file     what "swap" opens; null when the bytes did not come from a File
 * @property {'picked'|'original'|'swapped'} origin
 *
 * @typedef {Object} CompareState
 * @property {SecondFile|null} b
 * @property {{ name: string } | null} loading   a picked file still being read
 * @property {string|null} error
 * @property {number} gap
 */

let nextId = 1
/** @type {CompareState} */
let state = { b: null, loading: null, error: null, gap: DEFAULT_GAP }
const listeners = new Set()
let readToken = 0

function set(patch) {
  state = { ...state, ...patch }
  listeners.forEach(listener => listener())
}

export function setSecond({ name, bytes, file = null, origin = 'picked' }) {
  readToken++
  set({ b: { id: nextId++, name, bytes, file, origin }, loading: null, error: null })
}

/** Reads a File into memory and makes it B. */
export function readSecond(file, origin = 'picked', name = file.name) {
  const token = ++readToken
  set({ loading: { name }, error: null })
  return file.arrayBuffer().then(
    buffer => {
      if (token !== readToken) return
      readToken++
      set({ b: { id: nextId++, name, bytes: new Uint8Array(buffer), file, origin }, loading: null })
    },
    error => {
      if (token !== readToken) return
      set({ loading: null, error: `Could not read ${name}: ${error?.message || error}` })
    }
  )
}

export function clearSecond() {
  readToken++
  set({ b: null, loading: null, error: null })
}

export function setGap(gap) {
  set({ gap })
}

const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** @returns {CompareState} */
export function useCompareState() {
  return useSyncExternalStore(subscribe, () => state)
}

// The last finished comparison per loaded A, so returning to the tab does not
// repeat it. Keyed weakly so a closed file's bytes can be freed.
const results = new WeakMap()

/** @param {ArrayBuffer} buffer   A's buffer */
export function cachedResult(buffer, bId, gap) {
  const entry = buffer && results.get(buffer)
  return entry && entry.bId === bId && entry.gap === gap ? entry.result : null
}

export function cacheResult(buffer, bId, gap, result) {
  if (buffer) results.set(buffer, { bId, gap, result })
}
