/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useFile, useHexViewReader, useHighlightLayer, useSelection } from '../../state/hooks.js'
import { parseQuery, describePattern } from './pattern.js'
import { DEFAULT_CAP, startSearch, stepMatch } from './scanner.js'
import { subscribeSearchRequests, takeSearchRequest } from '../../state/searchRequest.js'
import ResultList from './ResultList.jsx'
import './search.css'

const MODES = [
  { id: 'hex', label: 'Hex', placeholder: '7f 45 4c 46 or ffd8ff??' },
  { id: 'text', label: 'Text', placeholder: 'Text to find' },
  { id: 'number', label: 'Number', placeholder: '1234, -5 or 0x4d2' }
]
const WIDTHS = [8, 16, 32, 64]
const DEFAULT_OPTIONS = { utf8: true, utf16: true, ignoreCase: false, widths: WIDTHS, little: true, big: true }
const PROGRESS_MS = 100
const HIGHLIGHT_BLOCK = 1000 // matches tinted on each side of the current block

// Survives the tab being unmounted while another tab is shown. Finished
// results are kept per file, weakly, so a closed file can be freed.
const memory = { mode: 'hex', query: '', options: DEFAULT_OPTIONS }
const finished = new WeakMap()

function queryKey(mode, query, options) {
  const relevant = mode === 'text'
    ? [options.utf8, options.utf16, options.ignoreCase]
    : mode === 'number' ? [options.widths.join(','), options.little, options.big] : []
  return JSON.stringify([mode, query, relevant])
}

// Renders nothing; keeps the latest selection in a ref so the panel itself
// does not re-render on every selection change
function SelectionBridge({ bridge }) {
  const { selection, jumpTo } = useSelection()
  bridge.current = { selection, jumpTo }
  return null
}

function SearchHighlights({ ranges }) {
  useHighlightLayer('search', ranges)
  return null
}

function Toggle({ on, onChange, children, title }) {
  return (
    <button type="button" className={`search-chip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => onChange(!on)} title={title}>
      {children}
    </button>
  )
}

function formatMs(ms) {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`
}

function Search() {
  const { bytes, revision } = useFile()
  const inputId = useId()
  const hintId = useId()
  const inputRef = useRef(null)
  const bridge = useRef(null)
  const hexView = useHexViewReader()
  const searchRef = useRef(null)

  const [mode, setMode] = useState(memory.mode)
  const [query, setQuery] = useState(memory.query)
  const [options, setOptions] = useState(memory.options)
  // { bytes, revision, key, patterns, list, count, scanned, done, capped, ms }
  const [result, setResult] = useState(() => (bytes && finished.get(bytes)) || null)
  const [current, setCurrent] = useState(-1)
  const [scrollKey, setScrollKey] = useState(0)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    memory.mode = mode
    memory.query = query
    memory.options = options
  }, [mode, query, options])

  const parsed = useMemo(() => parseQuery(mode, query, options), [mode, query, options])
  const key = queryKey(mode, query, options)

  const cancel = useCallback(() => {
    searchRef.current?.cancel()
    searchRef.current = null
  }, [])

  // A new file (or leaving the tab) stops the search
  useEffect(() => cancel, [bytes, cancel])
  // Drop the previous file's results so its bytes can be freed
  useEffect(() => {
    setResult(previous => (previous && previous.bytes !== bytes ? null : previous))
    setCurrent(-1)
  }, [bytes])
  const shown = result && result.bytes === bytes ? result : null

  const run = useCallback(() => {
    if (!parsed.ok || !bytes) return
    cancel()
    const patterns = parsed.patterns
    const base = { bytes, revision, key, patterns, done: false, capped: false, ms: 0 }
    let lastUpdate = 0
    const search = startSearch(bytes, patterns, {
      onProgress: (list, scanned) => {
        const now = performance.now()
        if (now - lastUpdate < PROGRESS_MS) return
        lastUpdate = now
        setResult({ ...base, list, count: list.count, scanned })
      },
      onDone: (list, { capped, ms }) => {
        if (searchRef.current === search) searchRef.current = null
        const final = { ...base, list, count: list.count, scanned: bytes.length, done: true, capped, ms }
        finished.set(bytes, final)
        setResult(final)
      }
    })
    searchRef.current = search
    finished.delete(bytes)
    setResult({ ...base, list: search.list, count: 0, scanned: 0 })
    setCurrent(-1)
    setNotice(null)
  }, [parsed, bytes, revision, key, cancel])

  const stop = () => {
    cancel()
    setResult(previous => previous && { ...previous, count: previous.list.count, done: true, cancelled: true })
  }

  const running = Boolean(shown && !shown.done)
  const stale = Boolean(shown && shown.revision !== revision)

  const step = useCallback((direction) => {
    if (!shown || !shown.count) return
    const { selection, jumpTo } = bridge.current
    const position = selection ? selection.start : (hexView.getCursor() ?? 0)
    const { offsets } = shown.list
    const index = stepMatch(offsets, shown.count, position, direction)
    const wrapped = direction > 0 ? offsets[index] <= position : offsets[index] >= position
    if (wrapped && !shown.done) {
      setNotice('Still searching: no more matches found yet in that direction')
      return
    }
    setNotice(wrapped ? `Wrapped to the ${direction > 0 ? 'first' : 'last'} match` : null)
    const length = shown.patterns[shown.list.kinds[index]].values.length
    jumpTo(offsets[index], length)
    setCurrent(index)
    setScrollKey(k => k + 1)
  }, [shown, hexView])

  const pick = useCallback((index) => {
    if (!shown) return
    const length = shown.patterns[shown.list.kinds[index]].values.length
    bridge.current.jumpTo(shown.list.offsets[index], length)
    setCurrent(index)
    setNotice(null)
  }, [shown])

  const onKeyDown = (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (event.shiftKey) step(-1)
    else if (!shown || shown.key !== key || stale || shown.cancelled) run()
    else step(1)
  }

  // Ctrl+F in the hex view
  useEffect(() => {
    const apply = () => {
      const request = takeSearchRequest()
      if (!request) return
      if (request.query) {
        setMode(request.mode || 'hex')
        setQuery(request.query)
      }
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
    apply()
    return subscribeSearchRequests(apply)
  }, [])

  // Tint a block of matches around the current one
  const count = shown ? shown.count : 0
  const block = Math.floor(Math.max(0, current) / HIGHLIGHT_BLOCK)
  const from = Math.max(0, (block - 1) * HIGHLIGHT_BLOCK)
  const to = Math.min(count, (block + 2) * HIGHLIGHT_BLOCK)
  const list = shown?.list
  const patterns = shown?.patterns
  const ranges = useMemo(() => {
    if (!list || to <= from) return null
    const out = []
    for (let i = from; i < to; i++) {
      const start = list.offsets[i]
      out.push({ id: i, start, end: start + patterns[list.kinds[i]].values.length, label: 'Search match' })
    }
    return out
  }, [list, patterns, from, to])

  const setOption = (name, value) => setOptions(previous => ({ ...previous, [name]: value }))
  const toggleWidth = (width, on) => setOptions(previous => ({
    ...previous,
    widths: on ? WIDTHS.filter(w => w === width || previous.widths.includes(w)) : previous.widths.filter(w => w !== width)
  }))

  if (!bytes) return <section className="hd-panel search"><p className="hd-empty">Reading file…</p></section>

  const modeInfo = MODES.find(m => m.id === mode)
  const hint = parsed.ok
    ? parsed.patterns.map(p => (parsed.patterns.length > 1 ? `${p.label}: ` : '') + describePattern(p)).join('  ·  ')
    : parsed.error
  const position = current >= 0 && shown ? current + 1 : null

  return (
    <section className="hd-panel search">
      <SelectionBridge bridge={bridge} />
      <SearchHighlights ranges={ranges} />
      <div className="search-modes" role="group" aria-label="Search for">
        {MODES.map(m => (
          <button key={m.id} type="button" className={`search-mode${m.id === mode ? ' is-on' : ''}`}
            aria-pressed={m.id === mode} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      <div className="search-bar">
        <label htmlFor={inputId} className="search-sr">Search {modeInfo.label.toLowerCase()}</label>
        <input
          ref={inputRef}
          id={inputId}
          className="hd-input search-input"
          type="text"
          inputMode={mode === 'number' ? 'numeric' : undefined}
          spellCheck={false}
          autoComplete="off"
          placeholder={modeInfo.placeholder}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby={hintId}
          aria-invalid={!parsed.ok && !parsed.empty}
        />
        {running
          ? <button type="button" className="hd-button search-go" onClick={stop}>Cancel</button>
          : <button type="button" className="hd-button search-go" onClick={run} disabled={!parsed.ok}>Find</button>}
      </div>

      <p id={hintId} className={`search-hint${parsed.ok || parsed.empty ? '' : ' is-error'}`}>{hint}</p>

      {mode === 'text' && (
        <div className="search-options" role="group" aria-label="Text options">
          <Toggle on={options.utf8} onChange={v => setOption('utf8', v)} title="Search the UTF-8 (ASCII) encoding">UTF-8</Toggle>
          <Toggle on={options.utf16} onChange={v => setOption('utf16', v)} title="Search the UTF-16 little-endian encoding">UTF-16LE</Toggle>
          <label className="search-check">
            <input type="checkbox" checked={options.ignoreCase} onChange={e => setOption('ignoreCase', e.target.checked)} />
            Ignore case (A–Z)
          </label>
        </div>
      )}
      {mode === 'number' && (
        <div className="search-options" role="group" aria-label="Number options">
          {WIDTHS.map(width => (
            <Toggle key={width} on={options.widths.includes(width)} onChange={on => toggleWidth(width, on)}
              title={`Search ${width}-bit encodings`}>{width}</Toggle>
          ))}
          <span className="search-options-gap" />
          <Toggle on={options.little} onChange={v => setOption('little', v)} title="Little-endian">LE</Toggle>
          <Toggle on={options.big} onChange={v => setOption('big', v)} title="Big-endian">BE</Toggle>
        </div>
      )}

      {shown && (
        <div className="search-results">
          <div className="search-summary" role="status" aria-live="polite">
            {running && (
              <progress className="search-progress" max={bytes.length || 1} value={shown.scanned} aria-label="Search progress" />
            )}
            <span>
              {running && `Searching ${Math.floor((shown.scanned / (bytes.length || 1)) * 100)}% · `}
              <strong>{shown.count.toLocaleString()}{shown.capped ? '+' : ''}</strong> {shown.count === 1 ? 'match' : 'matches'}
              {shown.done && !shown.cancelled && !shown.capped && ` in ${formatMs(shown.ms)}`}
              {shown.cancelled && ' (cancelled)'}
            </span>
            {shown.capped && (
              <span className="hd-muted">Stopped at {DEFAULT_CAP.toLocaleString()}; refine the pattern to see all.</span>
            )}
          </div>
          {stale && (
            <p className="hd-warning search-stale">
              Bytes changed since this search; results may be out of date.{' '}
              <button type="button" className="hd-button hd-button--small" onClick={run} disabled={!parsed.ok}>Search again</button>
            </p>
          )}
          {shown.key !== key && !running && (
            <p className="hd-muted search-stale">Showing results for an earlier query. Press Enter to search for this one.</p>
          )}
          {shown.count > 0 && (
            <>
              <div className="search-nav">
                <button type="button" className="hd-button hd-button--small" onClick={() => step(-1)} title="Previous match (Shift+Enter)">
                  ‹ Previous
                </button>
                <button type="button" className="hd-button hd-button--small" onClick={() => step(1)} title="Next match (Enter)">
                  Next ›
                </button>
                <span className="hd-muted search-pos">
                  {position ? `${position.toLocaleString()} of ${shown.count.toLocaleString()}` : 'Steps from the cursor'}
                </span>
              </div>
              {notice && <p className="hd-muted search-notice">{notice}</p>}
              <ResultList
                bytes={bytes}
                revision={revision}
                offsets={shown.list.offsets}
                kinds={shown.list.kinds}
                count={shown.count}
                patterns={shown.patterns}
                current={current}
                scrollKey={scrollKey}
                onPick={pick}
              />
            </>
          )}
          {shown.done && shown.count === 0 && <p className="hd-empty">No matches</p>}
        </div>
      )}
      {!shown && (
        <p className="hd-muted search-help">
          Enter searches; Enter again and Shift+Enter step through matches from the cursor. Ctrl+F in the hex view comes here.
        </p>
      )}
    </section>
  )
}

export default Search
