/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useMemo, useState } from 'react'
import { useHighlightLayer, useSelection } from '../../state/hooks.js'
import { HEX, formatOffset } from '../../components/hex/bytes.js'
import { glitchCopy, pickOffsets, suggestSkip } from './glitch.js'
import useBlobUrl from './useBlobUrl.js'
import MediaView from './MediaView.jsx'

// Each run copies the whole file, so very large images are left out
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_COUNT = 256
const NEW_SEED = () => 1 + Math.floor(Math.random() * 99999)

// What usually happens to each format, so a blank result reads as a lesson rather than a bug
const HOW_IT_BREAKS = {
  'image/png': 'PNG pixels are zlib-compressed and each chunk has a checksum, so one bad byte often blanks out the rest of the image.',
  'image/jpeg': 'JPEG tends to survive: a bad byte smears blocks of colour from that point onwards.',
  'image/gif': 'GIF pixels are LZW-compressed, so a bad byte usually garbles or cuts off everything after it.',
  'image/bmp': 'BMP pixels are stored raw, so each bad byte changes one colour channel of one pixel.'
}

function glitchedName(name) {
  const base = name || 'image'
  const dot = base.lastIndexOf('.')
  return dot > 0 ? `${base.slice(0, dot)}-glitched${base.slice(dot)}` : `${base}-glitched`
}

function Bench({ bytes, revision, media, fileName, originalUrl }) {
  const { jumpTo } = useSelection()
  const size = bytes.length
  const [count, setCount] = useState(8)
  const [skip, setSkip] = useState(() => suggestSkip(bytes, media.mime))
  const [seed, setSeed] = useState(1)
  const [mark, setMark] = useState(true)
  const [result, setResult] = useState(null)

  const room = Math.max(0, size - skip)
  const effectiveCount = Math.min(count, room)

  useEffect(() => {
    const timer = setTimeout(() => {
      const offsets = pickOffsets(size, effectiveCount, skip, seed)
      setResult(glitchCopy(bytes, offsets, seed))
    }, 120)
    return () => clearTimeout(timer)
  }, [bytes, revision, size, effectiveCount, skip, seed])

  const { url } = useBlobUrl(result?.bytes, result, media.mime, 0)

  const ranges = useMemo(() => (mark && result
    ? result.changes.map(c => ({ id: c.offset, start: c.offset, end: c.offset + 1, label: 'Changed in the glitched copy', color: 'var(--pv-glitch)' }))
    : null), [mark, result])
  useHighlightLayer('preview', ranges)

  return (
    <div className="pv-bench hd-stack">
      <div className="pv-controls">
        <label className="pv-field pv-field--wide">
          <span>Bytes to corrupt: {effectiveCount}</span>
          <input type="range" min="1" max={Math.max(1, Math.min(MAX_COUNT, room))} value={Math.max(1, effectiveCount)}
            onChange={e => setCount(Number(e.target.value))} disabled={!room} />
        </label>
        <label className="pv-field">
          <span>Skip header bytes</span>
          <input className="hd-input pv-number" type="number" min="0" max={Math.max(0, size - 1)} value={skip}
            onChange={e => setSkip(Math.max(0, Math.min(size - 1, Math.floor(Number(e.target.value)) || 0)))} />
        </label>
        <label className="pv-field">
          <span>Seed</span>
          <input className="hd-input pv-number" type="number" min="1" value={seed}
            onChange={e => setSeed(Math.max(1, Math.floor(Number(e.target.value)) || 1))} />
        </label>
        <button type="button" className="hd-button hd-button--small" onClick={() => setSeed(NEW_SEED())}>New seed</button>
      </div>
      <p className="pv-note hd-muted">
        Changes {effectiveCount} random {effectiveCount === 1 ? 'byte' : 'bytes'} after the first {skip.toLocaleString()} in a copy.
        The same seed always picks the same bytes. Your file is not changed.
        {HOW_IT_BREAKS[media.mime] ? ` ${HOW_IT_BREAKS[media.mime]}` : ''}
      </p>

      <div className="pv-pair">
        <MediaView url={originalUrl} media={media} caption="Original" />
        <MediaView url={url} media={media} caption="Glitched copy" />
      </div>

      <div className="hd-row">
        {url && (
          <a className="hd-button pv-download" href={url} download={glitchedName(fileName)}>Download glitched file</a>
        )}
        <label className="pv-check">
          <input type="checkbox" checked={mark} onChange={e => setMark(e.target.checked)} />
          Mark changed bytes in the hex view
        </label>
      </div>

      {result && result.changes.length > 0 && (
        <div>
          <h4 className="hd-section-title pv-subtitle">Changed offsets</h4>
          <ul className="pv-changes">
            {result.changes.map(c => (
              <li key={c.offset}>
                <button type="button" className="pv-change" onClick={() => jumpTo(c.offset)}
                  aria-label={`Jump to 0x${formatOffset(c.offset)}, ${HEX[c.from]} became ${HEX[c.to]}`}>
                  <span className="pv-change-offset">{formatOffset(c.offset)}</span>
                  <span className="hd-muted">{HEX[c.from]}→{HEX[c.to]}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function GlitchLab(props) {
  const [open, setOpen] = useState(false)
  const tooBig = props.bytes.length > MAX_FILE_BYTES
  return (
    <section className="pv-lab" aria-label="Glitch lab">
      <div className="hd-row pv-lab-head">
        <h3 className="hd-section-title">Glitch lab</h3>
        {!tooBig && (
          <button type="button" className={`hd-button hd-button--small ${open ? 'hd-button--active' : ''}`}
            aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Close' : 'Open'}
          </button>
        )}
      </div>
      {tooBig
        ? <p className="pv-note hd-muted">The glitch lab works on images up to 32 MB.</p>
        : !open && <p className="pv-note hd-muted">Corrupt a few bytes of a copy and see how the format breaks.</p>}
      {open && !tooBig && <Bench {...props} />}
    </section>
  )
}
