/**
 * What a validator gets: the candidate and a way to read the file.
 * @typedef {Object} CheckContext
 * @property {import('../source.js').ByteSource} src
 * @property {number} start      where the candidate file would begin
 * @property {number} size       file size
 * @property {() => boolean} expired   true once this candidate's time is up
 *
 * What a validator returns for a confirmed candidate (null rejects it).
 * @typedef {Object} Check
 * @property {string} type        family id for display and filtering, e.g. 'png', 'zip'
 * @property {string} [name]      display name when more specific than the family's
 * @property {string} [ext]       extension for extracted bytes
 * @property {string} [module]    id of the app's format module to confirm with, if any
 * @property {'high'|'medium'|'low'} confidence
 *   high: the structure was walked to its end or a checksum matched;
 *   medium: header fields are consistent; low: signature only
 * @property {number|null} end    exclusive end offset, or null when unknown
 * @property {'exact'|'estimated'} [endKind]
 * @property {number} [claimedEnd]  where the structure says it ends when that is past the end of the file
 * @property {string} note
 * @property {number} [start]     a different start than the candidate's (a ZIP found from its end record)
 * @property {number[]} [skip]    offsets of this file's own records that the scan should not report again
 * @property {boolean} [deferred] the end is resolved after the scan (PDF)
 */

/** @returns {import('./common.js').Check} */
export function found(ctx, check) {
  const start = check.start ?? ctx.start
  const out = { endKind: 'exact', ...check, start }
  if (out.end !== null && out.end !== undefined) {
    if (out.end > ctx.size) {
      out.claimedEnd = out.end
      out.end = ctx.size
    }
    if (out.end <= start) out.end = null
  } else {
    out.end = null
  }
  return out
}

export const plural = (n, word, many = word + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`

export function sizeText(n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export const hex = (n) => '0x' + n.toString(16).toUpperCase()
