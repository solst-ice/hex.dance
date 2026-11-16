/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFile, useHexViewport, useSelection } from '../../state/hooks.js'
import { formatBytes } from '../../formats/shared.js'
import { describeByte } from '../../components/hex/bytes.js'
import { streamToWorker } from '../hashes/chunkStream.js'
import { chooseBlockSize, describe, summarize } from './stats.js'
import EntropyGraph from './EntropyGraph.jsx'
import Histogram from './Histogram.jsx'
import './entropy.css'

// Finished results per loaded buffer, so switching tabs does not recompute
const resultCache = new WeakMap()

function useByteStats({ buffer, bytes, revision, token }) {
  const revisionRef = useRef(revision)
  revisionRef.current = revision
  const [result, setResult] = useState(null)

  useEffect(() => {
    if (!bytes) return undefined
    const cached = resultCache.get(buffer)
    if (token === 0 && cached) {
      setResult(cached)
      return undefined
    }
    const size = bytes.length
    const blockSize = chooseBlockSize(size)
    const points = Math.ceil(size / blockSize)
    const state = {
      buffer,
      revision: revisionRef.current,
      size,
      blockSize,
      points,
      entropy: new Float32Array(points),
      zeros: new Uint8Array(points),
      filled: 0,
      histogram: null,
      status: 'running',
      error: null
    }
    setResult({ ...state })
    let frame = 0
    const publish = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setResult({ ...state }))
    }
    const job = streamToWorker({
      createWorker: () => new Worker(new URL('./entropy.worker.js', import.meta.url), { type: 'module' }),
      bytes,
      params: { size, blockSize },
      firstChunkSize: 1 << 20,
      chunkSize: 4 << 20,
      onMessage(message) {
        state.entropy.set(message.entropy, message.from)
        state.zeros.set(message.zeros, message.from)
        state.filled = message.from + message.entropy.length
        if (message.type === 'done') {
          state.filled = points
          state.histogram = message.histogram
          state.status = 'done'
          resultCache.set(buffer, { ...state })
          cancelAnimationFrame(frame)
          setResult({ ...state })
        } else {
          publish()
        }
      },
      onError(error) {
        cancelAnimationFrame(frame)
        setResult({ ...state, status: 'error', error })
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      job.cancel()
    }
  }, [buffer, bytes, token])

  return result && result.buffer === buffer ? result : null
}

// Re-renders with the selection without re-rendering the rest of the panel
function GraphWithSelection(props) {
  const { selection, jumpTo } = useSelection()
  const viewport = useHexViewport()
  return <EntropyGraph {...props} selection={selection} viewport={viewport} onJump={jumpTo} />
}

const percent = (share) => {
  const value = share * 100
  return `${value > 0 && value < 0.1 ? value.toFixed(3) : value.toFixed(1)}%`
}

function ByteChips({ bytes, histogram, total }) {
  return (
    <span className="entropy-chips">
      {bytes.map(b => (
        <span key={b} className="hd-badge entropy-chip" title={describeByte(b).char}>
          {b.toString(16).toUpperCase().padStart(2, '0')} <span className="hd-muted">{percent(histogram[b] / total)}</span>
        </span>
      ))}
    </span>
  )
}

function Summary({ result, summary }) {
  const reading = describe(result, summary)
  return (
    <div className="hd-stack entropy-summary">
      <div className="entropy-reading">
        <p className="entropy-overall">
          <span className="entropy-overall-value">{summary.entropy.toFixed(3)}</span> bits per byte overall (8 is random)
        </p>
        <ul>
          {reading.map(sentence => <li key={sentence}>{sentence}</li>)}
        </ul>
      </div>
      <dl className="hd-kv entropy-kv">
        <dt>Zero bytes</dt>
        <dd>{percent(summary.zeroShare)}</dd>
        <dt>Printable</dt>
        <dd>{percent(summary.printableShare)} <span className="hd-muted">(ASCII text, tab, CR, LF)</span></dd>
        <dt>High bytes</dt>
        <dd>{percent(summary.highShare)} <span className="hd-muted">(0x80 and above)</span></dd>
        <dt>Distinct</dt>
        <dd>
          {summary.distinct} of 256 values
          {summary.missing.length > 0 && summary.missing.length <= 16 && (
            <span className="hd-muted"> (never: {summary.missing.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')})</span>
          )}
        </dd>
        {summary.mostCommon.length > 0 && (
          <>
            <dt>Most common</dt>
            <dd><ByteChips bytes={summary.mostCommon} histogram={result.histogram} total={summary.total} /></dd>
            <dt>Least common</dt>
            <dd><ByteChips bytes={summary.leastCommon} histogram={result.histogram} total={summary.total} /></dd>
          </>
        )}
      </dl>
    </div>
  )
}

function Entropy() {
  const { buffer, bytes, revision, analysis } = useFile()
  const [token, setToken] = useState(0)
  const result = useByteStats({ buffer, bytes, revision, token })
  const summary = useMemo(() => (result?.histogram ? summarize(result.histogram) : null), [result?.histogram])

  if (!bytes) return <section className="hd-panel"><p className="hd-empty">Reading file…</p></section>

  const size = bytes.length
  const stale = result && result.status === 'done' && result.revision !== revision
  const running = result?.status === 'running'
  const regions = analysis?.regions || null

  return (
    <section className="hd-panel entropy-panel" aria-label="Entropy" data-status={result?.status || 'idle'}>
      <div className="hd-panel-header">
        <h2 className="hd-panel-title">Entropy</h2>
        {result && size > 0 && (
          <span className="hd-muted entropy-block">
            {result.points.toLocaleString()} blocks of {formatBytes(result.blockSize)}
          </span>
        )}
      </div>
      {size === 0 && <p className="hd-empty">The file is empty.</p>}
      {stale && (
        <div className="hd-row entropy-stale" role="status">
          <span className="hd-badge hd-badge--yellow">Stale</span>
          <span>The bytes were edited after this was computed.</span>
          <button type="button" className="hd-button hd-button--small" onClick={() => setToken(t => t + 1)}>Recompute</button>
        </div>
      )}
      {result?.status === 'error' && <p className="hd-warning" role="alert">Could not compute: {result.error.message}</p>}
      {result && size > 0 && (
        <>
          {running && (
            <div className="hd-row entropy-progress" aria-live="polite">
              <progress max={result.points} value={result.filled} aria-label="Computing entropy" />
              <span className="hd-muted">Computing {Math.round((result.filled / result.points) * 100)}%</span>
            </div>
          )}
          <GraphWithSelection data={result} regions={regions} version={result.filled} />
          {regions && regions.length > 0 && (
            <p className="hd-muted entropy-note">
              The strip under the graph marks the {regions.length.toLocaleString()} regions of this {analysis.formatName || 'file'}; click it to select one.
            </p>
          )}
          {summary && <Summary result={result} summary={summary} />}
          {summary && <Histogram histogram={result.histogram} total={summary.total} />}
        </>
      )}
    </section>
  )
}

export default Entropy
