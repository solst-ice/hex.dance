import { useCallback, useState } from 'react'

function read(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** useState that remembers its value in localStorage (when available). */
export function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => {
    const stored = read(key)
    if (stored !== undefined) return stored
    return typeof initial === 'function' ? initial() : initial
  })

  const update = useCallback((next) => {
    setValue(previous => {
      const value = typeof next === 'function' ? next(previous) : next
      try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
      return value
    })
  }, [key])

  return [value, update]
}
