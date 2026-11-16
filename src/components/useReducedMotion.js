import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY) : null)

function subscribe(onChange) {
  const list = media()
  if (!list) return () => {}
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

/** Whether the user asked for reduced motion; follows changes live. */
export function prefersReducedMotion() {
  return Boolean(media()?.matches)
}

export default function useReducedMotion() {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false)
}
