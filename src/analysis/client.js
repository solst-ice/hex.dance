import { gaveUpAnalysis } from './generic.js'

// After this many workers fail to load in a row, analysis stays on the main thread
const MAX_WORKER_FAILURES = 2

// How long the page waits for an answer before it gives up on the analysis.
// The parse's own budget (src/formats/budget.js) stops at 5 seconds plus 40 ms
// per megabyte, so this only fires when that did not: reading the file into
// the worker, posting the result back or a parser stuck between its checks.
// Time per megabyte keeps a 1 GB file from being cut off while it is read.
export const BASE_TIMEOUT_MS = 20000
export const TIMEOUT_MS_PER_MB = 100

/** Milliseconds the page waits for the analysis of a file of `size` bytes. */
export function timeoutFor(size) {
  const megabytes = Number.isFinite(size) && size > 0 ? size / (1 << 20) : 0
  return Math.round(BASE_TIMEOUT_MS + megabytes * TIMEOUT_MS_PER_MB)
}

// The sentence each kind of ending puts in the analysis' warnings
export function gaveUpNote(reason, detail = '') {
  const rest = 'so only basic facts are shown. The hex view and byte tools still work on the whole file.'
  if (reason === 'timeout') {
    return `The analysis gave up after ${Math.round(Number(detail) / 1000)} seconds without finishing, ${rest}`
  }
  return detail
    ? `The analysis stopped with an error (${detail}), ${rest}`
    : `The analysis stopped unexpectedly, perhaps because the file needed more memory than the page could give it, ${rest}`
}

let worker = null
let workerReady = false
let workerFailures = 0
let latestId = 0
/** @type {{ id: number, file: File, resolve: Function, reject: Function, timer: any } | null} */
let pending = null

/** Error used to reject a request that a newer request replaced. */
export class StaleAnalysisError extends Error {
  constructor() {
    super('Analysis superseded by a newer request')
    this.name = 'StaleAnalysisError'
  }
}

// The parsers are only needed on the main thread when no worker can run at
// all, so they are loaded on demand and stay out of the main bundle
async function analyzeOnMainThread(file) {
  const [{ analyzeBytes }, buffer] = await Promise.all([import('./analyze.js'), file.arrayBuffer()])
  return analyzeBytes(new Uint8Array(buffer), { fileName: file.name, mimeType: file.type })
}

function settle(request, run) {
  if (pending !== request) return
  pending = null
  clearTimeout(request.timer)
  run()
}

function onMainThread(request) {
  if (pending !== request) return
  clearTimeout(request.timer)
  analyzeOnMainThread(request.file).then(
    analysis => settle(request, () => request.resolve(analysis)),
    error => settle(request, () => request.reject(error))
  )
}

// A worker that timed out or failed on this file is not asked again, nor is
// the file parsed on the page: whatever stopped the worker would stop or
// freeze the page. The reader gets the generic facts and a note instead,
// which is a finished analysis rather than an error.
function giveUp(request, reason, detail) {
  if (pending !== request) return
  clearTimeout(request.timer)
  discardWorker()
  const { file } = request
  const note = gaveUpNote(reason, detail)
  const answer = head => settle(request, () => request.resolve(gaveUpAnalysis(head, file.size, { fileName: file.name, mimeType: file.type }, note, reason)))
  file.slice(0, 4).arrayBuffer().then(buffer => answer(new Uint8Array(buffer)), () => answer(new Uint8Array(0)))
}

function discardWorker() {
  if (!worker) return
  worker.terminate()
  worker = null
  workerReady = false
}

// A worker that never loaded counts towards running on the main thread
function failedToLoad() {
  discardWorker()
  workerFailures++
  if (pending) send(pending)
}

function createWorker() {
  if (workerFailures >= MAX_WORKER_FAILURES || typeof Worker === 'undefined') return null
  let instance
  try {
    instance = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
  } catch {
    workerFailures++
    return null
  }
  instance.onmessage = (event) => {
    if (worker !== instance) return
    const { id, analysis, error, ready } = event.data || {}
    if (ready) {
      workerReady = true
      workerFailures = 0
      return
    }
    const request = pending
    if (!request || request.id !== id) return
    if (error !== undefined) giveUp(request, 'crash', String(error || ''))
    else settle(request, () => request.resolve(analysis))
  }
  const fail = (message) => {
    if (worker !== instance) return
    if (!workerReady) failedToLoad()
    else if (pending) giveUp(pending, 'crash', message)
    else discardWorker()
  }
  instance.onerror = (event) => {
    event.preventDefault?.()
    fail(event.message || '')
  }
  instance.onmessageerror = () => fail('its answer could not be read')
  return instance
}

function send(request) {
  if (!worker) worker = createWorker()
  if (!worker) {
    onMainThread(request)
    return
  }
  try {
    worker.postMessage({ id: request.id, file: request.file })
  } catch {
    failedToLoad()
  }
}

/**
 * Analyses a file off the main thread. Only the latest request is answered:
 * an earlier pending promise rejects with StaleAnalysisError. When no worker
 * can run at all, the file is analysed on the main thread instead. When the
 * worker fails on the file or does not answer in time, the promise resolves
 * with the generic facts and a note (`analysis.gaveUp` is set).
 * @param {File} file
 * @returns {Promise<import('./types.js').Analysis>}
 */
export function analyzeFile(file) {
  const id = ++latestId
  if (pending) {
    // The worker is busy with a file nobody wants any more
    clearTimeout(pending.timer)
    discardWorker()
    pending.reject(new StaleAnalysisError())
    pending = null
  }
  return new Promise((resolve, reject) => {
    const request = { id, file, resolve, reject, timer: null }
    pending = request
    const limit = timeoutFor(file.size)
    request.timer = setTimeout(() => giveUp(request, 'timeout', limit), limit)
    send(request)
  })
}
