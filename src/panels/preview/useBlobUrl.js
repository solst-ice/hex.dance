import { useEffect, useRef, useState } from 'react'
import { passiveType } from './passive.js'

// A replaced URL is revoked a little later, so an element still showing it
// can finish switching to the new one
const REVOKE_DELAY_MS = 2000

/**
 * A `blob:` URL for the current bytes, rebuilt (debounced) whenever `version`
 * changes. Every URL it made is revoked once replaced or on unmount. A type
 * that could run as a page (SVG, HTML, XML) is labelled as plain bytes
 * instead, see passive.js; SVG is shown through useSvgImage.
 *
 * @returns {{ url: string|null, version: * }}
 */
export default function useBlobUrl(bytes, version, type, delayMs) {
  const [state, setState] = useState({ url: null, version: null, bytes: null })
  const current = useRef(null)

  useEffect(() => {
    if (!bytes || !type) return
    const build = () => {
      const url = URL.createObjectURL(new Blob([bytes], { type: passiveType(type) }))
      const previous = current.current
      current.current = url
      setState({ url, version, bytes })
      if (previous) setTimeout(() => URL.revokeObjectURL(previous), REVOKE_DELAY_MS)
    }
    // The first URL for these bytes is made at once; edits are debounced
    const timer = setTimeout(build, current.current ? delayMs : 0)
    return () => clearTimeout(timer)
  }, [bytes, version, type, delayMs])

  useEffect(() => () => {
    if (current.current) URL.revokeObjectURL(current.current)
    current.current = null
  }, [])

  return state.bytes === bytes ? state : { url: null, version: null }
}
