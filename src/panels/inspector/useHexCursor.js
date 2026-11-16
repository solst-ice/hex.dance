import { useEffect, useState } from 'react'

/**
 * The hex view's cursor offset. Shared state only carries the selection
 * (null after a plain click), so the cursor is read from the hex view's
 * `data-cursor` attribute and followed with a MutationObserver.
 *
 * @param {unknown} key   anything that changes when the hex view is replaced (the buffer)
 * @returns {number|null}
 */
export function useHexCursor(key) {
  const [cursor, setCursor] = useState(null)

  useEffect(() => {
    if (!key) return
    let observer = null
    let frame = 0
    let tries = 0

    const read = (element) => {
      const value = Number(element.getAttribute('data-cursor'))
      setCursor(Number.isFinite(value) ? value : null)
    }

    // The hex view mounts in the same commit or shortly after the buffer arrives
    const attach = () => {
      const element = document.querySelector('section.hexview')
      if (!element) {
        if (++tries < 120) frame = requestAnimationFrame(attach)
        return
      }
      read(element)
      observer = new MutationObserver(() => read(element))
      observer.observe(element, { attributes: true, attributeFilter: ['data-cursor'] })
    }
    attach()

    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [key])

  return key ? cursor : null
}
