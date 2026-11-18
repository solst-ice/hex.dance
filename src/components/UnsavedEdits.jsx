/* eslint-disable react/prop-types -- the project does not use prop-types */
import { memo, useEffect, useId, useLayoutEffect, useRef } from 'react'
import { useHasUnsavedEdits, useUnsavedEdits } from '../state/hooks.js'
import { downloadName } from './hex/bytes.js'
import { visibleText } from '../lib/visibleText.js'

// Asks the browser to confirm leaving the page while there are edits to lose.
// The listener only exists while it is needed: a page with a beforeunload
// listener is kept out of the back/forward cache.
function useLeaveWarning(active) {
  useEffect(() => {
    if (!active) return
    const warn = (event) => {
      event.preventDefault()
      // Older browsers only show the prompt when returnValue is set
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [active])
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * The question asked when another file would replace one with unsaved
 * edits. A modal <dialog> sits above everything (the sticky header, the hex
 * view in fullscreen), keeps focus inside and gives focus back afterwards.
 */
function OpenQuestion({ request, fileName, modifiedCount, onAnswer }) {
  const dialogRef = useRef(null)
  const keepRef = useRef(null)
  const answered = useRef(false)
  const titleId = useId()
  const textId = useId()

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    const returnTo = document.activeElement
    dialog.showModal()
    keepRef.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
      // Back to where the reader was; preventScroll keeps the page where it was
      if (returnTo instanceof HTMLElement && returnTo !== document.body && returnTo.isConnected) {
        returnTo.focus({ preventScroll: true })
      }
      // The control that asked may have gone or been hidden (a menu that
      // closed on its choice): then the hex view, rather than nowhere. Focus
      // can still be on a button of the closed dialog, which loses it later.
      const active = document.activeElement
      if (!active || active === document.body || dialog.contains(active)) {
        document.querySelector('.hexview .hx-body')?.focus({ preventScroll: true })
      }
    }
  }, [])

  const answer = (choice) => {
    if (answered.current) return
    answered.current = true
    onAnswer(choice)
  }

  // A new request replaces the one on screen: it can be answered afresh
  useEffect(() => {
    answered.current = false
  }, [request])

  const onKeyDown = (event) => {
    // Handled here, before the hex view's fullscreen sees it on the document
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      answer('keep')
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="unsaved-dialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      onKeyDown={onKeyDown}
      // Any other way of closing it (a close request from the system) keeps editing
      onCancel={(event) => { event.preventDefault(); answer('keep') }}
      onClose={() => answer('keep')}
    >
      <h2 className="unsaved-title" id={titleId}>Unsaved edits</h2>
      <div id={textId}>
        <p>
          <strong className="unsaved-name">{visibleText(fileName)}</strong> has {plural(modifiedCount, 'modified byte')} that
          you have not downloaded. Opening <strong className="unsaved-name">{visibleText(request.file.name)}</strong> replaces
          it, and the edits will be lost.
        </p>
        <p className="unsaved-hint">
          Downloading saves the edited copy as <span className="unsaved-name">{visibleText(downloadName(fileName))}</span> first.
        </p>
      </div>
      <div className="unsaved-actions">
        <button ref={keepRef} type="button" className="hd-button unsaved-keep" onClick={() => answer('keep')}>
          Keep editing
        </button>
        <button type="button" className="hd-button unsaved-download" onClick={() => answer('download')}>
          Download, then open
        </button>
        <button type="button" className="hd-button unsaved-discard" onClick={() => answer('discard')}>
          Discard edits and open
        </button>
      </div>
    </dialog>
  )
}

/**
 * Guards edits that have not been downloaded: the browser asks before the
 * page is left, and opening another file asks first (see FileProvider).
 * Memoised and without props, so it does not re-render with its parent on
 * every edit, only when the answer or the pending request changes.
 */
function UnsavedEdits() {
  const unsaved = useHasUnsavedEdits()
  // Not useFile: that changes on every edit, and this need not re-render then
  const { pending, answerOpen, getModifiedCount, fileName } = useUnsavedEdits()
  useLeaveWarning(unsaved)

  if (!pending) return null
  return (
    <OpenQuestion
      request={pending}
      fileName={fileName || 'file'}
      modifiedCount={getModifiedCount()}
      onAnswer={answerOpen}
    />
  )
}

export default memo(UnsavedEdits)
