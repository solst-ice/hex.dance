// A limit on how much work one parse may do. A crafted file can be small and
// still describe millions of rows or gigabytes of text (one table pointed at
// over and over), and a worker that runs out of memory takes the whole tab
// with it. So `runParse` gives each parse a budget in proportion to the file,
// and the helpers every parser already shares (field and summary builders,
// string decoders, the byte reader) charge it. When the budget is spent the
// next charge throws ParseLimitError, which ends the parse wherever it is.
//
// The budget is module state rather than an argument so that the 39 parsers
// need not pass it around. Parses are synchronous, so only one is ever active
// in a thread; runParse restores the previous budget when it returns.

/** Rows (fields, summary items, decoded strings) any parse may produce, whatever the file's size */
export const MIN_ROWS = 500_000
/** Extra rows per byte of file: one row for every 16 bytes */
export const ROWS_PER_BYTE = 1 / 16
/** Characters of text any parse may decode, whatever the file's size */
export const MIN_TEXT = 32 << 20
/** Extra characters per byte of file */
export const TEXT_PER_BYTE = 2
/** Time any parse may take, in milliseconds */
export const MIN_MS = 5000
/** Extra time per megabyte of file */
export const MS_PER_MB = 40

// The clock is read once per this many charges, so a charge costs an increment
const CLOCK_EVERY = 1024

const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()

/** Thrown by a charge once the active budget is spent. */
export class ParseLimitError extends Error {
  constructor(reason) {
    super(`Parse limit reached (${reason})`)
    this.name = 'ParseLimitError'
    this.reason = reason
  }
}

/**
 * The limits for a file of `size` bytes.
 * @param {number} size
 * @returns {{ rows: number, text: number, ms: number }}
 */
export function limitsFor(size) {
  const bytes = Number.isFinite(size) && size > 0 ? size : 0
  return {
    rows: Math.floor(MIN_ROWS + bytes * ROWS_PER_BYTE),
    text: Math.floor(MIN_TEXT + bytes * TEXT_PER_BYTE),
    ms: Math.round(MIN_MS + (bytes / (1 << 20)) * MS_PER_MB)
  }
}

let active = null

function spend(budget, reason) {
  budget.spent = reason
  throw new ParseLimitError(reason)
}

function check(budget) {
  if (budget.spent) throw new ParseLimitError(budget.spent)
  if (++budget.calls % CLOCK_EVERY === 0 && now() > budget.deadline) spend(budget, 'time')
}

/** Charges `count` rows of output to the active parse, if any. */
export function chargeRows(count = 1) {
  const budget = active
  if (!budget) return
  check(budget)
  budget.rows += count
  if (budget.rows > budget.limits.rows) spend(budget, 'rows')
}

/**
 * Gives back rows a capped list threw away. Rows are charged as they are
 * built, but what costs memory is what the parse keeps, and a list that only
 * counts the items past its cap keeps one placeholder for all of them.
 */
export function refundRows(count) {
  const budget = active
  if (budget && count > 0) budget.rows = Math.max(0, budget.rows - count)
}

/** Charges `length` characters of decoded text (and one row) to the active parse, if any. */
export function chargeText(length) {
  const budget = active
  if (!budget) return
  check(budget)
  budget.rows++
  budget.text += length
  if (budget.text > budget.limits.text) spend(budget, 'text')
  if (budget.rows > budget.limits.rows) spend(budget, 'rows')
}

/** Lets a loop that builds nothing still be stopped by the time limit; cheaper than a charge. */
export function tick() {
  const budget = active
  if (budget && ++budget.calls % CLOCK_EVERY === 0) {
    if (budget.spent) throw new ParseLimitError(budget.spent)
    if (now() > budget.deadline) spend(budget, 'time')
  }
}

/**
 * Runs `parse(bytes, meta)` under a budget sized for `bytes`. Never throws:
 * a parser error comes back as `error`, a spent budget as `limit` (the
 * reason: 'rows', 'text' or 'time'), even when the parser caught the error
 * itself and carried on, since its result may then be missing parts.
 * @param {(bytes: Uint8Array, meta: object) => any} parse
 * @param {Uint8Array} bytes
 * @param {object} [meta]
 * @param {Partial<{ rows: number, text: number, ms: number }>} [overrides]  for tests
 * @returns {{ result: any, error: any, limit: string | null, used: { rows: number, text: number, ms: number } }}
 */
export function runParse(parse, bytes, meta = {}, overrides = {}) {
  const limits = { ...limitsFor(bytes.length), ...overrides }
  const started = now()
  const budget = { limits, rows: 0, text: 0, calls: 0, deadline: started + limits.ms, spent: null }
  const previous = active
  active = budget
  let result = null
  let error = null
  try {
    result = parse(bytes, meta)
  } catch (err) {
    error = err
  } finally {
    active = previous
  }
  const used = { rows: budget.rows, text: budget.text, ms: now() - started }
  if (budget.spent) return { result: null, error: null, limit: budget.spent, used }
  return { result, error, limit: null, used }
}

/** A sentence for the analysis' warnings saying why a parse was stopped. */
export function limitWarning(reason) {
  const what = {
    rows: 'describes far more records than a file of its size normally holds',
    text: 'asks for far more text than a file of its size normally holds',
    time: 'took longer to read than a file of its size should'
  }[reason] || 'needed more work than a file of its size should'
  return `The file ${what}, so its analysis was stopped early to keep the page responsive. ` +
    'Only basic facts are shown; the hex view and byte tools still work on the whole file. ' +
    'Files built to look like this are often damaged or made to overload analysis tools.'
}
