/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useId, useState } from 'react'
import { useSelection } from '../../state/hooks.js'
import { crc32, formatHexBytes, hex8, parseHexBytes, u32Bytes } from './bytes.js'

// Only for small challenge files; a CRC over a huge selection would block the page
const MAX_SELECTION = 1 << 20

/** CRC-32 calculator: over the bytes selected in the hex view, or over typed hex. */
export default function CrcTool({ bytes }) {
  const { selection } = useSelection()
  const [typed, setTyped] = useState('')
  const [result, setResult] = useState(null)
  const inputId = useId()

  const selectionLength = selection ? selection.end - selection.start : 0
  const canUseSelection = Boolean(bytes && selection && selectionLength > 0 && selectionLength <= MAX_SELECTION && selection.end <= bytes.length)

  const fromSelection = () => {
    if (!canUseSelection) return
    setResult({ value: crc32(bytes, selection.start, selection.end), source: `${selectionLength} selected bytes at 0x${selection.start.toString(16).toUpperCase()}` })
  }

  const fromTyped = (event) => {
    event.preventDefault()
    const parsed = parseHexBytes(typed)
    if (!parsed) {
      setResult({ error: 'Type whole bytes in hex, like 49 48 44 52.' })
      return
    }
    setResult({ value: crc32(parsed), source: `${parsed.length} typed ${parsed.length === 1 ? 'byte' : 'bytes'}` })
  }

  return (
    <section className="ch-tool" aria-label="CRC-32 helper">
      <h3 className="hd-section-title">CRC-32 helper</h3>
      <p className="ch-small hd-muted">Select bytes in the hex view by dragging (or shift+click), or type them in hex.</p>
      <div className="hd-row">
        <button type="button" className="hd-button hd-button--small" onClick={fromSelection} disabled={!canUseSelection}>
          CRC of selection{canUseSelection ? ` (${selectionLength} bytes)` : ''}
        </button>
      </div>
      <form className="ch-answer-row" onSubmit={fromTyped}>
        <label className="ch-visually-hidden" htmlFor={inputId}>Bytes in hex</label>
        <input id={inputId} className="hd-input hd-mono ch-answer-input" value={typed} placeholder="49 48 44 52 …"
          autoComplete="off" spellCheck={false} onChange={event => setTyped(event.target.value)} />
        <button type="submit" className="hd-button hd-button--small">CRC of typed bytes</button>
      </form>
      <div aria-live="polite">
        {result?.error && <p className="hd-warning ch-small">{result.error}</p>}
        {result && !result.error && (
          <dl className="hd-kv ch-crc-result">
            <dt>Input</dt><dd>{result.source}</dd>
            <dt>CRC-32</dt><dd className="hd-mono">0x{hex8(result.value)}</dd>
            <dt>As stored in PNG</dt><dd className="hd-mono ch-crc-bytes">{formatHexBytes(u32Bytes(result.value, false))}</dd>
          </dl>
        )}
      </div>
    </section>
  )
}
