/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useEffect, useMemo, useState } from 'react'
import { useFile, useSelection } from '../../state/hooks.js'
import { buildPoster } from './render.js'
import { BYTES_PER_ROW, DEPTHS, LABEL_LIMITS, MAX_ROWS, DEFAULT_OPTIONS, topLevelChoices } from './plan.js'
import { hexOffset, formatSize } from './layout.js'
import { posterBaseName } from './escape.js'
import { readTheme } from './theme.js'
import { useThemeVersion } from '../../lib/canvasColors.js'
import { svgBlob, svgToPng, pngSize } from './exporter.js'
import { canCopyImage, copyImage } from '../../lib/clipboard.js'
import { downloadBlob } from '../../lib/download.js'
import './poster.css'

const STYLES = [['dark', 'Dark'], ['print', 'Print']]
const PROPORTIONS = [['landscape', 'Landscape'], ['portrait', 'Portrait'], ['square', 'Square']]

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function Segmented({ label, value, options, onChange }) {
  return (
    <div className="poster-field" role="group" aria-label={label}>
      <span className="poster-label">{label}</span>
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
  const [options, setOptions] = useState({ ...DEFAULT_OPTIONS, style: 'dark', proportion: 'landscape' })
  const [source, setSource] = useState({ file: null, mode: 'auto', range: null, fieldIndex: 0 })
  const [builtRevision, setBuiltRevision] = useState(revision)
  const [zoom, setZoom] = useState('fit')
  const [busy, setBusy] = useState(null)
  const [message, setMessage] = useState('')
  const themeToken = useThemeVersion()

  const choices = useMemo(() => (analysis && bytes ? topLevelChoices(analysis, bytes.length) : []), [analysis, bytes])
  const current = source.file === file ? source : { file, mode: 'auto', range: null, fieldIndex: 0 }
  const mode = current.mode === 'field' && !choices[current.fieldIndex] ? 'auto' : current.mode
  const setOption = (key, value) => setOptions(previous => ({ ...previous, [key]: value }))

  const poster = useMemo(() => {
    if (status !== 'ready' || !bytes || !analysis) return null
    try {
      const theme = options.style === 'dark' ? readTheme() : null
      const result = buildPoster({
        bytes,
        analysis,
        fileName: file?.name || 'untitled',
        options: { ...options, mode, range: current.range, fieldIndex: current.fieldIndex },
        theme,
        date: today()
      })
      return { ...result, background: theme?.background || (options.style === 'print' ? '#ffffff' : '#060714'), error: null }
    } catch (err) {
      console.error('Poster generation failed', err)
      return { error: err }
    }
    // builtRevision and themeToken only trigger a rebuild
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, bytes, analysis, file, options, mode, current.range, current.fieldIndex, builtRevision, themeToken])

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
  const rows = plan ? plan.items.filter(i => i.type === 'row').length : 0

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
          <span className="poster-label">Show</span>
          <div className="poster-segmented">
            <button
              type="button"
              className={`hd-button hd-button--small${mode === 'auto' ? ' hd-button--active' : ''}`}
              aria-pressed={mode === 'auto'}
              onClick={() => setSource({ ...current, mode: 'auto' })}
            >
              Start of file
            </button>
            <SelectionSource
              active={mode === 'selection'}
              range={current.range}
              onUse={range => setSource({ ...current, mode: 'selection', range })}
            />
            <button
              type="button"
              className={`hd-button hd-button--small${mode === 'field' ? ' hd-button--active' : ''}`}
              aria-pressed={mode === 'field'}
              disabled={choices.length === 0}
              onClick={() => setSource({ ...current, mode: 'field' })}
            >
              One field
            </button>
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
                  {choice.name || '(unnamed)'} · {hexOffset(choice.offset)} · {formatSize(choice.length)}
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
        <Segmented label="Page" value={options.proportion} options={PROPORTIONS} onChange={v => setOption('proportion', v)} />
      </div>

      {poster?.error && <p className="hd-warning">The poster could not be drawn: {String(poster.error.message || poster.error)}</p>}

      {plan && (
        <p className="poster-summary hd-muted">
          {mode === 'selection' && current.range && <>Selection {hexOffset(current.range.start)}–{hexOffset(current.range.end - 1)}. </>}
          {plan.shown
            ? <>Showing {hexOffset(plan.shown.start)}–{hexOffset(plan.shown.end - 1)} in {rows} row{rows === 1 ? '' : 's'} (at most {MAX_ROWS}, long runs collapsed) with {plan.labels.length} label{plan.labels.length === 1 ? '' : 's'}.</>
            : <>Nothing to show.</>}
          {plan.source === 'regions' && ' No field map for this format: boxes show regions.'}
          {plan.source === 'none' && plan.size > 0 && ' No field map for this format: bytes are coloured by class.'}
        </p>
      )}

      {previewUrl && (
        <div className={`poster-preview poster-preview--${zoom}`} data-style={options.style}>
          <img
            src={previewUrl}
            alt={`Poster of ${file.name}`}
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
