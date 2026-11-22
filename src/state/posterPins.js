// Fields the reader pinned to the poster from the Structure section. A store
// rather than state, like the edit tracker: it lives next to openFile, which
// empties it when another file is opened, and only the components that read
// it re-render when it changes. Not saved anywhere.

export const PIN_LIMIT = 24

/**
 * @typedef {{ offset: number, length: number, name: string }} PosterPin
 *   a field is identified by its offset and length; `name` is only shown
 */

const isCount = n => Number.isSafeInteger(n) && n >= 0
const samePin = (pin, offset, length) => pin.offset === offset && pin.length === length

/**
 * @param {{ limit?: number }} [options]
 */
export function createPosterPins({ limit = PIN_LIMIT } = {}) {
  /** @type {PosterPin[]} kept in file order; a new array on every change */
  let pins = []
  const listeners = new Set()

  const set = (next) => {
    pins = next
    listeners.forEach(listener => listener())
  }

  /** @returns {PosterPin[]} */
  const getPins = () => pins

  const isPinned = (offset, length) => pins.some(pin => samePin(pin, offset, length))

  /**
   * Pins the field, or unpins it when it is pinned already.
   * @param {{ offset: number, length: number, name?: string }} field
   * @returns {'pinned'|'unpinned'|'full'|'invalid'}
   */
  const toggle = (field) => {
    const offset = field?.offset
    const length = field?.length
    if (!isCount(offset) || !isCount(length) || length === 0) return 'invalid'
    if (isPinned(offset, length)) {
      set(pins.filter(pin => !samePin(pin, offset, length)))
      return 'unpinned'
    }
    if (pins.length >= limit) return 'full'
    const pin = { offset, length, name: String(field.name ?? '') }
    set([...pins, pin].sort((a, b) => a.offset - b.offset || a.length - b.length))
    return 'pinned'
  }

  const remove = (offset, length) => {
    if (isPinned(offset, length)) set(pins.filter(pin => !samePin(pin, offset, length)))
  }

  const clear = () => {
    if (pins.length) set([])
  }

  /** @param {() => void} listener */
  const subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { getPins, isPinned, toggle, remove, clear, reset: clear, subscribe, limit }
}
