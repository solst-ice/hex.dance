// Lets the always-mounted inspector dock hand a query to the Search tab,
// which may not be mounted yet when Ctrl+F is pressed.

let pending = null
let seq = 0
const listeners = new Set()

/** @param {{ mode?: 'hex', query?: string }} request */
export function requestSearch(request) {
  pending = { ...request, seq: ++seq }
  listeners.forEach(listener => listener())
}

/** Returns and clears the pending request, if any. */
export function takeSearchRequest() {
  const request = pending
  pending = null
  return request
}

export function subscribeSearchRequests(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
