/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { useFile, useHighlightLayer, useSelectionActions } from '../../state/index.js'
import { useCarveScan } from './useCarveScan.js'
import { buildReport, extractName, rangeEnd } from './report.js'
import { extractedFile, originOf } from './extract.js'
import { downloadBytes } from '../../lib/download.js'
import { LIMITS } from './scan.js'
import HitList from './HitList.jsx'
import HitDetails from './HitDetails.jsx'
import { hex, sizeText } from './labels.js'
import './carve.css'

const MAX_TINTED = 1000

function duration(ms) {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`
}

// Gives the panel jumpTo without re-rendering it on every selection change
function JumpBridge({ jumpRef }) {
  const { jumpTo } = useSelectionActions()
  jumpRef.current = jumpTo
  return null
}

const Tint = memo(function Tint({ ranges }) {
  useHighlightLayer('carve', ranges)
  return null
})

function Findings({ findings, onJump }) {
  if (!findings.length) return null
  return (
    <ul className="carve-findings" aria-label="Findings">
      {findings.map((f, i) => (
        <li key={i} className={`carve-finding carve-finding--${f.severity || 'notice'}`}>
          <div className="carve-finding-title">{f.title}</div>
          <div className="carve-finding-why">{f.why}</div>
          {f.end > f.start && (
            <button type="button" className="hd-button hd-button--small" onClick={() => onJump(f.start, f.end)}>
              Select {hex(f.start)}–{hex(f.end - 1)}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function ScanDetails({ scan, size }) {
  const rows = Object.entries(scan.stats || {}).filter(([, s]) => s.candidates > 0).sort((a, b) => b[1].candidates - a[1].candidates)
  const total = rows.reduce((n, [, s]) => n + s.candidates, 0)
  return (
    <details className="carve-scan-details">
      <summary>How the scan works</summary>
      <p>
        Every offset is matched against {'≈'}50 signatures; each match is then checked by reading the structure it announces
        (checksums, size fields, chunk lists) and, where the app has a parser for the format, by that parser.
        Two- and three-byte signatures (MZ, BM, gzip, zlib, JPEG, 55 AA boot sectors) only count when that check passes,
        because they turn up by chance thousands of times in 100 MB of random data.
      </p>
      <p className="hd-muted">
        Limits: at most {LIMITS.maxHits.toLocaleString()} hits; {LIMITS.confirmMs / 1000} s per candidate; {LIMITS.familyMs / 1000} s
        per signature family; parsers only run on hits up to {sizeText(LIMITS.parseWindow)}.
      </p>
      {rows.length > 0 && (
        <table className="hd-table carve-stats">
          <caption className="hd-muted">{total.toLocaleString()} candidates in {sizeText(size)}</caption>
          <thead>
            <tr><th scope="col">Signature</th><th scope="col" className="hd-num">Matches</th><th scope="col" className="hd-num">Confirmed</th><th scope="col" className="hd-num">Not checked</th></tr>
          </thead>
          <tbody>
            {rows.map(([id, s]) => (
              <tr key={id}>
                <td>{id}</td>
                <td className="hd-num">{s.candidates.toLocaleString()}</td>
                <td className="hd-num">{s.confirmed.toLocaleString()}</td>
                <td className="hd-num">{s.unchecked ? s.unchecked.toLocaleString() : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  )
}

function Carve() {
  const { file, buffer, bytes, revision, analysis, openFile } = useFile()
  const [token, setToken] = useState(0)
  const [typeFilter, setTypeFilter] = useState('')
  const [showInternal, setShowInternal] = useState(false)
  const [active, setActive] = useState({ buffer: null, id: -1 })
  const jumpRef = useRef(null)
  const scan = useCarveScan({ buffer, bytes, revision, token })
  const size = bytes ? bytes.length : 0

  const report = useMemo(
    () => (scan ? buildReport(scan.hits, { size: scan.size, lastNonZero: scan.lastNonZero, formatId: analysis?.formatId }) : null),
    [scan, analysis?.formatId]
  )

  const types = useMemo(() => {
    const counts = new Map()
    for (const h of report?.hits || []) {
      if (h.role === 'internal' && !showInternal) continue
      const entry = counts.get(h.type) || { name: h.name, count: 0 }
      entry.count++
      counts.set(h.type, entry)
    }
    return [...counts.entries()].sort((a, b) => b[1].count - a[1].count)
  }, [report, showInternal])

  const visible = useMemo(() => (report?.hits || []).filter(h =>
    (showInternal || h.role !== 'internal') && (!typeFilter || h.type === typeFilter)
  ), [report, showInternal, typeFilter])

  const activeHit = active.buffer === buffer ? visible.find(h => h.id === active.id) || null : null

  const ranges = useMemo(() => {
    if (!report) return null
    const out = []
    for (const h of visible) {
      if (h.role === 'main' || out.length >= MAX_TINTED) continue
      out.push({
        id: h.id,
        start: h.start,
        end: rangeEnd(h, report.hits, size, 'next'),
        label: h.name,
        color: h.id === activeHit?.id ? 'var(--carve-tint-active)' : h.confidence === 'low' ? 'var(--carve-tint-weak)' : 'var(--carve-tint)'
      })
    }
    return out
  }, [report, visible, size, activeHit?.id])

  const jump = useCallback((start, end) => jumpRef.current?.(start, Math.max(1, end - start)), [])

  // A click or Enter also selects the bytes; arrow keys only move through the list
  const pick = useCallback((id, { keyboard = false } = {}) => {
    setActive({ buffer, id })
    if (!keyboard && report) {
      const hit = report.hits.find(h => h.id === id)
      if (hit) jump(hit.start, rangeEnd(hit, report.hits, size, 'next'))
    }
  }, [buffer, report, size, jump])

  const extract = useCallback((hit, end) => {
    downloadBytes(bytes.subarray(hit.start, end), extractName(file?.name, hit))
  }, [bytes, file])

  const open = useCallback((hit, end) => {
    const name = extractName(file?.name, hit)
    openFile(extractedFile(bytes.subarray(hit.start, end), name, { parent: file?.name || 'file', offset: hit.start, type: hit.name }))
  }, [bytes, file, openFile])

  if (!bytes) return <section className="hd-panel"><p className="hd-empty">Reading file…</p></section>

  const origin = originOf(file)
  const scanning = scan?.status === 'scanning'
  const stale = scan && scan.status === 'done' && scan.revision !== revision
  const fraction = scan && scan.size ? scan.position / scan.size : 1
  const digits = Math.max(4, size > 0 ? (size - 1).toString(16).length : 1)
  const found = report ? report.hits.length : 0

  return (
    <section
      className="hd-panel carve-panel"
      aria-label="Embedded files"
      data-status={scan?.status || 'idle'}
      data-count={found}
      data-done-ms={scan?.doneAt ? Math.round(scan.doneAt - scan.startedAt) : ''}
    >
      <JumpBridge jumpRef={jumpRef} />
      <Tint ranges={ranges} />
      <div className="hd-panel-header">
        <h2 className="hd-panel-title">Embedded</h2>
        {scan && !scanning && (
          <button type="button" className="hd-button hd-button--small" onClick={() => setToken(t => t + 1)}>Rescan</button>
        )}
      </div>

      {origin && (
        <p className="hd-muted carve-origin">Extracted from {origin.parent} at {hex(origin.offset)} ({origin.type}).</p>
      )}

      <div className="carve-status" aria-live="polite">
        {scanning && (
          <div className="hd-row">
            <progress max={100} value={Math.round(fraction * 100)} aria-label="Scanning for embedded files" />
            <span className="hd-muted">Scanning {Math.round(fraction * 100)}%, {found.toLocaleString()} found</span>
          </div>
        )}
        {scan?.status === 'done' && (
          <span className="hd-muted">Scanned {sizeText(size)} in {duration(scan.doneAt - scan.startedAt)}.</span>
        )}
        {scan?.status === 'error' && <p className="hd-warning" role="alert">The scan failed: {scan.error.message}</p>}
      </div>

      {stale && (
        <div className="hd-row carve-notice carve-stale" role="status">
          <span className="hd-badge hd-badge--yellow">File changed</span>
          <span>The bytes were edited after this scan.</span>
          <button type="button" className="hd-button hd-button--small" onClick={() => setToken(t => t + 1)}>Rescan</button>
        </div>
      )}
      {scan?.capped && (
        <p className="carve-notice hd-warning" role="status">
          Stopped after {LIMITS.maxHits.toLocaleString()} hits{scan.stoppedAt >= 0 ? `, at ${hex(scan.stoppedAt)}` : ''}; the rest of the file was not scanned.
        </p>
      )}

      {report && (scan.status !== 'scanning' || found > 0) && (
        <p className="carve-summary">{scan.status === 'scanning' ? 'So far: ' : ''}{report.summary}</p>
      )}

      {report && scan.status === 'done' && <Findings findings={report.findings} onJump={jump} />}

      {report && found > 0 && (
        <div className="hd-row carve-controls">
          <select
            className="hd-input"
            aria-label="Filter by type"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
          >
            <option value="">All types ({types.reduce((n, [, t]) => n + t.count, 0)})</option>
            {types.map(([type, t]) => <option key={type} value={type}>{t.name} ({t.count})</option>)}
          </select>
          {report.internal > 0 && (
            <label className="carve-check">
              <input type="checkbox" checked={showInternal} onChange={(event) => setShowInternal(event.target.checked)} />
              {' '}Show {report.internal.toLocaleString()} {report.internal === 1 ? 'part' : 'parts'} of other files
            </label>
          )}
        </div>
      )}

      {visible.length > 0 && (
        <HitList hits={visible} activeId={activeHit ? activeHit.id : -1} onPick={pick} digits={digits} resetKey={`${typeFilter}|${showInternal}|${scan?.startedAt}`} />
      )}
      {report && found > 0 && visible.length === 0 && <p className="hd-empty">No hits of this type.</p>}

      {activeHit && (
        <HitDetails hit={activeHit} hits={report.hits} size={size} onJump={jump} onExtract={extract} onOpen={open} />
      )}
      {!activeHit && visible.length > 0 && <p className="hd-muted carve-hint">Choose a row to select it in the hex view, extract it or open it.</p>}

      {scan?.status === 'done' && <ScanDetails scan={scan} size={size} />}
    </section>
  )
}

export default Carve
