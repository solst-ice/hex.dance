/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useFile, useHexCursor, useSelection, useWorkspace } from '../../state/hooks.js'
import { requestSearch } from '../search/request.js'
import { inspect } from './decode.js'
import { toHex } from './copyAs.js'
import { usePersistentState } from './usePersistentState.js'
import CopyMenu from './CopyMenu.jsx'
import './inspector.css'

const PREFILL_LIMIT = 64
const SUMMARY_IDS = ['int8', 'int16', 'int32', 'ascii']

function hexOffset(n) {
  return `0x${n.toString(16).padStart(Math.max(4, Math.ceil(n.toString(16).length / 2) * 2), '0')}`
}

/**
 * Ctrl/Cmd+F inside the hex view opens the Search tab, pre-filled with the
 * selected bytes. Registered here because the dock is always mounted.
 */
function useFindShortcut(bytes, selection) {
  const { openPanel } = useWorkspace()
  const latest = useRef(null)
  latest.current = { bytes, selection, openPanel }

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'f') return
      const target = event.target
      const view = target instanceof Element ? target.closest('.hexview') : null
      // In full screen the tabs are hidden, so the browser keeps its own find
      if (!view || view.classList.contains('is-fullscreen')) return
      event.preventDefault()
      const { bytes, selection, openPanel } = latest.current
      const length = selection ? selection.end - selection.start : 0
      const query = bytes && length >= 1 && length <= PREFILL_LIMIT && selection.end <= bytes.length
        ? toHex(bytes.subarray(selection.start, selection.end))
        : null
      requestSearch(query ? { mode: 'hex', query } : {})
      openPanel('search')
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}

const Cell = memo(function Cell({ entry, onSelect }) {
  const { id, label, value, invalid, color, colorAlpha, start, length } = entry
  const unavailable = value === null
  const range = `${length} byte${length === 1 ? '' : 's'} at ${hexOffset(start)}`
  const className = `insp-cell insp-cell--${id}` +
    (invalid ? ' is-invalid' : '') +
    (unavailable ? ' is-unavailable' : '')
  return (
    <button
      type="button"
      className={className}
      disabled={unavailable}
      onClick={() => onSelect(start, length)}
      title={unavailable ? `Needs ${length} bytes: past the end of the file` : `${value}\n${entry.title ? `${entry.title}\n` : ''}Click to select ${range}`}
    >
      <span className="insp-k">{label}</span>
      <span className="insp-v">
        {color && (
          <span className="insp-swatch" aria-hidden="true">
            <span style={{ background: color }} />
            {colorAlpha && <span style={{ background: colorAlpha }} />}
          </span>
        )}
        {unavailable
          ? <><span aria-hidden="true">—</span><span className="insp-sr">unavailable, past the end of the file</span></>
          : value}
      </span>
    </button>
  )
})

function Inspector() {
  const { file, bytes, revision } = useFile()
  const { selection, jumpTo } = useSelection()
  const cursor = useHexCursor()
  const gridId = useId()
  const [littleEndian, setLittleEndian] = usePersistentState('hexdance.inspector.littleEndian', true)
  const [collapsed, setCollapsed] = usePersistentState('hexdance.inspector.collapsed',
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 600px)').matches))
  const [status, setStatus] = useState(null)
  const statusTimer = useRef(0)

  useFindShortcut(bytes, selection)

  useEffect(() => () => clearTimeout(statusTimer.current), [])
  const showStatus = useCallback((text) => {
    setStatus(text)
    clearTimeout(statusTimer.current)
    statusTimer.current = setTimeout(() => setStatus(null), 5000)
  }, [])

  const size = bytes ? bytes.length : 0
  const range = selection && selection.end <= size
    ? selection
    : size ? { start: Math.min(cursor ?? 0, size - 1), end: Math.min(cursor ?? 0, size - 1) + 1 } : null
  const offset = range ? range.start : 0

  const entries = useMemo(
    () => (bytes ? inspect(bytes, offset, littleEndian) : []),
    // Bytes are edited in place, so `revision` stands in for their contents
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bytes, revision, offset, littleEndian]
  )

  if (!bytes) return null
  const length = range ? range.end - range.start : 0
  const summary = entries.filter(entry => SUMMARY_IDS.includes(entry.id) && entry.value !== null)

  return (
    <section className={`hd-panel insp${collapsed ? ' is-collapsed' : ''}`} aria-label="Data inspector">
      <div className="insp-head">
        <button
          type="button"
          className="insp-toggle"
          aria-expanded={!collapsed}
          aria-controls={gridId}
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Show all values' : 'Collapse to a summary'}
        >
          <span className="insp-chevron" aria-hidden="true" />
          Inspector
        </button>
        {size === 0
          ? <span className="hd-muted insp-at">Empty file</span>
          : (
            <span className="insp-at">
              @ <span className="insp-offset">{hexOffset(offset)}</span>
              {length > 1 && (
                <span className="insp-len" title="Selection length">
                  {' '}· {length.toLocaleString()} bytes ({`0x${length.toString(16)}`})
                </span>
              )}
            </span>
          )}
        {collapsed && summary.length > 0 && (
          <span className="insp-summary" aria-hidden="true">
            {summary.map(entry => `${entry.label} ${entry.value}`).join(' · ')}
          </span>
        )}
        <div className="insp-actions">
          <div className="insp-order" role="group" aria-label="Byte order">
            <button type="button" className={`insp-seg${littleEndian ? ' is-on' : ''}`} aria-pressed={littleEndian}
              onClick={() => setLittleEndian(true)} title="Little-endian">LE</button>
            <button type="button" className={`insp-seg${littleEndian ? '' : ' is-on'}`} aria-pressed={!littleEndian}
              onClick={() => setLittleEndian(false)} title="Big-endian">BE</button>
          </div>
          <CopyMenu bytes={bytes} range={range} fileName={file?.name} onStatus={showStatus} />
        </div>
      </div>
      <div className="insp-grid" id={gridId} hidden={collapsed}>
        {entries.map(entry => <Cell key={entry.id} entry={entry} onSelect={jumpTo} />)}
      </div>
      <p className="insp-status" role="status" aria-live="polite">{status}</p>
    </section>
  )
}

export default Inspector
