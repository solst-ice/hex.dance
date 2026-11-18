// Tests strings against the filter's regular expression, off the main
// thread: a pattern with nested repetition can backtrack for minutes on one
// string, and only a worker can be stopped while it does. See
// regexFilter.js for the other side.
//
//   main → worker  { type: 'begin', source, flags }
//   main → worker  { type: 'chunk', texts, start, indices }
//                  `indices` holds the store index of each text, or is null
//                  when they run on from `start`
//   worker → main  { type: 'ready' } once the expression is compiled
//   worker → main  { type: 'tick' } at least every TICK_MS while testing,
//                  so the main thread can tell a slow chunk from a stuck one
//   worker → main  { type: 'matches', matches } per chunk, in order

const TICK_MS = 100

let re = null

self.onmessage = (event) => {
  const message = event.data
  if (message.type === 'begin') {
    re = new RegExp(message.source, message.flags)
    self.postMessage({ type: 'ready' })
    return
  }
  if (message.type !== 'chunk') return
  const { texts, start, indices } = message
  const out = []
  let last = performance.now()
  for (let i = 0; i < texts.length; i++) {
    if (re.test(texts[i])) out.push(indices ? indices[i] : start + i)
    // Reading the clock every few strings is enough: one string that takes
    // long is what the main thread watches for
    if ((i & 7) !== 7) continue
    const now = performance.now()
    if (now - last >= TICK_MS) {
      self.postMessage({ type: 'tick' })
      last = now
    }
  }
  const matches = Uint32Array.from(out)
  self.postMessage({ type: 'matches', matches }, [matches.buffer])
}
