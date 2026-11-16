/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useId, useRef, useState } from 'react'
import { SAMPLES, fetchSample } from './samples'

// Once the hex view appears, give it focus so keyboard users land in the data
function focusHexViewWhenReady() {
  const deadline = performance.now() + 3000
  const attempt = () => {
    const body = document.querySelector('.hexview .hx-body')
    if (body) body.focus({ preventScroll: true })
    else if (performance.now() < deadline) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}

function useSampleLoader(onFile) {
  const [loading, setLoading] = useState(null)
  const [error, setError] = useState(null)

  const load = async (sample, { focusHex = false } = {}) => {
    setLoading(sample.id)
    setError(null)
    try {
      const file = await fetchSample(sample, import.meta.env.BASE_URL)
      onFile(file)
      if (focusHex) focusHexViewWhenReady()
    } catch {
      setError(`Could not load the ${sample.label} sample.`)
    } finally {
      setLoading(null)
    }
  }
  return { load, loading, error }
}

/**
 * Buttons that open a built-in sample file. `variant="row"` is the landing
 * page row; `variant="menu"` is a compact disclosure for the file bar.
 */
function SampleFiles({ onFile, variant = 'row' }) {
  const { load, loading, error } = useSampleLoader(onFile)
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const toggleRef = useRef(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('focusin', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('focusin', close)
    }
  }, [open])

  const buttons = SAMPLES.map(sample => (
    <li key={sample.id}>
      <button
        type="button"
        className="hd-button hd-button--small sample-button"
        title={sample.about}
        aria-describedby={variant === 'row' ? `${menuId}-${sample.id}` : undefined}
        disabled={loading !== null}
        onClick={(event) => {
          const hadFocus = document.activeElement === event.currentTarget
          setOpen(false)
          load(sample, { focusHex: variant === 'row' && hadFocus })
        }}
      >
        {loading === sample.id ? '…' : sample.label}
      </button>
      {variant === 'row' && <span id={`${menuId}-${sample.id}`} hidden>{sample.about}</span>}
      {variant === 'menu' && <span className="sample-about">{sample.about}</span>}
    </li>
  ))

  if (variant === 'menu') {
    return (
      <div
        className="sample-menu"
        ref={rootRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            setOpen(false)
            toggleRef.current?.focus()
          }
        }}
      >
        <button
          ref={toggleRef}
          type="button"
          className={`hd-button hd-button--small${open ? ' hd-button--active' : ''}`}
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen(!open)}
        >
          Samples
        </button>
        <ul id={menuId} className="sample-menu-list" hidden={!open} aria-label="Sample files">
          {buttons}
        </ul>
        {error && <span className="hd-warning sample-error" role="status">{error}</span>}
      </div>
    )
  }

  return (
    <div className="sample-row">
      <span className="sample-row-label" id={`${menuId}-label`}>No file at hand? Try a sample:</span>
      <ul className="sample-row-list" aria-labelledby={`${menuId}-label`}>
        {buttons}
      </ul>
      <span className="hd-warning sample-error" role="status">{error}</span>
    </div>
  )
}

export default SampleFiles
