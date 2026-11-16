/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useRef, useState } from 'react'
import { copyText } from '../lib/clipboard.js'
import './copy.css'

/**
 * Small button that copies `getText()` (or `text`) and briefly confirms.
 */
function CopyButton({ text, getText, label = 'Copy', ariaLabel, disabled, className = '' }) {
  const [state, setState] = useState('idle')
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  const onClick = async () => {
    const value = getText ? getText() : text
    if (value === null || value === undefined) return
    const ok = await copyText(String(value))
    setState(ok ? 'copied' : 'failed')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1500)
  }

  return (
    <>
      <button
        type="button"
        className={`hd-button hd-button--small hd-copy ${className}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : label}
      </button>
      <span className="hd-copy-status" role="status">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Could not copy' : ''}
      </span>
    </>
  )
}

export default CopyButton
