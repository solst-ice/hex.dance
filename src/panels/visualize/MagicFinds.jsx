/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useState } from 'react'
import { useSelectionActions } from '../../state/hooks.js'
import { HEX, formatOffset } from '../../components/hex/bytes.js'
import { MAGIC_CONSTANTS, expectedByChance } from './magic.js'

const OFFSETS_SHOWN = 24

function chanceText(expected) {
  if (expected >= 0.995) return `about ${Math.round(expected).toLocaleString()} expected by chance`
  if (expected >= 0.01) return `${expected.toFixed(2)} expected by chance`
  return 'very unlikely by chance'
}

function Offsets({ hit }) {
  const { jumpTo } = useSelectionActions()
  const [all, setAll] = useState(false)
  const shown = all ? hit.offsets : hit.offsets.slice(0, OFFSETS_SHOWN)
  const hiddenListed = hit.offsets.length - shown.length
  const unlisted = hit.count - hit.offsets.length
  return (
    <div className="viz-offsets">
      {shown.map(offset => (
        <button
          key={offset}
          type="button"
          className="hd-button hd-button--small viz-offset"
          onClick={() => jumpTo(offset, hit.bytes.length)}
          aria-label={`Jump to 0x${formatOffset(offset)}`}
        >
          {formatOffset(offset)}
        </button>
      ))}
      {hiddenListed > 0 && (
        <button type="button" className="hd-button hd-button--small" onClick={() => setAll(true)}>
          Show {hiddenListed} more
        </button>
      )}
      {hiddenListed === 0 && unlisted > 0 && (
        <span className="hd-muted">and {unlisted.toLocaleString()} more not listed</span>
      )}
    </div>
  )
}

function MagicFinds({ pass, size }) {
  if (!pass.magic) {
    return <p className="hd-empty">Scanning…</p>
  }
  const hits = pass.magic
  return (
    <div className="viz-magic hd-stack">
      <p className="viz-note hd-muted">
        Looks for {MAGIC_CONSTANTS.length} well-known constants in both byte orders
        (BE: as written, LE: reversed, as a little-endian CPU stores it).
        {pass.plan?.sampled ? ' Only the sampled blocks were scanned.' : ' The whole file was scanned.'}
      </p>
      {hits.length === 0 && <p className="hd-empty">None of the known constants appear in this file.</p>}
      {hits.map(hit => (
        <article key={`${hit.hex}-${hit.order}`} className="viz-hit">
          <header className="hd-row">
            <span className="viz-hit-name hd-mono">0x{hit.hex}</span>
            <span className={`hd-badge ${hit.order === 'LE' ? 'hd-badge--pink' : ''}`} title={hit.bytes.map(v => HEX[v]).join(' ')}>
              {hit.order} {hit.bytes.map(v => HEX[v]).join(' ')}
            </span>
            <span className="hd-muted">
              {hit.count.toLocaleString()} {hit.count === 1 ? 'hit' : 'hits'}, {chanceText(expectedByChance(pass.plan?.covered ?? size, hit.bytes.length))}
            </span>
          </header>
          <p className="viz-hit-note">{hit.note}</p>
          <Offsets hit={hit} />
        </article>
      ))}
    </div>
  )
}

export default memo(MagicFinds)
