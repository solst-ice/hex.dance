/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useId, useRef, useState } from 'react'

const SOURCE_URL = 'https://github.com/solst-ice/hex.dance'

/**
 * The "Privacy" button and the note it discloses: what happens to the files
 * you open. `variant="inline"` expands in the flow of the landing page;
 * `variant="menu"` opens a panel under the slim header, like the samples
 * menu, so the workspace below does not move, and closes on a click
 * elsewhere. Escape closes either and puts focus back on the button.
 */
function PrivacyNote({ variant = 'inline' }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const buttonRef = useRef(null)
  const id = useId()
  const panelId = `${id}-note`
  const titleId = `${id}-title`

  useEffect(() => {
    if (!open || variant !== 'menu') return
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('focusin', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('focusin', close)
    }
  }, [open, variant])

  return (
    <div
      className={`privacy privacy--${variant}`}
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          // Handled here, so the hex view does not also leave fullscreen
          event.preventDefault()
          setOpen(false)
          buttonRef.current?.focus()
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`hd-button hd-button--small privacy-toggle${open ? ' hd-button--active' : ''}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        Privacy
      </button>
      <section id={panelId} className="privacy-note" aria-labelledby={titleId} hidden={!open}>
        <h2 id={titleId} className="privacy-title">Your files stay on your device</h2>
        <p>
          hex.dance runs entirely in your browser. When you open a file, this page reads it on
          your device. It is never uploaded: there is no server-side processing, and nothing
          about your file is sent anywhere.
        </p>
        <p>
          No analytics, no cookies, no third-party scripts. The page&apos;s security policy stops
          it from connecting to any other site.
        </p>
        <p>
          Your browser remembers a few preferences on this device, such as the theme, which
          sections are collapsed and your progress in Learn. Never file contents.
        </p>
        <p>
          Loading the page is an ordinary request to its host, GitHub Pages, as with any
          website, and so is opening one of the built-in samples or Learn exercises.
          The <a href={SOURCE_URL}>source code</a> is public.
        </p>
      </section>
    </div>
  )
}

export default PrivacyNote
