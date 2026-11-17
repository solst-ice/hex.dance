/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFile, useSelectionActions } from '../../state/hooks.js'
import { streamToWorker } from '../../lib/chunkStream.js'
import CopyButton from '../../components/CopyButton.jsx'
import { CLASSES } from './classify.js'
import { ASCII, UTF16LE, readString } from './scan.js'
import { StringStore, collectMatches, compileFilter } from './store.js'
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

  // Matches grow with the store, so they are extended rather than recomputed
  const matchRef = useRef({ key: null, store: null, list: null, scanned: 0, error: null })
  const filterKey = `${debouncedQuery}\u0000${classBit}\u0000${encoding}`
  const matches = matchRef.current
  if (matches.key !== filterKey || matches.store !== store) {
    const { test, error } = compileFilter({ query: debouncedQuery, classBit, encoding })
    Object.assign(matches, { key: filterKey, store, test, list: test ? [] : null, scanned: 0, error })
  }
  if (store && matches.test && matches.scanned < store.count) {
    collectMatches(store, matches.test, matches.scanned, matches.list)
    matches.scanned = store.count
  }
  const matchCount = matches.list ? matches.list.length : count

  const activeIndex = active.buffer === buffer && store && active.index < count ? active.index : -1

  const pick = useCallback((index) => {
    setActive({ buffer, index })
    if (!store) return
    jumpRef.current?.(store.offsets[index], Math.max(1, store.byteLength(index)))
  }, [buffer, store])

  const fullText = useCallback((index) => {
    const text = store.texts[index]
    const length = store.lengths[index]
    return length > text.length ? readString(bytes, store.offsets[index], store.encodings[index], length) : text
  }, [store, bytes])

  const allMatchesText = () => {
    if (!store) return ''
    const out = []
    if (matches.list) for (const index of matches.list) out.push(fullText(index))
    else for (let index = 0; index < count; index++) out.push(fullText(index))
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
          {matches.error
            ? <span className="hd-warning">Invalid pattern: {matches.error}</span>
            : matches.list
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
            label={matches.list ? 'Copy matches' : 'Copy all'}
            ariaLabel={matches.list ? `Copy all ${matchCount} matching strings` : `Copy all ${count} strings`}
            disabled={matchCount === 0}
            getText={allMatchesText}
          />
        </span>
      </div>

      {store && matchCount > 0 && (
        <StringList
          store={store}
          list={matches.list}
          count={matchCount}
          version={count}
          activeIndex={activeIndex}
          onPick={pick}
          onMove={pick}
          resetKey={filterKey + (scan?.startedAt ?? '')}
          label="Strings found in the file"
          digits={digits}
        />
      )}
      {store && matchCount === 0 && !scanning && (
        <p className="hd-empty">{count === 0 ? 'No strings found.' : 'No strings match.'}</p>
      )}
      {(!store || (matchCount === 0 && scanning)) && <p className="hd-empty">Scanning…</p>}
    </section>
  )
}

export default Strings
