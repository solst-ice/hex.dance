/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useState } from 'react'
import { CONFIDENCE, hex, hitSize, rangeText, sizeText } from './labels.js'
import { rangeEnd } from './report.js'

const PARSER = {
  parsed: (name) => `Parsed by the app as ${name}.`,
  detected: (name) => `Recognised by the app's ${name} parser (too large to parse here).`,
  rejected: (name) => `The app's ${name} parser does not recognise it.`,
  'parse-error': (name) => `The app's ${name} parser recognises it but stopped with an error.`
}

/** The selected hit: what it is, how sure the scan is, and what to do with it. */
export default function HitDetails({ hit, hits, size, onJump, onExtract, onOpen }) {
  const [mode, setMode] = useState('next')
  const [confirming, setConfirming] = useState(false)
  useEffect(() => setConfirming(false), [hit.id])

  const end = rangeEnd(hit, hits, size, mode)
  const length = end - hit.start
  const nextEnd = hit.end === null ? rangeEnd(hit, hits, size, 'next') : null
  const confidence = CONFIDENCE[hit.confidence]
  const title = hit.role === 'main' ? `${hit.name}: the file itself` : `${hit.name} at ${hex(hit.start)}`

  return (
    <section className="carve-details" aria-label="Selected signature">
      <h3 className="hd-section-title carve-details-title">{title}</h3>
      <dl className="hd-kv carve-kv">
        <dt>Range</dt>
        <dd className="hd-mono">
          {hit.end === null ? `${hex(hit.start)}–?` : rangeText(hit.start, hit.end)} ({hitSize(hit)})
          {hit.claimedEnd !== undefined && (
            <span className="carve-warn"> Its header says it is {sizeText(hit.claimedEnd - hit.start)}, so {sizeText(hit.claimedEnd - size)} are missing.</span>
          )}
        </dd>
        <dt>Confidence</dt>
        <dd><span className={`hd-badge carve-conf carve-conf--${hit.confidence}`}>{confidence.label}</span> {confidence.explain}</dd>
        <dt>Checked</dt>
        <dd>{hit.note}</dd>
        {hit.module && (
          <>
            <dt>App parser</dt>
            <dd>{hit.parser ? PARSER[hit.parser](hit.parserName) : 'Not available in this version of the app.'}</dd>
          </>
        )}
        {hit.parentLabel && hit.role !== 'main' && (
          <>
            <dt>Inside</dt>
            <dd>{hit.parentLabel}{hit.role === 'internal' ? ', as a normal part of its structure' : ''}</dd>
          </>
        )}
      </dl>

      {hit.end === null && (
        <fieldset className="carve-end">
          <legend>The end is unknown. Use bytes up to</legend>
          <label>
            <input type="radio" name="carve-end" value="next" checked={mode === 'next'} onChange={() => setMode('next')} />
            {' '}{nextEnd < size ? `the next signature, at ${hex(nextEnd)}` : 'the next signature (none: end of file)'} ({sizeText(nextEnd - hit.start)})
          </label>
          <label>
            <input type="radio" name="carve-end" value="eof" checked={mode === 'eof'} onChange={() => setMode('eof')} />
            {' '}the end of the file ({sizeText(size - hit.start)})
          </label>
        </fieldset>
      )}

      <div className="hd-row carve-actions">
        <button type="button" className="hd-button hd-button--small" onClick={() => onJump(hit.start, end)}>
          Jump
        </button>
        <button type="button" className="hd-button hd-button--small" onClick={() => onExtract(hit, end)} title={`Download ${sizeText(length)} as a file`}>
          Extract
        </button>
        <button
          type="button"
          className="hd-button hd-button--small"
          aria-expanded={confirming}
          onClick={() => setConfirming(c => !c)}
          disabled={hit.role === 'main' && end === size}
          title="Load these bytes in place of the current file"
        >
          Open…
        </button>
      </div>
      {confirming && (
        <div className="carve-confirm" role="alertdialog" aria-label="Open the extracted bytes">
          <p>
            Opening replaces the current file in the viewer with these {sizeText(length)}. Unsaved edits are lost;
            use Extract first if you want to keep them.
          </p>
          <div className="hd-row">
            <button type="button" className="hd-button hd-button--small hd-button--active" onClick={() => onOpen(hit, end)} autoFocus>
              Open it
            </button>
            <button type="button" className="hd-button hd-button--small" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
