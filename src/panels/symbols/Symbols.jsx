/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFile, useSelection } from '../../state/hooks.js'
import { copyText } from '../../lib/clipboard.js'
import { formatOffset } from '../../lib/format.js'
import SymbolTable from './SymbolTable.jsx'
import { buildModel, capabilitySummary, describeType, filterRows, QUICK_FILTERS, TYPE_LETTERS } from './model.js'
import './symbols.css'

const TITLES = { macho: 'Mach-O Symbols', pe: 'PE Symbols', elf: 'ELF Symbols' }
const FILTER_DELAY = 150

// The catalogue and the demangler are only fetched when the tab is opened
let catalogPromise = null
const loadCatalog = () => (catalogPromise ||= import('../../formats/apiCatalog.js'))
let demanglerPromise = null
const loadDemangler = () => (demanglerPromise ||= import('../../formats/demangle.js'))

// Keeps hex-view selection changes away from the table: only this component
// re-renders when the selection moves, and it renders nothing.
function SelectionBridge({ apiRef }) {
  const { jumpTo } = useSelection()
  apiRef.current = jumpTo
  return null
}

function Details({ symbol, demangled, api, onJump, onCopy, copied, formatId }) {
  if (!symbol) {
    return <p className="hd-muted symbols-hint">Select a symbol to see its details. Rows with bytes in the file jump to them in the hex view.</p>
  }
  return (
    <section className="symbols-details" aria-label="Selected symbol">
      <p className="hd-mono symbols-details-name">{symbol.name}</p>
      {demangled && demangled !== symbol.name && <p className="hd-mono symbols-details-demangled">{demangled}</p>}
      <dl className="hd-kv">
        <dt>Type</dt>
        <dd><span className="symbols-letter">{symbol.type}</span> {describeType(symbol.type)}</dd>
        {symbol.address && <><dt>{formatId === 'pe' ? 'RVA' : 'Address'}</dt><dd className="hd-mono">{symbol.address}</dd></>}
        {symbol.offset !== undefined && <><dt>File offset</dt><dd className="hd-mono">{formatOffset(symbol.offset)}</dd></>}
        {symbol.size !== undefined && <><dt>Size</dt><dd>{symbol.size.toLocaleString()} bytes</dd></>}
        {symbol.library && <><dt>Library</dt><dd className="hd-mono">{symbol.library}</dd></>}
        {symbol.note && symbol.note !== symbol.library && <><dt>Note</dt><dd>{symbol.note}</dd></>}
        {api && <><dt>What it does</dt><dd>{api.description}{api.tag ? <> <span className="symbols-tag">{api.tag}</span></> : null}</dd></>}
      </dl>
      <div className="hd-row symbols-actions">
        {symbol.offset !== undefined
          ? <button type="button" className="hd-button hd-button--small" onClick={onJump}>Show bytes</button>
          : <span className="hd-muted symbols-reason">{symbol.reason || 'No file offset is known for this symbol.'}</span>}
        <button type="button" className="hd-button hd-button--small" onClick={onCopy}>Copy name</button>
        <span role="status" className="hd-muted symbols-copied">{copied ? 'Copied' : ''}</span>
      </div>
    </section>
  )
}

function Symbols() {
  const { analysis } = useFile()
  const jumpRef = useRef(null)
  const symbols = analysis ? analysis.symbols : null
  const model = useMemo(() => buildModel(symbols || []), [symbols])

  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [quick, setQuick] = useState('all')
  const [sort, setSort] = useState({ key: 'name', descending: false })
  const [tag, setTag] = useState(null)
  const [selected, setSelected] = useState(null)
  const [copied, setCopied] = useState(false)
  const [catalog, setCatalog] = useState(null)
  const [demangle, setDemangle] = useState(false)
  const [demangled, setDemangled] = useState(null) // { model, names: (string|null)[] }

  // A new file starts from a clean view
  const [seenModel, setSeenModel] = useState(model)
  if (seenModel !== model) {
    setSeenModel(model)
    setSelected(null)
    setTag(null)
  }

  useEffect(() => {
    const id = setTimeout(() => setQuery(input), FILTER_DELAY)
    return () => clearTimeout(id)
  }, [input])

  useEffect(() => {
    let live = true
    loadCatalog().then(module => { if (live) setCatalog(module) }, () => {})
    return () => { live = false }
  }, [])

  // Demangling runs in slices so a large table never blocks the page
  useEffect(() => {
    if (!demangle || (demangled && demangled.model === model)) return undefined
    let cancelled = false
    let timer = 0
    loadDemangler().then(({ demangle: demangleName }) => {
      const names = new Array(model.count).fill(null)
      let i = 0
      const step = () => {
        if (cancelled) return
        const until = performance.now() + 12
        while (i < model.count && performance.now() < until) {
          const stop = Math.min(model.count, i + 256)
          for (; i < stop; i++) names[i] = demangleName(model.symbols[i].name)
        }
        if (i < model.count) timer = setTimeout(step, 0)
        else setDemangled({ model, names })
      }
      step()
    }, () => {})
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [demangle, demangled, model])

  const names = demangle && demangled && demangled.model === model ? demangled.names : null
  const nameOf = useCallback(index => (names && names[index]) || model.symbols[index].name, [names, model])
  const tags = useMemo(() => {
    if (!catalog) return null
    return model.symbols.map(s => {
      const entry = catalog.lookupApi(s.name)
      return entry ? entry.tag : null
    })
  }, [catalog, model])
  const tagOf = useCallback(index => (tags ? tags[index] : null), [tags])
  const capabilities = useMemo(() => (tags ? capabilitySummary(model, tagOf) : []), [tags, model, tagOf])

  const rows = useMemo(() => filterRows(model, {
    query,
    quick,
    sortKey: sort.key,
    descending: sort.descending,
    tag,
    tagOf,
    alias: names ? i => names[i] : null
  }), [model, query, quick, sort, tag, tagOf, names])

  const jump = useCallback((index) => {
    const symbol = model.symbols[index]
    if (symbol && symbol.offset !== undefined && jumpRef.current) jumpRef.current(symbol.offset, Math.max(1, symbol.size || 1))
  }, [model])
  const activate = useCallback((index) => {
    setSelected(index)
    setCopied(false)
    jump(index)
  }, [jump])
  const select = useCallback((index) => {
    setSelected(index)
    setCopied(false)
  }, [])
  const copy = useCallback((index) => {
    copyText(model.symbols[index].name).then(ok => setCopied(ok))
  }, [model])
  const onSort = useCallback(key => setSort(s => ({ key, descending: s.key === key ? !s.descending : false })), [])

  if (!analysis) return null
  const symbol = selected !== null ? model.symbols[selected] : null
  const filtering = input !== query
  const importCount = model.counts.import

  return (
    <section className="hd-panel symbols-panel">
      <SelectionBridge apiRef={jumpRef} />
      <div className="hd-panel-header">
        <h2 className="hd-panel-title">
          {TITLES[analysis.formatId] || 'Symbols'} <span className="hd-muted symbols-count">{model.count.toLocaleString()}</span>
        </h2>
      </div>

      {capabilities.length > 0 && (
        <div className="symbols-uses">
          <span className="hd-muted">Imports use: </span>
          {capabilities.map(([name, n]) => (
            <button
              key={name}
              type="button"
              className={`symbols-chip${tag === name ? ' is-active' : ''}`}
              aria-pressed={tag === name}
              title={`Show the ${n} imports tagged ${name}`}
              onClick={() => setTag(t => (t === name ? null : name))}
            >
              {name} <span className="symbols-chip-count">{n}</span>
            </button>
          ))}
        </div>
      )}

      <div className="symbols-controls">
        <input
          type="search"
          className="hd-input symbols-filter"
          placeholder="Filter by name"
          aria-label="Filter symbols by name"
          value={input}
          onChange={event => setInput(event.target.value)}
        />
        <span className="hd-muted symbols-matches" role="status" aria-live="polite">
          {filtering ? 'Filtering…' : `${rows.length.toLocaleString()} ${rows.length === 1 ? 'match' : 'matches'}`}
        </span>
      </div>
      <div className="hd-row symbols-quick" role="group" aria-label="Show">
        {QUICK_FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`hd-button hd-button--small${quick === key ? ' hd-button--active' : ''}`}
            aria-pressed={quick === key}
            onClick={() => setQuick(key)}
          >
            {label} <span className="symbols-quick-count">{(key === 'all' ? model.count : model.counts[key]).toLocaleString()}</span>
          </button>
        ))}
        <label className="symbols-toggle">
          <input type="checkbox" checked={demangle} onChange={event => setDemangle(event.target.checked)} />
          Demangle
          {demangle && !names && <span className="hd-muted"> (working…)</span>}
        </label>
      </div>

      <SymbolTable
        rows={rows}
        symbols={model.symbols}
        selected={selected}
        onSelect={select}
        onActivate={activate}
        onCopy={copy}
        nameOf={nameOf}
        tagOf={tagOf}
        sortKey={sort.key}
        descending={sort.descending}
        onSort={onSort}
        label={`${TITLES[analysis.formatId] || 'Symbols'}: use the arrow keys to move, Enter to show the bytes`}
      />

      <Details
        symbol={symbol}
        demangled={symbol && names ? names[selected] : null}
        api={symbol && catalog ? catalog.lookupApi(symbol.name) : null}
        formatId={analysis.formatId}
        onJump={() => jump(selected)}
        onCopy={() => copy(selected)}
        copied={copied}
      />

      <details className="symbols-legend">
        <summary>Type letters</summary>
        <p className="hd-muted">Letters follow nm. Upper case is global (visible to other files), lower case is local.</p>
        <dl className="symbols-legend-list">
          {TYPE_LETTERS.map(([letter, meaning]) => (
            <div key={letter}><dt className="symbols-letter">{letter}</dt><dd>{meaning}</dd></div>
          ))}
        </dl>
        {importCount > 0 && <p className="hd-muted">Imports (U) show the library that provides them when the file records it.</p>}
        {analysis.formatId === 'pe' && <p className="hd-muted">PE addresses are RVAs: offsets from the image base once loaded.</p>}
      </details>
    </section>
  )
}

export default Symbols
