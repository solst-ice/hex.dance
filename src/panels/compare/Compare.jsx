/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useFile, useSelectionActions } from '../../state/hooks.js'
import { GAP_CHOICES } from './diff.js'
import { exportText, hexOffset, offsetDigits, percent, plural, shiftText, sizeText, verdict } from './format.js'
import { itemAt, itemCount, itemNear } from './items.js'
import { clearSecond, readSecond, setGap, setSecond, useCompareState } from './store.js'
import { useComparison } from './useComparison.js'
import { useDropTarget } from './useDropTarget.js'
import { copyText } from '../../lib/clipboard.js'
import { downloadText } from '../../lib/download.js'
import DiffMap from './DiffMap.jsx'
import HighlightLayer from './HighlightLayer.jsx'
import RangeList from './RangeList.jsx'
import SideBySide from './SideBySide.jsx'
import './compare.css'

// Below this share of matching bytes, with no shift found, an equal-offset
// comparison says little
const MEANINGFUL_MATCH = 0.5

const sameOffset = (offset) => offset

function formatDuration(ms) {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`
}

function FileInput({ inputRef, onFile }) {
  return (
    <input
      ref={inputRef}
      type="file"
      className="compare-file-input"
      aria-label="Choose a file to compare with"
      tabIndex={-1}
      onChange={event => {
        const picked = event.target.files?.[0]
        event.target.value = ''
        if (picked) onFile(picked)
      }}
    />
  )
}

function Files({ file, size, revision, state, onChoose, onSwap, onOriginal }) {
  const { b, loading, error } = state
  const canUseOriginal = revision > 0 && !(b?.origin === 'original' && b.file === file)
  return (
    <div className="compare-files">
      <div className="compare-file">
        <span className="hd-badge compare-file-tag">A</span>
        <span className="compare-file-name" title={file.name}>{file.name}</span>
        <span className="hd-muted compare-file-size">{sizeText(size)}{revision > 0 ? ', edited' : ''}</span>
      </div>
      <div className="compare-file">
        <span className="hd-badge hd-badge--pink compare-file-tag">B</span>
        {loading ? (
          <span className="hd-muted" role="status">Reading {loading.name}…</span>
        ) : b ? (
          <>
            <span className="compare-file-name" title={b.name}>{b.name}</span>
            <span className="hd-muted compare-file-size">{sizeText(b.bytes.length)}</span>
          </>
        ) : (
          <span className="hd-muted">Drop a second file here, or choose one.</span>
        )}
      </div>
      {error && <p className="hd-warning" role="alert">{error}</p>}
      <div className="hd-row compare-file-actions">
        <button type="button" className="hd-button hd-button--small" onClick={onChoose}>
          {b ? 'Replace B' : 'Choose B'}
        </button>
        {b && (
          <>
            <button type="button" className="hd-button hd-button--small" onClick={onSwap} title="Open B as the main file and compare it with A">
              Swap
            </button>
            <button type="button" className="hd-button hd-button--small" onClick={clearSecond}>Clear B</button>
          </>
        )}
        {canUseOriginal && (
          <button type="button" className="hd-button hd-button--small" onClick={onOriginal} title="Compare the edited bytes with the file as it was opened">
            Compare with original
          </button>
        )}
      </div>
    </div>
  )
}

function Verdict({ comparison, running, stale, onRerun, onJump }) {
  const { stats } = comparison
  const total = Math.max(stats.sizeA, stats.sizeB)
  const done = comparison.compared
  const { kind, title, detail } = verdict(stats)
  const matching = stats.common - stats.diffBytes
  const tooDifferent = done && stats.diffBytes > 0 && comparison.shiftSearched && !comparison.shift &&
    matching / Math.max(1, stats.common) < MEANINGFUL_MATCH
  const shift = comparison.shift
  const badge = { identical: 'hd-badge', prefix: 'hd-badge hd-badge--yellow' }[kind] || 'hd-badge hd-badge--pink'

  return (
    <div className="compare-verdict hd-stack" aria-live="polite">
      {done ? (
        <div className="compare-verdict-head">
          <span className={badge}>{title}</span>
          <span className="compare-verdict-detail">{detail}</span>
        </div>
      ) : (
        <div className="hd-row">
          <progress max={Math.max(1, stats.common)} value={stats.position} aria-label="Comparing" />
          <span className="hd-muted">
            Comparing… {percent(stats.position, Math.max(1, stats.common))}, {plural(stats.diffBytes, 'differing byte')} so far
          </span>
        </div>
      )}
      {comparison.error && <p className="hd-warning" role="alert">The comparison failed: {comparison.error.message}</p>}
      {(stale || (running && running !== comparison)) && (
        <div className="hd-row compare-stale" role="status">
          <span className="hd-badge hd-badge--yellow">Stale</span>
          <span>{running && running !== comparison ? 'A was edited; comparing again…' : 'A was edited since this comparison.'}</span>
          {!running && (
            <button type="button" className="hd-button hd-button--small" onClick={onRerun}>Compare again</button>
          )}
        </div>
      )}
      <dl className="hd-kv compare-facts">
        <dt>Matching</dt>
        <dd>{percent(matching, total)} of bytes at the same offset</dd>
        <dt>First difference</dt>
        <dd>
          {stats.firstDiff >= 0
            ? <button type="button" className="compare-link hd-mono" onClick={() => onJump(stats.firstDiff)}>{hexOffset(stats.firstDiff)}</button>
            : stats.sizeA !== stats.sizeB
              ? <button type="button" className="compare-link hd-mono" onClick={() => onJump(stats.common)}>{hexOffset(stats.common)}</button>
              : '—'}
        </dd>
        <dt>Last difference</dt>
        <dd>
          {stats.sizeA !== stats.sizeB
            ? <button type="button" className="compare-link hd-mono" onClick={() => onJump(total - 1)}>{hexOffset(total - 1)}</button>
            : stats.lastDiff >= 0
              ? <button type="button" className="compare-link hd-mono" onClick={() => onJump(stats.lastDiff)}>{hexOffset(stats.lastDiff)}</button>
              : '—'}
        </dd>
        {comparison.done && (
          <>
            <dt>Time</dt>
            <dd>{formatDuration(comparison.ms)}</dd>
          </>
        )}
      </dl>
      {shift && (
        <p className="compare-shift">
          {shiftText(shift)}. The content after it matches again ({percent(Math.round(shift.ratio * shift.checked), shift.checked)} of
          {' '}{plural(shift.checked, 'checked block')}), so equal-offset differences from {hexOffset(shift.at)} on come from the shift, not from changed bytes.
        </p>
      )}
      {tooDifferent && (
        <p className="hd-warning compare-too-different">
          These files are too different for a byte-by-byte comparison to say much: only {percent(matching, Math.max(1, stats.common))} of
          the compared bytes match, and no single insertion or removal lines them up.
        </p>
      )}
    </div>
  )
}

function ExportButtons({ build, fileName }) {
  const [copied, setCopied] = useState(null)
  const copy = async () => {
    const ok = await copyText(build())
    setCopied(ok ? 'Copied' : 'Copy failed')
    setTimeout(() => setCopied(null), 1500)
  }
  return (
    <div className="hd-row compare-export">
      <button type="button" className="hd-button hd-button--small" onClick={copy}>Copy list</button>
      <button type="button" className="hd-button hd-button--small" onClick={() => downloadText(build(), fileName)}>Download list</button>
      <span className="hd-muted" role="status">{copied}</span>
    </div>
  )
}

function Results({ comparison, running, stale, rerun, a, aName, b, revision, gap, onSelect, activeIndex }) {
  const [aligned, setAligned] = useState(false)
  const { stats, ranges, version } = comparison
  const count = itemCount(stats, ranges)
  const digits = offsetDigits(Math.max(stats.sizeA, stats.sizeB))
  const shown = activeIndex >= 0 ? activeIndex : (count ? 0 : -1)
  const item = itemAt(stats, ranges, shown)
  const shift = comparison.shift

  const mapB = useMemo(() => {
    if (!aligned || !shift) return sameOffset
    const { at, shift: by } = shift
    return (offset) => {
      if (offset < at) return offset
      if (by < 0 && offset < at - by) return null
      return offset + by
    }
  }, [aligned, shift])

  const jumpNear = useCallback((offset) => {
    const index = itemNear(stats, ranges, offset)
    if (index >= 0) onSelect(index)
  }, [stats, ranges, onSelect])

  const step = (by, options) => {
    if (!count) return
    onSelect(Math.min(count - 1, Math.max(0, (activeIndex < 0 ? (by > 0 ? -1 : 0) : activeIndex) + by)), options)
  }

  const onKeyDown = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.target.closest('input, select, textarea')) return
    if (event.key === 'n' || event.key === 'p') {
      event.preventDefault()
      // Keys step through the differences: no flash on every one
      step(event.key === 'n' ? 1 : -1, { flash: false })
    }
  }

  const build = () => exportText({ a: { name: aName, bytes: a }, b: { name: b.name, bytes: b.bytes }, stats, ranges, shift })
  const exportName = `compare-${aName}-${b.name}.txt`.replace(/[^\w.-]+/g, '_')

  return (
    <div className="hd-stack compare-results" onKeyDown={onKeyDown}>
      <HighlightLayer comparison={comparison} />
      <Verdict comparison={comparison} running={running} stale={stale} onRerun={rerun} onJump={jumpNear} />
      <DiffMap
        stats={stats}
        version={version}
        activeStart={item ? item.start : -1}
        activeEnd={item ? item.end : -1}
        shiftAt={shift ? shift.at : null}
        onPick={jumpNear}
      />
      {count > 0 && (
        <>
          <div className="compare-list-head">
            <h3 className="hd-section-title">Differences</h3>
            <span className="hd-muted">
              {plural(stats.rangeCount, 'range')}
              {stats.rangeCount > ranges.length && comparison.compared ? `, first ${ranges.length.toLocaleString('en-US')} listed` : ''}
            </span>
            <label className="compare-gap hd-muted">
              Merge gaps up to{' '}
              <select className="hd-input" value={gap} onChange={event => setGap(Number(event.target.value))}>
                {GAP_CHOICES.map(choice => <option key={choice} value={choice}>{choice}</option>)}
              </select>{' '}
              bytes
            </label>
          </div>
          <div className="compare-list-cols hd-muted" aria-hidden="true">
            <span>Offset</span><span>Length</span><span>A → B</span>
          </div>
          <RangeList
            stats={stats}
            ranges={ranges}
            version={version}
            revision={revision}
            activeIndex={activeIndex}
            a={a}
            b={b.bytes}
            digits={digits}
            onActivate={onSelect}
          />
          {item && (
            <div className="compare-detail hd-stack">
              <div className="compare-detail-head">
                <button type="button" className="hd-button hd-button--small" onClick={() => step(-1)} disabled={activeIndex <= 0} aria-label="Previous difference">
                  ‹ Prev
                </button>
                <span className="hd-mono compare-detail-title">
                  {item.kind === 'tail'
                    ? `Only in ${item.only}: ${hexOffset(item.start, digits)}, ${plural(item.end - item.start, 'byte')}`
                    : `${hexOffset(item.start, digits)}, ${plural(item.end - item.start, 'byte')}${item.diffs !== item.end - item.start ? ` (${item.diffs.toLocaleString('en-US')} differ)` : ''}`}
                </span>
                <button type="button" className="hd-button hd-button--small" onClick={() => step(1)} disabled={activeIndex >= count - 1} aria-label="Next difference">
                  Next ›
                </button>
              </div>
              {shift && (
                <label className="compare-align hd-muted">
                  <input type="checkbox" checked={aligned} onChange={event => setAligned(event.target.checked)} />
                  {' '}Line B up after the {shift.shift > 0 ? 'insertion' : 'removal'}
                </label>
              )}
              <SideBySide
                a={a}
                b={b.bytes}
                revision={revision}
                start={item.start}
                end={item.end}
                mapB={mapB}
                digits={digits}
              />
              <p className="hd-muted compare-keys">Keys: ↑ ↓ in the list, or N and P anywhere in this tab.</p>
            </div>
          )}
          {comparison.compared && <ExportButtons build={build} fileName={exportName} />}
        </>
      )}
    </div>
  )
}

export default function Compare() {
  const { file, buffer, bytes, revision, openFile } = useFile()
  const { jumpTo } = useSelectionActions()
  const state = useCompareState()
  const { b, gap } = state
  const { result, running, stale, rerun } = useComparison({ buffer, bytes, revision, b, gap })
  const comparison = result || running
  const inputRef = useRef(null)
  const [activeOffset, setActiveOffset] = useState(null)

  const pick = useCallback((picked) => readSecond(picked), [])
  const drop = useDropTarget(pick)

  const activeIndex = comparison?.stats && activeOffset !== null
    ? itemNear(comparison.stats, comparison.ranges, activeOffset)
    : -1

  const onSelect = useCallback((index, options) => {
    if (!comparison?.stats) return
    const item = itemAt(comparison.stats, comparison.ranges, index)
    if (!item) return
    setActiveOffset(item.start)
    const inA = Math.min(item.end, comparison.stats.sizeA) - item.start
    if (inA > 0) jumpTo(item.start, inA, options)
  }, [comparison, jumpTo])

  if (!file) return null

  const swap = () => {
    if (!b || !bytes) return
    const next = b.file || new File([b.bytes], b.name)
    // A becomes B only once B is really opened: with unsaved edits the
    // reader may choose to keep editing A, and then nothing changes
    openFile(next, {
      onOpen() {
        setSecond({
          name: revision > 0 ? `${file.name} (edited)` : file.name,
          bytes,
          file: revision > 0 ? null : file,
          origin: 'swapped'
        })
        setActiveOffset(null)
      }
    })
  }

  const original = () => readSecond(file, 'original', `${file.name} (original)`)

  return (
    <div className={`hd-panel compare-panel${drop.dragging ? ' is-dragging' : ''}`} ref={drop.ref} {...drop.handlers}>
      <FileInput inputRef={inputRef} onFile={pick} />
      <Files
        file={file}
        size={bytes ? bytes.length : file.size}
        revision={revision}
        state={state}
        onChoose={() => inputRef.current?.click()}
        onSwap={swap}
        onOriginal={original}
      />
      {!bytes && <p className="hd-empty">Reading file…</p>}
      {bytes && b && comparison?.stats && (
        <Results
          comparison={comparison}
          running={running}
          stale={stale}
          rerun={rerun}
          a={bytes}
          aName={file.name}
          b={b}
          revision={revision}
          gap={gap}
          onSelect={onSelect}
          activeIndex={activeIndex}
        />
      )}
      {bytes && b && !comparison?.stats && (comparison?.error
        ? <p className="hd-warning" role="alert">The comparison failed: {comparison.error.message}</p>
        : <p className="hd-empty">Comparing…</p>)}
      {drop.dragging && drop.rect && createPortal(
        <div
          className="compare-drop-overlay"
          aria-hidden="true"
          style={{ top: drop.rect.top, left: drop.rect.left, width: drop.rect.width, height: drop.rect.height }}
        >
          <span>Drop to compare</span>
        </div>,
        document.body
      )}
    </div>
  )
}
