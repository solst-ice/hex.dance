/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useEffect, useRef, useState } from 'react'
import { useFile, useSelection } from '../../state/hooks.js'
import { formatBytes } from '../../formats/shared.js'
import { ALGORITHMS } from './digests.js'
import { startHashing } from './hashJob.js'
import CopyButton from './CopyButton.jsx'
import './hashes.css'

// Whole-file results per loaded buffer, so switching tabs does not rehash
/** @type {WeakMap<ArrayBuffer, { hashes: Record<string, string>, revision: number, ms: number, size: number }>} */
const fileCache = new WeakMap()

const hexOffset = (n) => '0x' + n.toString(16).toUpperCase()

function formatDuration(ms) {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`
}

function normalizeHash(text) {
  return text.trim().toLowerCase().replace(/^0x/, '').replace(/[\s:-]/g, '')
}

function hashListText(hashes) {
  return ALGORITHMS.map(({ id, name }) => `${name.padEnd(8)} ${hashes[id]}`).join('\n')
}

function HashTable({ hashes, scope }) {
  return (
    <table className="hd-table hashes-table">
      <tbody>
        {ALGORITHMS.map(({ id, name }) => (
          <tr key={id} data-algorithm={id}>
            <th scope="row" className="hashes-name">{name}</th>
            <td className="hashes-value hd-mono">{hashes[id]}</td>
            <td className="hashes-copy">
              <CopyButton text={hashes[id]} ariaLabel={`Copy ${name} of ${scope}`} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Progress({ fraction, label }) {
  const percent = Math.round(fraction * 100)
  return (
    <div className="hashes-progress hd-row">
      <progress max={100} value={percent} aria-label={label} />
      <span className="hd-muted">{label} {percent}%</span>
    </div>
  )
}

function useLatest(value) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

function WholeFile({ buffer, bytes, revision, onHashes }) {
  const revisionRef = useLatest(revision)
  const [run, setRun] = useState(null)
  const [token, setToken] = useState(0)

  useEffect(() => {
    if (!bytes) return undefined
    if (token === 0 && fileCache.has(buffer)) return undefined
    const startRevision = revisionRef.current
    const started = performance.now()
    let lastPaint = 0
    setRun({ buffer, fraction: 0, error: null })
    const job = startHashing({
      bytes,
      start: 0,
      end: bytes.length,
      onProgress(fraction) {
        const now = performance.now()
        if (now - lastPaint < 100) return
        lastPaint = now
        setRun(previous => (previous && previous.buffer === buffer ? { ...previous, fraction } : previous))
      },
      onDone(hashes) {
        fileCache.set(buffer, { hashes, revision: startRevision, ms: performance.now() - started, size: bytes.length })
        setRun(null)
      },
      onError(error) {
        setRun({ buffer, fraction: 0, error })
      }
    })
    return () => job.cancel()
  }, [buffer, bytes, token, revisionRef])

  const result = fileCache.get(buffer) || null
  const current = run && run.buffer === buffer ? run : null
  const stale = result && result.revision !== revision
  useEffect(() => onHashes(result ? result.hashes : null), [result, onHashes])

  return (
    <div className="hd-stack hashes-file">
      <div className="hd-row hashes-heading">
        <h3 className="hd-section-title">Whole file</h3>
        <span className="hd-muted">{formatBytes(bytes.length)}</span>
        {result && !current && (
          <span className="hd-muted hashes-time">in {formatDuration(result.ms)}</span>
        )}
      </div>
      {current && !current.error && <Progress fraction={current.fraction} label="Hashing" />}
      {current?.error && (
        <p className="hd-warning" role="alert">Hashing failed: {current.error.message}</p>
      )}
      {stale && !current && (
        <div className="hd-row hashes-stale" role="status">
          <span className="hd-badge hd-badge--yellow">Stale</span>
          <span>The bytes were edited after these hashes were computed.</span>
          <button type="button" className="hd-button hd-button--small" onClick={() => setToken(t => t + 1)}>
            Recompute
          </button>
        </div>
      )}
      {result && (
        <div className={stale || current ? 'hashes-dim' : ''}>
          <HashTable hashes={result.hashes} scope="the whole file" />
        </div>
      )}
      {result && !current && (
        <div className="hd-row">
          <CopyButton getText={() => hashListText(result.hashes)} label="Copy all" ariaLabel="Copy all whole-file hashes" />
          {!stale && (
            <button type="button" className="hd-button hd-button--small" onClick={() => setToken(t => t + 1)}>
              Recompute
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function SelectionHashes({ buffer, bytes, revision, onHashes }) {
  const { selection } = useSelection()
  const revisionRef = useLatest(revision)
  const [state, setState] = useState(null)
  const jobRef = useRef(null)

  useEffect(() => () => jobRef.current?.cancel(), [buffer])

  const mine = state && state.buffer === buffer ? state : null
  useEffect(() => onHashes(mine?.hashes || null), [mine, onHashes])

  const hasSelection = Boolean(selection && selection.end > selection.start)
  const size = hasSelection ? selection.end - selection.start : 0

  const start = () => {
    if (!hasSelection) return
    jobRef.current?.cancel()
    const range = { start: selection.start, end: Math.min(selection.end, bytes.length) }
    const base = { buffer, ...range, revision: revisionRef.current, fraction: 0 }
    setState(base)
    jobRef.current = startHashing({
      bytes,
      ...range,
      onProgress: (fraction) => setState(previous => (previous?.buffer === buffer && previous.start === range.start && !previous.hashes ? { ...previous, fraction } : previous)),
      onDone: (hashes) => setState({ ...base, fraction: 1, hashes }),
      onError: (error) => setState({ ...base, error })
    })
  }

  const differs = mine && hasSelection && (selection.start !== mine.start || selection.end !== mine.end)
  const stale = mine?.hashes && mine.revision !== revision

  return (
    <div className="hd-stack hashes-selection">
      <div className="hd-row hashes-heading">
        <h3 className="hd-section-title">Selection</h3>
        <button type="button" className="hd-button hd-button--small" disabled={!hasSelection} onClick={start}>
          {hasSelection ? `Hash selection (${formatBytes(size)})` : 'Hash selection'}
        </button>
      </div>
      {!hasSelection && !mine && <p className="hd-muted hashes-note">Select bytes in the hex view to hash just that range.</p>}
      {mine && (
        <p className="hd-muted hashes-note">
          {hexOffset(mine.start)} to {hexOffset(mine.end - 1)}, {(mine.end - mine.start).toLocaleString()} bytes
          {differs ? ' (the selection has changed since)' : ''}
        </p>
      )}
      {mine && !mine.hashes && !mine.error && <Progress fraction={mine.fraction} label="Hashing selection" />}
      {mine?.error && <p className="hd-warning" role="alert">Hashing failed: {mine.error.message}</p>}
      {stale && (
        <div className="hd-row hashes-stale" role="status">
          <span className="hd-badge hd-badge--yellow">Stale</span>
          <span>The bytes were edited after this was computed.</span>
        </div>
      )}
      {mine?.hashes && (
        <div className={stale ? 'hashes-dim' : ''}>
          <HashTable hashes={mine.hashes} scope="the selection" />
        </div>
      )}
    </div>
  )
}

const MemoSelectionHashes = memo(SelectionHashes)

function Compare({ fileHashes, selectionHashes }) {
  const [text, setText] = useState('')
  const wanted = normalizeHash(text)
  let message = null
  if (wanted) {
    if (!/^[0-9a-f]+$/.test(wanted)) {
      message = <span className="hd-warning">That does not look like a hex hash.</span>
    } else {
      const matches = []
      for (const [scope, hashes] of [['whole file', fileHashes], ['selection', selectionHashes]]) {
        if (!hashes) continue
        for (const { id, name } of ALGORITHMS) if (hashes[id] === wanted) matches.push(`${name} of the ${scope}`)
      }
      message = matches.length
        ? <span className="hashes-match">Matches {matches.join(' and ')}.</span>
        : <span className="hd-warning">No match among the hashes shown.</span>
    }
  }
  return (
    <div className="hd-stack hashes-compare">
      <label className="hd-section-title" htmlFor="hashes-compare-input">Compare</label>
      <input
        id="hashes-compare-input"
        className="hd-input hd-mono"
        type="text"
        spellCheck={false}
        autoComplete="off"
        placeholder="Paste a hash to check it"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <p className="hashes-note" aria-live="polite">{message}</p>
    </div>
  )
}

function Hashes() {
  const { buffer, bytes, revision } = useFile()
  const [fileHashes, setFileHashes] = useState(null)
  const [selectionHashes, setSelectionHashes] = useState(null)

  if (!bytes) return <section className="hd-panel"><p className="hd-empty">Reading file…</p></section>

  return (
    <section className="hd-panel hashes-panel" aria-label="Hashes">
      <div className="hd-panel-header">
        <h2 className="hd-panel-title">Hashes</h2>
      </div>
      <p className="hd-muted hashes-note">Computed in your browser. Nothing is looked up or sent anywhere.</p>
      <WholeFile buffer={buffer} bytes={bytes} revision={revision} onHashes={setFileHashes} />
      <MemoSelectionHashes buffer={buffer} bytes={bytes} revision={revision} onHashes={setSelectionHashes} />
      <Compare fileHashes={fileHashes} selectionHashes={selectionHashes} />
    </section>
  )
}

export default Hashes
