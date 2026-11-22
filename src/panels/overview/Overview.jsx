/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useMemo, useState } from 'react'
import { useFile, useSelectionActions } from '../../state/hooks.js'
import { formatOffset } from '../../lib/format.js'
import { unusualNotes } from './unusual.js'
import { formatBytes, hexBytes } from '../../formats/shared.js'
import { visibleText } from '../../lib/visibleText.js'
import './overview.css'

function leadingBytes(bytes) {
  if (!bytes) return '…'
  if (bytes.length === 0) return 'None (empty file)'
  return `0x${hexBytes(bytes, 0, 4)}`
}

function typeName(file, analysis, status) {
  if (!analysis) return status === 'error' ? file.type || 'Unknown Format' : '…'
  if (analysis.formatId === 'unknown') return file.type || 'Unknown Format'
  return analysis.formatName
}

// Plain facts become cards; items with details or a group become expandable rows
function splitSummary(summary) {
  const cards = []
  const rows = []
  const groups = new Map()
  for (const entry of summary) {
    if (entry.group) {
      if (!groups.has(entry.group)) groups.set(entry.group, [])
      groups.get(entry.group).push(entry)
    } else if (entry.details && entry.details.length) {
      rows.push(entry)
    } else {
      cards.push(entry)
    }
  }
  return { cards, rows, groups: [...groups] }
}

function Card({ label, value }) {
  return (
    <div className="metadata-item">
      <span className="metadata-label">{label}</span>
      <span className="metadata-value">{value}</span>
    </div>
  )
}

function DetailRow({ entry, open, onToggle }) {
  const expandable = Boolean(entry.details && entry.details.length)
  return (
    <div className="function-item">
      <li
        className={open && expandable ? 'selected' : ''}
        onClick={expandable ? onToggle : undefined}
        aria-expanded={expandable ? open : undefined}
      >
        <span className="overview-row-label">{entry.label}:</span> {entry.value}
      </li>
      {expandable && (
        <div className={`function-description inline ${open ? 'show' : ''}`}>
          {entry.details.map((line, index) => <div key={index}>{line}</div>)}
        </div>
      )}
    </div>
  )
}

// Observations from the parser, not problems: the same notes the poster shows
function Unusual({ notes, size }) {
  const { jumpTo } = useSelectionActions()
  return (
    <section className="hd-panel overview-unusual">
      <h4 className="hd-section-title">What&apos;s unusual</h4>
      <ul>
        {notes.map((note, index) => (
          <li key={index}>
            <span className="overview-unusual-text">{visibleText(note.text)}</span>
            {note.offset !== null && note.offset < size && (
              <button
                type="button"
                className="hd-button hd-button--small overview-unusual-jump"
                aria-label={`Show ${formatOffset(note.offset)} in the hex view`}
                onClick={() => jumpTo(note.offset, Math.min(note.length, size - note.offset))}
              >
                Show in hex view <span className="overview-unusual-offset">{formatOffset(note.offset)}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Overview() {
  const { file, bytes, analysis, status, error } = useFile()
  const [opened, setOpened] = useState({ analysis: null, keys: new Set(), all: false })
  const { cards, rows, groups } = useMemo(() => splitSummary(analysis ? analysis.summary : []), [analysis])
  const unusual = useMemo(() => unusualNotes(analysis), [analysis])

  if (!file) return null

  // Expansion state belongs to one analysis; a new file starts collapsed
  const state = opened.analysis === analysis ? opened : { analysis, keys: new Set(), all: false }
  const isOpen = key => state.all || state.keys.has(key)
  const toggle = key => {
    const keys = new Set(state.keys)
    if (keys.has(key)) keys.delete(key)
    else keys.add(key)
    setOpened({ ...state, keys })
  }
  const hasDetails = rows.length > 0 || groups.some(([, entries]) => entries.some(entry => entry.details))
  const warnings = analysis ? analysis.warnings : []

  return (
    <div className="hd-stack overview">
      <section className="hd-panel">
        <h3 className="hd-panel-title overview-title">File Information</h3>
        <div className="metadata-grid">
          <Card label="File Name" value={visibleText(file.name)} />
          <Card label="File Size" value={formatBytes(file.size)} />
          <Card label="File Type" value={typeName(file, analysis, status)} />
          {file.type && analysis && analysis.formatId !== 'unknown' && <Card label="MIME Type" value={file.type} />}
          <Card label="Leading Bytes" value={leadingBytes(bytes)} />
          <Card label="Last Modified" value={new Date(file.lastModified).toLocaleString()} />
        </div>
      </section>

      {(status === 'reading' || status === 'analyzing') && (
        <p className="hd-empty" role="status">Analyzing…</p>
      )}

      {error && (
        <p className="hd-warning overview-note" role="alert">Error analyzing file: {error.message || String(error)}</p>
      )}

      {analysis && analysis.formatId === 'unknown' && !analysis.gaveUp && (
        <p className="hd-warning overview-note">Note: This file format is not specifically supported. Showing basic information.</p>
      )}

      {analysis && analysis.gaveUp && (
        <p className="hd-warning overview-note" role="status">
          Note: The analysis did not finish, so the format was not identified. Showing basic information.
        </p>
      )}

      {warnings.length > 0 && (
        <section className="hd-panel overview-warnings">
          <h4 className="hd-section-title">Warnings</h4>
          <ul>
            {warnings.map((warning, index) => <li key={index} className="hd-warning">{warning}</li>)}
          </ul>
        </section>
      )}

      {analysis && analysis.summary.length > 0 && (
        <section className="hd-panel">
          <div className="hd-panel-header">
            <h3 className="hd-panel-title">{analysis.formatId === 'unknown' ? 'Metadata' : analysis.formatName}</h3>
            {hasDetails && (
              <button className="hd-button" onClick={() => setOpened({ ...state, all: !state.all })}>
                {state.all ? 'Collapse All' : 'Expand All'}
              </button>
            )}
          </div>
          {cards.length > 0 && (
            <div className="metadata-grid">
              {cards.map((entry, index) => <Card key={index} label={entry.label} value={entry.value} />)}
            </div>
          )}
          {rows.length > 0 && (
            <ul className="overview-rows">
              {rows.map((entry, index) => (
                <DetailRow key={index} entry={entry} open={isOpen(`row:${index}`)} onToggle={() => toggle(`row:${index}`)} />
              ))}
            </ul>
          )}
          {groups.map(([group, entries]) => (
            <div key={group}>
              <h4 className="hd-section-title">{group}</h4>
              <ul className="overview-rows">
                {entries.map((entry, index) => (
                  <DetailRow
                    key={index}
                    entry={entry}
                    open={isOpen(`${group}:${index}`)}
                    onToggle={() => toggle(`${group}:${index}`)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {unusual.length > 0 && <Unusual notes={unusual} size={bytes ? bytes.length : file.size} />}
    </div>
  )
}

export default Overview
