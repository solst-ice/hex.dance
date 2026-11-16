/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useId, useRef, useState } from 'react'
import { COPY_FORMATS, CLIPBOARD_LIMIT, formatSize, rangeFileName } from './copyAs.js'
import { copyText } from '../../lib/clipboard.js'
import { downloadBytes } from '../../lib/download.js'

/**
 * "Copy as" button and menu for a byte range.
 * @param {{ bytes: Uint8Array, range: { start: number, end: number }|null, fileName: string, onStatus: (text: string) => void }} props
 */
export default function CopyMenu({ bytes, range, fileName, onStatus }) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const rootRef = useRef(null)
  const buttonRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (open) rootRef.current?.querySelector('[role="menuitem"]')?.focus()
  }, [open])

  const length = range ? range.end - range.start : 0
  const tooBig = length > CLIPBOARD_LIMIT

  const close = () => {
    setOpen(false)
    buttonRef.current?.focus()
  }

  const copy = async (format) => {
    close()
    if (!range) return
    if (tooBig) {
      onStatus(`Copying is limited to ${formatSize(CLIPBOARD_LIMIT)}; this selection is ${formatSize(length)}. Save it to a file instead.`)
      return
    }
    const text = format.format(bytes.subarray(range.start, range.end))
    const ok = await copyText(text)
    onStatus(ok
      ? `Copied ${formatSize(length)} as ${format.label}`
      : 'The browser did not allow copying to the clipboard')
  }

  const save = () => {
    close()
    if (!range) return
    downloadBytes(bytes.subarray(range.start, range.end), rangeFileName(fileName, range.start, range.end))
    onStatus(`Saved ${formatSize(length)} as ${rangeFileName(fileName, range.start, range.end)}`)
  }

  const onMenuKeyDown = (event) => {
    const items = Array.from(rootRef.current.querySelectorAll('[role="menuitem"]'))
    const index = items.indexOf(document.activeElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(index + step + items.length) % items.length]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="insp-copy" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="hd-button hd-button--small insp-copy-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={!range}
        onClick={() => setOpen(!open)}
        title={range ? `Copy or save ${formatSize(length)}` : 'Nothing selected'}
      >
        Copy as
      </button>
      {open && (
        <div className="insp-menu" role="menu" id={menuId} aria-label="Copy selection as" onKeyDown={onMenuKeyDown}>
          {tooBig && (
            <p className="insp-menu-note">
              Clipboard formats are limited to {formatSize(CLIPBOARD_LIMIT)}; this selection is {formatSize(length)}.
            </p>
          )}
          {COPY_FORMATS.map(format => (
            <button
              key={format.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="insp-menu-item"
              aria-disabled={tooBig || undefined}
              onClick={() => copy(format)}
            >
              {format.label}
            </button>
          ))}
          <button type="button" role="menuitem" tabIndex={-1} className="insp-menu-item insp-menu-save" onClick={save}>
            Save selection to a file
          </button>
        </div>
      )}
    </div>
  )
}
