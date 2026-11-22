/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useEffect, useMemo, useState } from 'react'
import { useFile, usePosterPins, useSelection } from '../../state/hooks.js'
import { buildPoster } from './render.js'
import { BYTES_PER_ROW, DEPTHS, LABEL_LIMITS, DEFAULT_OPTIONS, topLevelChoices } from './plan.js'
import { DEFAULT_MODE, DEFAULT_SHOW, INCLUDE, PAGE_PROPORTIONS, describePlan, includeChoices, posterOptions } from './controls.js'
import { hexOffset, formatSize } from './layout.js'
import { posterBaseName } from './escape.js'
import { readTheme } from './theme.js'
import { useThemeVersion } from '../../lib/canvasColors.js'
import { svgBlob, svgToPng, pngSize } from './exporter.js'
import { canCopyImage, copyImage } from '../../lib/clipboard.js'
import { downloadBlob } from '../../lib/download.js'
import './poster.css'
import { visibleText } from '../../lib/visibleText.js'

const STYLES = [['dark', 'Dark'], ['print', 'Print']]

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function Segmented({ label, value, options, onChange }) {
  return (
    <div className="poster-field" role="group" aria-label={label}>
      <span className="poster-label" aria-hidden="true">{label}</span>
      <div className="poster-segmented">
        {options.map(([id, text]) => (
          <button
            key={id}
            type="button"
            className={`hd-button hd-button--small${value === id ? ' hd-button--active' : ''}`}
            aria-pressed={value === id}
            onClick={() => onChange(id)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

// Subscribes to the selection on its own, so the poster itself does not
// re-render while the user selects bytes
const SelectionSource = memo(function SelectionSource({ active, range, onUse }) {
  const { selection } = useSelection()
  const usable = selection && selection.end > selection.start
  const differs = usable && (!range || range.start !== selection.start || range.end !== selection.end)
  return (
    <button
      type="button"
      className={`hd-button hd-button--small${active && !differs ? ' hd-button--active' : ''}`}
      aria-pressed={active}
      disabled={!usable}
      title={usable ? undefined : 'Select some bytes in the hex view first'}
      onClick={() => onUse({ start: selection.start, end: selection.end })}
    >
      {active && differs ? 'Use new selection' : 'Selection'}
    </button>
  )
})

const ModeButton = ({ id, mode, disabled, onPick, children }) => (
  <button
    type="button"
    className={`hd-button hd-button--small${mode === id ? ' hd-button--active' : ''}`}
    aria-pressed={mode === id}
    disabled={disabled}
    onClick={() => onPick(id)}
  >
    {children}
  </button>
)

// Switches for the poster's extra blocks; only those that can change this file's poster are shown
function Include({ choices, show, onChange }) {
  const usable = INCLUDE.filter(([id]) => choices[id])
  if (usable.length === 0) return null
  return (
    <div className="poster-field poster-field--wide" role="group" aria-labelledby="poster-include-label">
      <span className="poster-label" id="poster-include-label">Include</span>
      <div className="poster-switches">
        {usable.map(([id, text]) => (
          <label key={id} className="poster-switch">
            <input type="checkbox" checked={show[id]} onChange={event => onChange(id, event.target.checked)} />
            {text}
          </label>
        ))}
      </div>
    </div>
  )
}

function Pins({ pins, mode, onRemove, onClear, onWholeFile }) {
  if (pins.length === 0) return null
  return (
    <div className="poster-field poster-field--wide" role="group" aria-labelledby="poster-pins-label">
      <span className="poster-label" id="poster-pins-label">Pinned fields</span>
      <ul className="poster-pins">
        {pins.map(pin => {
          const name = visibleText(pin.name) || '(unnamed)'
          return (
            <li key={`${pin.offset}:${pin.length}`}>
              <button
                type="button"
                className="hd-button hd-button--small poster-pin"
                aria-label={`Unpin ${name} at ${hexOffset(pin.offset)}`}
                onClick={() => onRemove(pin.offset, pin.length)}
              >
                <span className="poster-pin-name">{name}</span>
                <span className="poster-pin-offset">{hexOffset(pin.offset)}</span>
                <span className="poster-pin-x" aria-hidden="true">×</span>
              </button>
            </li>
          )
        })}
        <li>
          <button type="button" className="hd-button hd-button--small poster-pins-clear" onClick={onClear}>Clear pins</button>
        </li>
      </ul>
      {mode !== 'tour' && (
        <p className="poster-pins-hint hd-muted">
          Pinned fields are always labelled on the whole-file poster.{' '}
          <button type="button" className="hd-button hd-button--small" onClick={onWholeFile}>Show whole file</button>
        </p>
      )}
    </div>
  )
}

function usePreviewUrl(svg) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    if (!svg) {
      setUrl(null)
      return undefined
    }
    const next = URL.createObjectURL(svgBlob(svg))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [svg])
  return url
}

export default function Poster() {
  const { file, bytes, analysis, status, revision } = useFile()
  const { pins, remove: unpin, clear: clearPins } = usePosterPins()
  const [options, setOptions] = useState({
    bytesPerRow: DEFAULT_OPTIONS.bytesPerRow,
    depth: DEFAULT_OPTIONS.depth,
    maxLabels: DEFAULT_OPTIONS.maxLabels,
    style: 'dark',
    proportion: 'landscape'
  })
  const [show, setShow] = useState(DEFAULT_SHOW)
  const [source, setSource] = useState({ file: null, mode: DEFAULT_MODE, range: null, fieldIndex: 0 })
  const [builtRevision, setBuiltRevision] = useState(revision)
  const [zoom, setZoom] = useState('fit')
  const [busy, setBusy] = useState(null)
  const [message, setMessage] = useState('')
  const themeToken = useThemeVersion()

  const choices = useMemo(() => (analysis && bytes ? topLevelChoices(analysis, bytes.length) : []), [analysis, bytes])
  const includeGuess = useMemo(() => includeChoices(analysis), [analysis])
  const current = source.file === file ? source : { file, mode: DEFAULT_MODE, range: null, fieldIndex: 0 }
  const mode = current.mode === 'field' && !choices[current.fieldIndex] ? DEFAULT_MODE : current.mode
  const setOption = (key, value) => setOptions(previous => ({ ...previous, [key]: value }))
  const setMode = next => setSource({ ...current, mode: next })

  const built = useMemo(
    () => posterOptions({ options, mode, range: current.range, fieldIndex: current.fieldIndex, pins, show }),
    [options, mode, current.range, current.fieldIndex, pins, show]
  )

  const poster = useMemo(() => {
    if (status !== 'ready' || !bytes || !analysis) return null
    try {
      const theme = built.style === 'dark' ? readTheme() : null
      const result = buildPoster({
        bytes,
        analysis,
        fileName: file?.name || 'untitled',
        options: built,
        theme,
        date: today()
      })
      return { ...result, background: theme?.background || (built.style === 'print' ? '#ffffff' : '#060714'), error: null }
    } catch (err) {
      console.error('Poster generation failed', err)
      return { error: err }
    }
    // builtRevision and themeToken only trigger a rebuild
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, bytes, analysis, file, built, builtRevision, themeToken])

  // Which switches do something: the poster itself knows what it could draw for this file,
  // whatever is switched off; before one is built, go by what the analysis holds
  const include = poster?.scene?.available || includeGuess
  const previewUrl = usePreviewUrl(poster?.svg)
  const baseName = posterBaseName(file?.name)

  if (!file) return null
  if (status !== 'ready' || !analysis) return <div className="hd-panel"><p className="hd-empty">Analyzing…</p></div>

  const stale = revision !== builtRevision
  const png = poster?.svg ? pngSize(poster.width, poster.height) : null
  const background = poster?.background || '#000000'

  const run = async (kind, task, done) => {
    setBusy(kind)
    setMessage('')
    try {
      await task()
      setMessage(done)
    } catch (err) {
      setMessage(`Could not ${kind === 'copy' ? 'copy' : 'save'} the poster: ${err.message || err}`)
    } finally {
      setBusy(null)
    }
  }

  const downloadSvg = () => {
    downloadBlob(svgBlob(poster.svg), `${baseName}.svg`)
    setMessage(`Saved ${baseName}.svg`)
  }
  const downloadPng = () => run('png', async () => {
    const blob = await svgToPng(poster.svg, poster.width, poster.height, background)
    downloadBlob(blob, `${baseName}.png`)
  }, `Saved ${baseName}.png`)
  const copy = () => run('copy', () => copyImage(svgToPng(poster.svg, poster.width, poster.height, background)), 'Copied the poster as an image')

  const plan = poster?.plan

  return (
    <div className="hd-panel poster">
      <div className="hd-panel-header">
        {stale && (
          <button type="button" className="hd-button hd-button--small hd-button--active" onClick={() => setBuiltRevision(revision)}>
            Refresh after edits
          </button>
        )}
      </div>

      <div className="poster-options">
        <div className="poster-field" role="group" aria-label="Show">
          <span className="poster-label" aria-hidden="true">Show</span>
          <div className="poster-segmented">
            <ModeButton id="tour" mode={mode} onPick={setMode}>Whole file</ModeButton>
            <ModeButton id="auto" mode={mode} onPick={setMode}>Start of file</ModeButton>
            <SelectionSource
              active={mode === 'selection'}
              range={current.range}
              onUse={range => setSource({ ...current, mode: 'selection', range })}
            />
            <ModeButton id="field" mode={mode} onPick={setMode} disabled={choices.length === 0}>This field</ModeButton>
          </div>
        </div>

        {mode === 'field' && (
          <label className="poster-field poster-field--wide">
            <span className="poster-label">Field</span>
            <select
              className="hd-input poster-select"
              value={current.fieldIndex}
              onChange={event => setSource({ ...current, mode: 'field', fieldIndex: Number(event.target.value) })}
            >
              {choices.map(choice => (
                <option key={choice.index} value={choice.index}>
                  {visibleText(choice.name) || '(unnamed)'} · {hexOffset(choice.offset)} · {formatSize(choice.length)}
                </option>
              ))}
            </select>
          </label>
        )}

        <Segmented label="Bytes per row" value={options.bytesPerRow} options={BYTES_PER_ROW.map(n => [n, String(n)])} onChange={v => setOption('bytesPerRow', v)} />

        <label className="poster-field">
          <span className="poster-label">Label depth</span>
          <select className="hd-input poster-select" value={options.depth} onChange={event => setOption('depth', Number(event.target.value))}>
            {DEPTHS.map(d => <option key={d} value={d}>{d === 1 ? 'Top level only' : `${d} levels`}</option>)}
          </select>
        </label>

        <label className="poster-field">
          <span className="poster-label">Labels</span>
          <select className="hd-input poster-select" value={options.maxLabels} onChange={event => setOption('maxLabels', Number(event.target.value))}>
            {LABEL_LIMITS.map(n => <option key={n} value={n}>up to {n}</option>)}
          </select>
        </label>

        <Segmented label="Style" value={options.style} options={STYLES} onChange={v => setOption('style', v)} />
        <Segmented label="Page" value={options.proportion} options={PAGE_PROPORTIONS} onChange={v => setOption('proportion', v)} />

        <Include choices={include} show={show} onChange={(key, on) => setShow(previous => ({ ...previous, [key]: on }))} />

        <Pins pins={pins} mode={mode} onRemove={unpin} onClear={clearPins} onWholeFile={() => setMode('tour')} />
      </div>

      {poster?.error && <p className="hd-warning">The poster could not be drawn: {String(poster.error.message || poster.error)}</p>}

      {plan && (
        <p className="poster-summary hd-muted">
          {mode === 'selection' && current.range && <>Selection {hexOffset(current.range.start)}–{hexOffset(current.range.end - 1)}. </>}
          {describePlan(plan, { pins: built.pins })}
          {plan.source === 'regions' && ' No field map for this format: boxes show regions.'}
          {plan.source === 'none' && plan.size > 0 && ' No field map for this format: bytes are coloured by class.'}
        </p>
      )}

      {previewUrl && (
        <div className={`poster-preview poster-preview--${zoom}`} data-style={options.style}>
          <img
            src={previewUrl}
            alt={`Poster of ${visibleText(file.name)}`}
            width={zoom === 'full' ? poster.width : undefined}
            height={zoom === 'full' ? poster.height : undefined}
            draggable="false"
          />
        </div>
      )}

      {poster?.svg && (
        <div className="poster-actions hd-row">
          <button type="button" className="hd-button hd-button--small" onClick={() => setZoom(zoom === 'fit' ? 'full' : 'fit')} aria-pressed={zoom === 'full'}>
            {zoom === 'fit' ? 'Full size' : 'Fit to panel'}
          </button>
          <button type="button" className="hd-button hd-button--small poster-save-svg" onClick={downloadSvg}>Download SVG</button>
          <button type="button" className="hd-button hd-button--small poster-save-png" onClick={downloadPng} disabled={busy !== null}>
            {busy === 'png' ? 'Rendering…' : 'Download PNG'}
          </button>
          {canCopyImage() && (
            <button type="button" className="hd-button hd-button--small poster-copy-png" onClick={copy} disabled={busy !== null}>
              {busy === 'copy' ? 'Copying…' : 'Copy PNG'}
            </button>
          )}
          <span className="hd-muted poster-size">{poster.width} × {poster.height} · PNG {png.width} × {png.height} px</span>
        </div>
      )}
      <p className="poster-message hd-muted" role="status" aria-live="polite">{message}</p>
    </div>
  )
}
