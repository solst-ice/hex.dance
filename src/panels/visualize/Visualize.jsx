/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useState } from 'react'
import { useFile, useHexViewport } from '../../state/hooks.js'
import { formatBytes } from '../../formats/shared.js'
import ByteMap from './ByteMap.jsx'
import Digraph from './Digraph.jsx'
import Hilbert from './Hilbert.jsx'
import MagicFinds from './MagicFinds.jsx'
import { useByteClassColors } from '../../lib/canvasColors.js'
import { SAMPLE_BLOCK_BYTES } from './stats.js'
import useFilePass from './useFilePass.js'
import './visualize.css'

const VIEWS = [
  ['bytemap', 'Byte map'],
  ['digraph', 'Digraph'],
  ['hilbert', 'Hilbert'],
  ['magic', 'Hexspeak']
]

function PassStatus({ pass, size }) {
  if (pass.status === 'error') return <p className="hd-warning">Could not compute these views: {pass.error}</p>
  if (pass.status === 'idle' || !pass.plan) return <p className="viz-status hd-muted">Starting…</p>
  const { plan } = pass
  const done = pass.status === 'done'
  const fraction = plan.covered ? Math.min(1, (pass.bytesSeen || 0) / plan.covered) : 0
  const scope = plan.sampled
    ? `Sampled ${plan.chunks.length.toLocaleString()} evenly spaced ${formatBytes(SAMPLE_BLOCK_BYTES)} blocks (${formatBytes(plan.covered)} of ${formatBytes(size)})`
    : `All ${size.toLocaleString()} bytes`
  return (
    <div className="viz-status" data-state={pass.status} data-total-ms={done ? Math.round(pass.totalMs) : undefined} data-first-ms={pass.firstMs != null ? Math.round(pass.firstMs) : undefined}>
      {!done && (
        <div className="viz-progress" role="progressbar" aria-label="Reading the file" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <span style={{ width: `${fraction * 100}%` }} />
        </div>
      )}
      <p className="hd-muted">
        {scope}{done ? `, read in ${(pass.totalMs / 1000).toFixed(pass.totalMs < 1000 ? 2 : 1)} s.` : `: ${Math.round(fraction * 100)}% read…`}
      </p>
    </div>
  )
}

function Visualize() {
  const { bytes, revision } = useFile()
  const [view, setView] = useState('bytemap')
  const colors = useByteClassColors()
  const [passWanted, setPassWanted] = useState(false)
  const viewport = useHexViewport()
  const pass = useFilePass(bytes, revision, passWanted)

  if (!bytes) return <section className="hd-panel"><p className="hd-empty">Reading file…</p></section>
  if (!bytes.length) return <section className="hd-panel"><p className="hd-empty">This file is empty, so there is nothing to draw.</p></section>

  const choose = (id) => {
    setView(id)
    if (id !== 'bytemap') setPassWanted(true)
  }

  return (
    <section className="hd-panel visualize-panel" data-view={view}>
      <div className="viz-switch" role="group" aria-label="Visualization">
        {VIEWS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`hd-button hd-button--small ${view === id ? 'hd-button--active' : ''}`}
            aria-pressed={view === id}
            onClick={() => choose(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'bytemap' && <ByteMap bytes={bytes} revision={revision} colors={colors} viewport={viewport} />}
      {view !== 'bytemap' && <PassStatus pass={pass} size={bytes.length} />}
      {view === 'digraph' && <Digraph pass={pass} />}
      {view === 'hilbert' && <Hilbert size={bytes.length} pass={pass} colors={colors} viewport={viewport} />}
      {view === 'magic' && <MagicFinds pass={pass} size={bytes.length} />}
    </section>
  )
}

export default Visualize
