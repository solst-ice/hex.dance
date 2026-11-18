/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFile, useSelectionActions } from '../../state/hooks.js'
import { streamToWorker } from '../../lib/chunkStream.js'
import CopyButton from '../../components/CopyButton.jsx'
import { CLASSES } from './classify.js'
import { ASCII, UTF16LE, readString } from './scan.js'
import { StringStore, collectMatches, compileFilter } from './store.js'
import { SLOW_MESSAGE, regexShown, startRegexFilter } from './regexFilter.js'
import StringList from './StringList.jsx'
import './strings.css'

// Memory cap: at most this many strings are kept, holding at most this many
// characters in total (each string keeps at most MAX_TEXT of its characters
// for display and filtering; copying reads the full string from the file).
// Scanning goes on past the cap to count what was left out.
const MAX_STRINGS = 400000
const MAX_CHARS = 24 * 1024 * 1024
const MAX_TEXT = 256
const DEFAULT_MIN = 5
const MIN_LIMITS = [2, 64]

// Finished scans per loaded buffer, so switching tabs does not rescan
const scanCache = new WeakMap()

const hexOffset = (n) => '0x' + n.toString(16).toUpperCase()

function formatDuration(ms) {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`
}

function useStringScan({ buffer, bytes, minLength, token, revision }) {
  const revisionRef = useRef(revision)
  revisionRef.current = revision
  const [scan, setScan] = useState(null)

  useEffect(() => {
    if (!bytes) return undefined
    const cached = scanCache.get(buffer)
    if (token === 0 && cached && cached.minLength === minLength) {
      setScan({ ...cached })
      return undefined
    }
    const state = {
      buffer,
      minLength,
      revision: revisionRef.current,
      store: new StringStore(),
      status: 'scanning',
      position: 0,
      size: bytes.length,
      total: 0,
      cappedAt: -1,
      startedAt: performance.now(),
      firstAt: 0,
      doneAt: 0,
      error: null
    }
    setScan({ ...state })
    const job = streamToWorker({
      createWorker: () => new Worker(new URL('./strings.worker.js', import.meta.url), { type: 'module' }),
      bytes,
      params: { minLength, maxText: MAX_TEXT, maxStrings: MAX_STRINGS, maxChars: MAX_CHARS },
      firstChunkSize: 256 << 10,
      chunkSize: 4 << 20,
      overlap: 1,
      onMessage(message) {
        if (message.type !== 'batch' && message.type !== 'done') return
        state.store.append(message)
        state.position = message.position
        state.total = message.total
        state.cappedAt = message.cappedAt
        if (!state.firstAt && (state.store.count > 0 || message.type === 'done')) state.firstAt = performance.now()
        if (message.type === 'done') {
          state.status = 'done'
          state.doneAt = performance.now()
          scanCache.set(buffer, state)
        }
        setScan({ ...state })
      },
      onError(error) {
        state.status = 'error'
        state.error = error
        setScan({ ...state })
      }
    })
    return () => job.cancel()
  }, [buffer, bytes, minLength, token])

  return scan && scan.buffer === buffer ? scan : null
}

// Gives the panel `jumpTo` without re-rendering it on every selection change
function JumpBridge({ jumpRef }) {
  const { jumpTo } = useSelectionActions()
  jumpRef.current = jumpTo
  return null
}

function MinLengthInput({ value, onChange }) {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    const n = Number.parseInt(text, 10)
    if (!Number.isFinite(n)) return undefined
    const clamped = Math.min(MIN_LIMITS[1], Math.max(MIN_LIMITS[0], n))
    if (clamped === value) return undefined
    const timer = setTimeout(() => onChange(clamped), 400)
    return () => clearTimeout(timer)
  }, [text, value, onChange])
  return (
    <label className="strings-min hd-row">
      <span>Min length</span>
      <input
        className="hd-input"
        type="number"
        inputMode="numeric"
        min={MIN_LIMITS[0]}
        max={MIN_LIMITS[1]}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => setText(String(value))}
      />
    </label>
  )
}

const createFilterWorker = () => new Worker(new URL('./filter.worker.js', import.meta.url), { type: 'module' })

// Runs a /regex/ filter in a worker. Returns the job's latest state, tagged
// with the filter key and store it belongs to; a newer filter cancels the
// older job, which then reports nothing more.
function useRegexFilter({ store, count, filter, filterKey }) {
  const [current, setCurrent] = useState(null)
  const jobRef = useRef(null)
  useEffect(() => {
    if (!store || !filter.regex) return undefined
    let result = null
    setCurrent({ key: filterKey, store, status: 'running', result: null, scanned: 0 })
    const job = startRegexFilter({
      store,
      regex: filter.regex,
      prefilter: filter.prefilter,
      createWorker: createFilterWorker,
      onUpdate({ status, list, count: listed, scanned, error }) {
        if (status === 'done') result = { key: filterKey, store, list, count: listed }
        setCurrent({ key: filterKey, store, status, result, scanned, error })
      }
    })
    jobRef.current = job
    return () => {
      job.cancel()
      if (jobRef.current === job) jobRef.current = null
    }
  }, [store, filter, filterKey])
  // Strings still arriving from the scan are tested as they come
  useEffect(() => { jobRef.current?.update() }, [count])
  return current
}

function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

function Strings() {
  const { buffer, bytes, revision } = useFile()
  const [minLength, setMinLength] = useState(() => scanCache.get(buffer)?.minLength ?? DEFAULT_MIN)
  const [token, setToken] = useState(0)
  const [query, setQuery] = useState('')
  const [classBit, setClassBit] = useState(0)
  const [encoding, setEncoding] = useState(-1)
  const [active, setActive] = useState({ buffer: null, index: -1 })
  const jumpRef = useRef(null)
  const debouncedQuery = useDebounced(query, 150)
  const scan = useStringScan({ buffer, bytes, minLength, token, revision })

  const store = scan?.store || null
  const count = store ? store.count : 0

  const filterKey = `${debouncedQuery}\u0000${classBit}\u0000${encoding}`
  const filter = useMemo(() => compileFilter({ query: debouncedQuery, classBit, encoding }), [debouncedQuery, classBit, encoding])
  const regexState = useRegexFilter({ store, count, filter, filterKey })
  const regexCurrent = filter.regex && regexState && regexState.key === filterKey && regexState.store === store ? regexState : null

  // Plain-text, class and encoding filters run here; they are linear and fast.
  // Matches grow with the store, so they are extended rather than recomputed
  const matchRef = useRef({ key: null, store: null, list: null, scanned: 0, test: null })
  const matches = matchRef.current
  if (!filter.regex) {
    if (matches.key !== filterKey || matches.store !== store) {
      Object.assign(matches, { key: filterKey, store, test: filter.test, list: filter.test ? [] : null, scanned: 0 })
    }
    if (store && matches.test && matches.scanned < store.count) {
      collectMatches(store, matches.test, matches.scanned, matches.list)
      matches.scanned = store.count
    }
  }

  // What the list shows: a regular expression keeps the previous list until
  // its own result is ready, and keeps it if the pattern is stopped
  const shownRef = useRef(null)
  const shown = filter.regex
    ? regexShown({ key: filterKey, store, current: regexState, previous: shownRef.current })
    : { key: filterKey, store, list: matches.list, count: matches.list ? matches.list.length : 0 }
  if (shown) shownRef.current = shown
  const shownList = shown ? shown.list : null
  const matchCount = !shown ? 0 : shownList ? shown.count : count
  const filtering = Boolean(regexCurrent && regexCurrent.status === 'running' && !regexCurrent.result)
  const filterStatus = !filter.regex ? 'sync' : regexCurrent ? regexCurrent.status : 'running'

  const activeIndex = active.buffer === buffer && store && active.index < count ? active.index : -1

  const pick = useCallback((index, options) => {
    setActive({ buffer, index })
    if (!store) return
    jumpRef.current?.(store.offsets[index], Math.max(1, store.byteLength(index)), options)
  }, [buffer, store])
  // Arrow keys step through the list: the hex view follows without flashing
  const move = useCallback((index) => pick(index, { flash: false }), [pick])

  const fullText = useCallback((index) => {
    const text = store.texts[index]
    const length = store.lengths[index]
    return length > text.length ? readString(bytes, store.offsets[index], store.encodings[index], length) : text
  }, [store, bytes])

  const allMatchesText = () => {
    if (!store) return ''
    const out = []
    if (shownList) for (let k = 0; k < matchCount; k++) out.push(fullText(shownList[k]))
    else for (let index = 0; index < matchCount; index++) out.push(fullText(index))
    return out.join('\n')
  }

  if (!bytes) return <section className="hd-panel"><p className="hd-empty">Reading file…</p></section>

  const scanning = scan?.status === 'scanning'
  const stale = scan && scan.status === 'done' && scan.revision !== revision
  const size = bytes.length
  const digits = Math.max(4, size > 0 ? (size - 1).toString(16).length : 1)
  const fraction = scan && scan.size ? scan.position / scan.size : 1

  return (
    <section
      className="hd-panel strings-panel"
      aria-label="Strings"
      data-status={scan?.status || 'idle'}
      data-count={count}
      data-total={scan?.total ?? 0}
      data-first-ms={scan?.firstAt ? Math.round(scan.firstAt - scan.startedAt) : ''}
      data-done-ms={scan?.doneAt ? Math.round(scan.doneAt - scan.startedAt) : ''}
      data-filter={filterStatus}
      data-filter-query={debouncedQuery}
    >
      <JumpBridge jumpRef={jumpRef} />
      <div className="hd-panel-header">
        <MinLengthInput value={minLength} onChange={setMinLength} />
      </div>

      <div className="strings-status" aria-live="polite">
        {scanning && (
          <div className="hd-row">
            <progress max={100} value={Math.round(fraction * 100)} aria-label="Scanning for strings" />
            <span className="hd-muted">
              Scanning {Math.round(fraction * 100)}%, {scan.total.toLocaleString()} found
            </span>
          </div>
        )}
        {scan?.status === 'done' && (
          <span className="hd-muted">
            {scan.total.toLocaleString()} strings of {scan.minLength}+ characters in {formatDuration(scan.doneAt - scan.startedAt)}
          </span>
        )}
        {scan?.status === 'error' && <p className="hd-warning" role="alert">Scanning failed: {scan.error.message}</p>}
      </div>

      {stale && (
        <div className="hd-row strings-notice strings-stale" role="status">
          <span className="hd-badge hd-badge--yellow">File changed</span>
          <span>The bytes were edited after this scan.</span>
          <button type="button" className="hd-button hd-button--small" onClick={() => setToken(t => t + 1)}>Rescan</button>
        </div>
      )}
      {scan && scan.cappedAt >= 0 && (
        <p className="strings-notice hd-warning" role="status">
          Keeping the first {count.toLocaleString()} strings, up to offset {hexOffset(scan.cappedAt)}, to limit memory use.
          {scan.status === 'done' && ` ${(scan.total - count).toLocaleString()} more were found after that.`}
          {' '}A higher minimum length shows more of the file.
        </p>
      )}

      <div className="strings-controls hd-stack">
        <div className="hd-row strings-search">
          <input
            className="hd-input"
            type="search"
            placeholder="Filter (text or /regex/)"
            aria-label="Filter strings"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="hd-input"
            aria-label="Encoding"
            value={encoding}
            onChange={(event) => setEncoding(Number(event.target.value))}
          >
            <option value={-1}>All encodings</option>
            <option value={ASCII}>ASCII ({store ? store.encodingCounts[ASCII].toLocaleString() : 0})</option>
            <option value={UTF16LE}>UTF-16LE ({store ? store.encodingCounts[UTF16LE].toLocaleString() : 0})</option>
          </select>
        </div>
        <div className="hd-row strings-classes" role="group" aria-label="Quick filters">
          {CLASSES.map((c, k) => {
            const n = store ? store.classCounts[k] : 0
            const on = classBit === c.bit
            return (
              <button
                key={c.id}
                type="button"
                className={'hd-button hd-button--small' + (on ? ' hd-button--active' : '')}
                aria-pressed={on}
                disabled={n === 0 && !on}
                onClick={() => setClassBit(on ? 0 : c.bit)}
              >
                {c.label} <span className="strings-chip-count">{n.toLocaleString()}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="hd-row strings-summary">
        <span className="strings-match-count" aria-live="polite">
          {filter.error
            ? <span className="hd-warning">Invalid pattern: {filter.error}</span>
            : regexCurrent?.status === 'slow'
              ? <span className="hd-warning" role="alert">{SLOW_MESSAGE}</span>
              : regexCurrent?.status === 'error'
                ? <span className="hd-warning" role="alert">The filter could not run: {regexCurrent.error}</span>
                : filtering
                  ? `Filtering… ${count ? Math.floor((regexCurrent.scanned / count) * 100) : 0}%`
                  : shownList
                    ? `${matchCount.toLocaleString()} of ${count.toLocaleString()} match`
                    : `${count.toLocaleString()} strings`}
        </span>
        <span className="strings-actions hd-row">
          <CopyButton
            label="Copy"
            ariaLabel="Copy the selected string"
            disabled={activeIndex < 0}
            getText={() => (activeIndex >= 0 ? fullText(activeIndex) : null)}
          />
          <CopyButton
            label={shownList ? 'Copy matches' : 'Copy all'}
            ariaLabel={shownList ? `Copy all ${matchCount} matching strings` : `Copy all ${count} strings`}
            disabled={matchCount === 0}
            getText={allMatchesText}
          />
        </span>
      </div>

      {store && matchCount > 0 && (
        <StringList
          store={store}
          list={shownList}
          count={matchCount}
          version={count}
          activeIndex={activeIndex}
          onPick={pick}
          onMove={move}
          resetKey={shown.key + (scan?.startedAt ?? '')}
          label="Strings found in the file"
          digits={digits}
        />
      )}
      {store && shown && matchCount === 0 && !scanning && (
        <p className="hd-empty">{count === 0 ? 'No strings found.' : 'No strings match.'}</p>
      )}
      {store && !shown && !scanning && <p className="hd-empty">Filtering…</p>}
      {(!store || (matchCount === 0 && scanning)) && <p className="hd-empty">Scanning…</p>}
    </section>
  )
}

export default Strings
