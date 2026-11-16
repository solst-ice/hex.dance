/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from './useReducedMotion'

const TEXT = 'HEX.DANCE'
const BYTES = [...TEXT].map(char => char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
const STEP_MS = 90
const START_DELAY_MS = 350
const GLITCH_MS = 700

// The first `resolved` characters as text, the rest still as hex pairs
function decoded(resolved) {
  const head = TEXT.slice(0, resolved)
  const tail = BYTES.slice(resolved).join(' ')
  return head && tail ? `${head} ${tail}` : head || tail
}

/**
 * Site title. On first load it decodes from its own bytes; afterwards the
 * glitch plays on hover and whenever `glitchKey` changes (a file is opened).
 * The heading always contains the real text; the animated copies are hidden
 * from assistive technology.
 */
function Title({ glitchKey }) {
  const [resolved, setResolved] = useState(() => (prefersReducedMotion() ? TEXT.length : 0))
  const [glitching, setGlitching] = useState(false)
  const firstKey = useRef(glitchKey)

  useEffect(() => {
    if (resolved >= TEXT.length) return
    const timer = setTimeout(() => setResolved(resolved + 1), resolved === 0 ? START_DELAY_MS : STEP_MS)
    return () => clearTimeout(timer)
  }, [resolved])

  useEffect(() => {
    if (glitchKey === firstKey.current || !glitchKey) return
    firstKey.current = glitchKey
    setGlitching(true)
    const timer = setTimeout(() => setGlitching(false), GLITCH_MS)
    return () => clearTimeout(timer)
  }, [glitchKey])

  const decoding = resolved < TEXT.length
  const classes = ['glitch-title', decoding ? 'is-decoding' : '', glitching ? 'is-glitching' : ''].filter(Boolean).join(' ')

  return (
    <h1 className={classes} data-text={TEXT}>
      <span className="glitch-title-text">{TEXT}</span>
      {decoding && <span className="glitch-title-decode" aria-hidden="true">{decoded(resolved)}</span>}
    </h1>
  )
}

export default Title
