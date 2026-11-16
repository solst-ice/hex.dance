// A tiny external store so the status bar can follow the pointer without the
// rows re-rendering

export function createHoverStore() {
  let value = null
  const listeners = new Set()
  return {
    get: () => value,
    set(next) {
      if (next === value) return
      value = next
      listeners.forEach(l => l())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
