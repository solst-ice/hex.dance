// Runs a /regex/ filter over the strings in a worker (filter.worker.js), so
// that no pattern can block the page. Strings go over in chunks, copied just
// before they are sent, so the worker never holds more than a couple of
// chunks; the store on the main thread stays the only full copy.

// A pattern is given up on when the worker has been busy this long without
// finishing a string: that is the mark of runaway backtracking, not of a
// large but ordinary filter, which keeps reporting progress.
export const FILTER_TIME_LIMIT = 1000
export const SLOW_MESSAGE = 'This pattern is too slow: it got stuck for over a second, so it was stopped. The list is unchanged.'

const CHUNK_STRINGS = 32768
const CHUNK_CHARS = 2 << 20
const IN_FLIGHT = 2
const PROGRESS_MS = 100

/**
 * @param {Object} options
 * @param {import('./store.js').StringStore} options.store   may grow while the job runs; call update() when it does
 * @param {{ source: string, flags: string }} options.regex
 * @param {((store: any, i: number) => boolean) | null} [options.prefilter]   class and encoding test, run here
 * @param {() => Worker} options.createWorker
 * @param {(state: { status: 'running' | 'done' | 'slow' | 'error', list: number[], count: number, scanned: number, error?: string }) => void} options.onUpdate
 *   'done' each time every string in the store so far has been tested;
 *   `list` only grows, and `count` says how much of it belongs to this update
 * @returns {{ update: () => void, cancel: () => void }}
 */
export function startRegexFilter({
  store, regex, prefilter = null, createWorker, onUpdate,
  timeLimit = FILTER_TIME_LIMIT,
  now = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id)
}) {
  const list = []
  // Store index just past each chunk in flight, oldest first
  const pending = []
  let next = 0
  let scanned = 0
  let ready = false
  let finished = false
  let lastHeard = 0
  let lastProgress = 0
  let timer = null
  let worker = null

  const stop = () => {
    finished = true
    if (timer !== null) clearTimer(timer)
    timer = null
    worker?.terminate()
  }

  const report = (status, extra) => {
    if (!finished || status === 'slow' || status === 'error') onUpdate({ status, list, count: list.length, scanned, ...extra })
  }

  const fail = (status, error) => {
    if (finished) return
    stop()
    report(status, error ? { error } : undefined)
  }

  // The worker is only watched while it has work and has started, so a
  // slow worker start-up is not taken for a slow pattern
  const watch = () => {
    if (timer !== null || !ready || pending.length === 0 || finished) return
    timer = setTimer(check, Math.max(1, timeLimit - (now() - lastHeard)))
  }
  const check = () => {
    timer = null
    if (finished || pending.length === 0) return
    if (now() - lastHeard >= timeLimit) fail('slow')
    else watch()
  }

  const send = () => {
    while (!finished && pending.length < IN_FLIGHT && next < store.count) {
      const start = next
      const texts = []
      const indices = prefilter ? [] : null
      let chars = 0
      let i = start
      for (; i < store.count && i - start < CHUNK_STRINGS && chars < CHUNK_CHARS; i++) {
        if (prefilter && !prefilter(store, i)) continue
        const text = store.texts[i]
        texts.push(text)
        indices?.push(i)
        chars += text.length
      }
      next = i
      pending.push(i)
      if (pending.length === 1) lastHeard = now()
      worker.postMessage({ type: 'chunk', texts, start, indices: indices && Uint32Array.from(indices) })
    }
    watch()
  }

  try {
    worker = createWorker()
  } catch (error) {
    queueMicrotask(() => fail('error', String(error?.message || error)))
    return { update() {}, cancel: stop }
  }

  worker.onmessage = (event) => {
    if (finished) return
    const message = event.data || {}
    lastHeard = now()
    if (message.type === 'ready') {
      ready = true
      watch()
      return
    }
    if (message.type !== 'matches') return
    const { matches } = message
    for (let k = 0; k < matches.length; k++) list.push(matches[k])
    scanned = pending.shift()
    if (scanned >= store.count && pending.length === 0) {
      report('done')
    } else if (now() - lastProgress >= PROGRESS_MS) {
      lastProgress = now()
      report('running')
    }
    send()
  }
  worker.onerror = (event) => {
    event.preventDefault?.()
    fail('error', event.message || 'The filter stopped unexpectedly')
  }
  worker.postMessage({ type: 'begin', source: regex.source, flags: regex.flags })
  if (store.count === 0) queueMicrotask(() => report('done'))
  send()

  return {
    /** The store has grown: test the new strings too. */
    update() {
      if (finished || next >= store.count) return
      send()
    },
    cancel: stop
  }
}

/**
 * Which matches the list shows while a /regex/ filter is in play: the
 * filter's own once it has caught up with the strings, otherwise whatever
 * was shown before for the same strings (a pattern that runs, or was
 * stopped, leaves the list as it was), otherwise nothing yet.
 * `current` is the job's latest update, tagged with the filter key and
 * store it was started for; an update for any other key or store is stale
 * and never shown.
 *
 * @returns {{ list: number[] | null, count: number } | null}
 */
export function regexShown({ key, store, current, previous }) {
  const live = current && current.key === key && current.store === store ? current : null
  if (live && live.result) return live.result
  if (previous && previous.store === store) return previous
  return null
}
