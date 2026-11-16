import { analyzeBytes } from './analyze.js'

// After this many workers fail in a row, analysis stays on the main thread
const MAX_WORKER_FAILURES = 2

let worker = null
let workerFailures = 0
let latestId = 0
/** @type {{ id: number, file: File, resolve: Function, reject: Function } | null} */
let pending = null

/** Error used to reject a request that a newer request replaced. */
export class StaleAnalysisError extends Error {
  constructor() {
    super('Analysis superseded by a newer request')
    this.name = 'StaleAnalysisError'
  }
}

async function analyzeOnMainThread(file) {
  const buffer = await file.arrayBuffer()
  return analyzeBytes(new Uint8Array(buffer), { fileName: file.name, mimeType: file.type })
}

function settle(request, run) {
  if (pending !== request) return
  pending = null
  run()
}

function fallBack(request) {
  if (pending !== request) return
  analyzeOnMainThread(request.file).then(
    analysis => settle(request, () => request.resolve(analysis)),
    error => settle(request, () => request.reject(error))
  )
}

function discardWorker() {
  if (!worker) return
  worker.terminate()
  worker = null
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
    const { id, analysis, error } = event.data || {}
    const request = pending
    if (!request || request.id !== id) return
    workerFailures = 0
    if (error !== undefined) fallBack(request)
    else settle(request, () => request.resolve(analysis))
  }
  // A worker that fails to load or crashes is replaced on the next request
  const fail = () => {
    if (worker !== instance) return
    discardWorker()
    workerFailures++
    if (pending) fallBack(pending)
  }
  instance.onerror = (event) => {
    event.preventDefault?.()
    fail()
  }
  instance.onmessageerror = fail
  return instance
}

/**
 * Analyses a file off the main thread. Only the latest request is answered:
 * an earlier pending promise rejects with StaleAnalysisError. When no worker
 * can be used, the file is analysed on the main thread instead.
 * @param {File} file
 * @returns {Promise<import('./types.js').Analysis>}
 */
export function analyzeFile(file) {
  const id = ++latestId
  if (pending) {
    // The worker is busy with a file nobody wants any more
    discardWorker()
    pending.reject(new StaleAnalysisError())
    pending = null
  }
  return new Promise((resolve, reject) => {
    const request = { id, file, resolve, reject }
    pending = request
    if (!worker) worker = createWorker()
    if (!worker) {
      fallBack(request)
      return
    }
    try {
      worker.postMessage({ id, file })
    } catch {
      discardWorker()
      workerFailures++
      fallBack(request)
    }
  })
}
