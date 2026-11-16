/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useState } from 'react'
import { useFile } from '../../state/hooks.js'
import { describeSymbol } from './descriptions.js'
import './symbols.css'

// Rendering thousands of rows at once freezes the page, so long lists are
// revealed in pages of this size.
const ROWS_PER_PAGE = 2000

const TITLES = { macho: 'Mach-O Symbols', pe: 'PE Exports', elf: 'ELF Symbols' }

function symbolKey(symbol) {
  return `${symbol.name}\0${symbol.type}\0${symbol.address || ''}\0${symbol.note || ''}`
}

// PE export addresses are RVAs; other formats give virtual addresses
function locationText(symbol, formatId) {
  const address = symbol.address ? `${formatId === 'pe' ? 'RVA' : '@'} ${symbol.address}` : ''
  return [address, symbol.note].filter(Boolean).join(formatId === 'pe' ? ', ' : ' ')
}

function SymbolRow({ symbol, formatId, open, onToggle }) {
  const location = locationText(symbol, formatId)
  return (
    <div className="function-item">
      <li onClick={onToggle} className={open ? 'selected' : ''} aria-expanded={open}>
        {symbol.name} <span className="symbol-type" title="nm symbol type">({symbol.type})</span>
        {location ? ` ${location}` : ''}
      </li>
      <div className={`function-description inline ${open ? 'show' : ''}`}>
        {open && (describeSymbol(symbol.name) || 'No description available for this function.')}
      </div>
    </div>
  )
}

function Symbols() {
  const { analysis } = useFile()
  // Per-list view state, reset whenever a new analysis arrives
  const [view, setView] = useState({ analysis: null, selected: null, expandAll: false, count: ROWS_PER_PAGE })
  if (!analysis) return null

  const state = view.analysis === analysis ? view : { analysis, selected: null, expandAll: false, count: ROWS_PER_PAGE }
  const { symbols, formatId } = analysis
  const hiddenCount = Math.max(0, symbols.length - state.count)

  return (
    <section className="hd-panel symbols-panel">
      <div className="hd-panel-header">
        <h2 className="hd-panel-title">
          {TITLES[formatId] || 'Symbols'} <span className="hd-muted symbols-count">{symbols.length.toLocaleString()}</span>
        </h2>
        <button className="hd-button" onClick={() => setView({ ...state, expandAll: !state.expandAll })}>
          {state.expandAll ? 'Collapse All' : 'Expand All'}
        </button>
      </div>
      <ul className="symbols-list">
        {symbols.slice(0, state.count).map(symbol => {
          const key = symbolKey(symbol)
          return (
            <SymbolRow
              key={key}
              symbol={symbol}
              formatId={formatId}
              open={state.expandAll || state.selected === key}
              onToggle={() => setView({ ...state, selected: state.selected === key ? null : key })}
            />
          )
        })}
      </ul>
      {hiddenCount > 0 && (
        <div className="hd-row symbols-more">
          <span className="hd-muted">
            Showing {state.count.toLocaleString()} of {symbols.length.toLocaleString()} rows
          </span>
          <button className="hd-button" onClick={() => setView({ ...state, count: state.count + ROWS_PER_PAGE })}>
            Show {Math.min(hiddenCount, ROWS_PER_PAGE).toLocaleString()} more
          </button>
        </div>
      )}
    </section>
  )
}

export default Symbols
