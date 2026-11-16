// The scan: prefilter each chunk, then confirm every candidate with its
// family's validator and, where the app has a parser for the format, with
// that parser's detect and (bounded) parse. Pure and environment-neutral:
// it runs in the worker and under node --test.

import { createPrefilter, prefilterRange } from './prefilter.js'
import { SIGNATURES, SIGNATURE_BY_ID } from './signatures.js'
import { VALIDATORS } from './validate/index.js'

export const LIMITS = {
  /** the scan stops after this many confirmed hits */
  maxHits: 2000,
  /** time one candidate may take to confirm (walkers stop and report what they know) */
  confirmMs: 1000,
  /** total confirmation time per signature family before its remaining candidates are only counted */
  familyMs: 5000,
  /** candidates of one family checked per chunk; the rest are counted */
  candidatesPerChunk: 20000,
  /** a parser runs only on hits up to this size */
  parseWindow: 8 << 20,
  /** total parse time per format module before the scan stops calling it */
  parseBudgetMs: 3000,
  /** %%EOF positions remembered for resolving PDF ends */
  markers: 100000,
  chunkSize: 4 << 20
}

// Records a walker skips are also reported under these ids
const ALSO_SKIP = { zip: ['zip-end'] }

const TRAILING = /trailing|overlay|appended|after the end|extra data/i

/** Largest end offset among the parser's regions and top-level fields, ignoring regions that describe extra data. */
export function parserExtent(analysis) {
  let end = 0
  for (const r of analysis?.regions || []) {
    if (r && Number.isFinite(r.offset) && Number.isFinite(r.length) && !TRAILING.test(r.name || '')) end = Math.max(end, r.offset + r.length)
  }
  for (const f of analysis?.fields || []) {
    if (f && Number.isFinite(f.offset) && Number.isFinite(f.length) && !TRAILING.test(f.name || '')) end = Math.max(end, f.offset + f.length)
  }
  return end
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * @typedef {Object} Hit
 * @property {number} id
 * @property {number} start
 * @property {number|null} end
 * @property {'exact'|'estimated'} endKind
 * @property {number} [claimedEnd]
 * @property {string} type
 * @property {string} name
 * @property {string} ext
 * @property {'high'|'medium'|'low'} confidence
 * @property {string} note
 * @property {string} signature    the signature id that found it
 * @property {'parsed'|'detected'|'rejected'|'parse-error'|null} parser   what the app's own parser said
 * @property {string} [parserName]
 */

/**
 * @param {Object} options
 * @param {import('./source.js').ByteSource} options.source
 * @param {Array<{ id: string, name: string, detect: Function, parse: Function }>} [options.formats]   the app's FORMATS
 * @param {Partial<typeof LIMITS>} [options.limits]
 * @param {(hit: Hit) => void} [options.onHit]
 * @param {(hit: Hit) => void} [options.onUpdate]   a hit's end was resolved after the scan
 * @param {(position: number) => void} [options.onProgress]
 * @param {() => boolean} [options.isCancelled]
 */
export async function scanFile({ source, formats = [], limits: overrides, onHit, onUpdate, onProgress, isCancelled }) {
  const limits = { ...LIMITS, ...overrides }
  const size = source.size
  const modules = new Map(formats.map(f => [f.id, f]))
  const prefilter = createPrefilter(SIGNATURES)
  const hits = []
  const seen = new Set()
  const skip = new Set()
  const eofMarkers = []
  const stats = {}
  const moduleTime = {}
  let lastNonZero = -1
  let capped = false
  let stoppedAt = -1
  let pending = []
  const perChunk = {}

  const statFor = (id) => (stats[id] ||= { candidates: 0, confirmed: 0, rejected: 0, unchecked: 0, ms: 0 })

  async function confirmWithParser(hit, moduleId) {
    const mod = modules.get(moduleId)
    if (!mod) return
    const known = hit.end !== null
    const length = known ? hit.end - hit.start : Math.min(size - hit.start, 1 << 20)
    const parseable = length <= limits.parseWindow
    const bytes = await source.read(hit.start, parseable ? length : 64 << 10)
    let accepted = false
    try {
      accepted = Boolean(mod.detect(bytes))
    } catch {
      accepted = false
    }
    hit.parserName = mod.name
    if (!accepted) {
      hit.parser = 'rejected'
      hit.confidence = 'low'
      hit.note += `; the app's ${mod.name} parser does not recognise it`
      return
    }
    hit.parser = 'detected'
    if (!parseable || (moduleTime[moduleId] || 0) > limits.parseBudgetMs) return
    const t0 = now()
    try {
      const analysis = mod.parse(bytes, {}) || {}
      hit.parser = 'parsed'
      if (analysis.formatName) hit.parserName = analysis.formatName
      if (!known) {
        const end = parserExtent(analysis)
        if (end > 0 && end < bytes.length) {
          hit.end = hit.start + end
          hit.endKind = 'estimated'
          hit.note += '; end from the app\'s parser'
        }
      }
      if (hit.confidence === 'low') hit.confidence = 'medium'
    } catch (error) {
      hit.parser = 'parse-error'
      if (known && hit.confidence === 'high') hit.confidence = 'medium'
      hit.note += `; the app's parser stopped: ${String(error?.message || error).slice(0, 80)}`
    }
    moduleTime[moduleId] = (moduleTime[moduleId] || 0) + (now() - t0)
  }

  async function check(id, start) {
    const stat = statFor(id)
    const validator = VALIDATORS[id]
    if (!validator) return
    const t0 = now()
    const deadline = Date.now() + limits.confirmMs
    let result = null
    try {
      result = await validator({ src: source, start, size, deadline, expired: () => Date.now() > deadline })
    } catch {
      result = null
    }
    stat.ms += now() - t0
    if (!result) {
      stat.rejected++
      return
    }
    const key = `${result.type}@${result.start}`
    if (seen.has(key)) return
    seen.add(key)
    for (const offset of result.skip || []) {
      skip.add(`${id}@${offset}`)
      for (const other of ALSO_SKIP[id] || []) skip.add(`${other}@${offset}`)
    }
    const signature = SIGNATURE_BY_ID.get(id)
    /** @type {Hit} */
    const hit = {
      id: hits.length,
      start: result.start,
      end: result.end,
      endKind: result.end === null ? 'exact' : result.endKind || 'exact',
      type: result.type,
      name: result.name || signature.name,
      ext: result.ext || signature.ext,
      confidence: result.confidence,
      note: result.note,
      signature: id,
      parser: null
    }
    if (result.claimedEnd !== undefined) hit.claimedEnd = result.claimedEnd
    if (result.deferred) hit.deferred = true
    if (result.module && !result.deferred) await confirmWithParser(hit, result.module)
    if (result.module) hit.module = result.module
    stat.confirmed++
    hits.push(hit)
    onHit?.(hit)
    if (hits.length >= limits.maxHits) capped = true
  }

  await prefilterRange((start, end) => source.read(start, end - start), size, {
    prefilter,
    chunkSize: limits.chunkSize,
    isCancelled: () => capped || Boolean(isCancelled?.()),
    onMatch(id, start) {
      if (id === 'pdf-eof') {
        if (eofMarkers.length < limits.markers) eofMarkers.push(start)
        return
      }
      const stat = statFor(id)
      stat.candidates++
      perChunk[id] = (perChunk[id] || 0) + 1
      if (perChunk[id] > limits.candidatesPerChunk) {
        stat.unchecked++
        return
      }
      pending.push(id, start)
    },
    async onChunk(buf, base, end) {
      for (const key of Object.keys(perChunk)) perChunk[key] = 0
      source.pin(buf, base)
      for (let i = end - base - 1; i >= 0; i--) {
        if (buf[i] !== 0) {
          lastNonZero = Math.max(lastNonZero, base + i)
          break
        }
      }
      const list = []
      for (let k = 0; k < pending.length; k += 2) list.push([pending[k + 1], pending[k]])
      pending = []
      list.sort((a, b) => a[0] - b[0])
      for (const [start, id] of list) {
        if (capped || isCancelled?.()) {
          if (capped && stoppedAt < 0) stoppedAt = start
          return
        }
        if (skip.has(`${id}@${start}`)) {
          statFor(id).candidates--
          continue
        }
        const stat = statFor(id)
        if (stat.ms > limits.familyMs) {
          stat.unchecked++
          continue
        }
        await check(id, start)
      }
      source.pin(null)
      onProgress?.(end)
    }
  })

  // PDF ends: the last %%EOF before the next PDF header
  const pdfs = hits.filter(h => h.deferred).sort((a, b) => a.start - b.start)
  eofMarkers.sort((a, b) => a - b)
  for (let k = 0; k < pdfs.length && !isCancelled?.(); k++) {
    const hit = pdfs[k]
    const limit = k + 1 < pdfs.length ? pdfs[k + 1].start : size
    let last = -1
    for (const m of eofMarkers) {
      if (m > hit.start && m < limit) last = m
      else if (m >= limit) break
    }
    delete hit.deferred
    if (last >= 0) {
      let end = last + 5
      const tail = await source.read(end, 2)
      if (tail[0] === 0x0D) end++
      if (tail[tail[0] === 0x0D ? 1 : 0] === 0x0A) end++
      hit.end = end
      hit.endKind = 'exact'
      hit.confidence = 'high'
      hit.note += ', ends at its last %%EOF'
    } else {
      hit.note += '; no %%EOF marker after it'
    }
    if (hit.module) await confirmWithParser(hit, hit.module)
    onUpdate?.(hit)
  }

  return { hits, stats, lastNonZero, capped, stoppedAt, size }
}
