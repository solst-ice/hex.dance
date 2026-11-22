/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useMemo, useRef, useState } from 'react'
import { FileContext, PosterPinsContext, UnsavedEditsContext } from './contexts.js'
import { createPosterPins } from './posterPins.js'
import { createEditTracker, nextOpenStep } from './unsavedEdits.js'
import { analyzeFile } from '../analysis/client.js'
import { downloadName } from '../components/hex/bytes.js'
import { downloadBytes } from '../lib/download.js'

const EMPTY = { file: null, buffer: null, analysis: null, error: null }

function statusOf({ file, buffer, analysis, error }) {
  if (!file) return 'idle'
  if (error) return 'error'
  if (!buffer) return 'reading'
  return analysis ? 'ready' : 'analyzing'
}

export default function FileProvider({ children }) {
  const [state, setState] = useState(EMPTY)
  const [revision, setRevision] = useState(0)
  const requestRef = useRef(0)
  // Whether edits would be lost lives here, next to openFile, which has to
  // ask about them. It is a store rather than state: typing a byte only
  // updates it, and only its subscribers hear, and only when the answer flips.
  const [edits] = useState(createEditTracker)
  // Pins belong to the file as opened: edits do not change the field tree,
  // so they survive edits, and opening another file empties them
  const [pins] = useState(createPosterPins)
  const [pending, setPending] = useState(null)
  const pendingRef = useRef(null)
  const latest = useRef(state)
  latest.current = state

  const load = useCallback((file) => {
    const request = ++requestRef.current
    const isCurrent = () => request === requestRef.current
    setState({ ...EMPTY, file })
    setRevision(0)
    edits.reset()
    pins.reset()

    // The hex view only needs the bytes, so it appears as soon as they are
    // read; the analysis arrives separately from the worker.
    file.arrayBuffer().then(
      buffer => isCurrent() && setState(previous => ({ ...previous, buffer })),
      error => isCurrent() && setState(previous => ({ ...previous, error }))
    )
    analyzeFile(file).then(
      analysis => isCurrent() && setState(previous => ({ ...previous, analysis })),
      error => isCurrent() && setState(previous => ({ ...previous, error }))
    )
  }, [edits, pins])

  const step = useCallback((action) => {
    const next = nextOpenStep(pendingRef.current, action)
    pendingRef.current = next.pending
    setPending(next.pending)
    if (next.download) {
      // The same bytes and name as the hex view's Download button
      const { file, buffer } = latest.current
      if (buffer) {
        downloadBytes(new Uint8Array(buffer), downloadName(file?.name))
        edits.saved()
      }
    }
    if (next.open) {
      next.open.onOpen?.()
      load(next.open.file)
    }
  }, [edits, load])

  // With unsaved edits the request waits for an answer (see UnsavedEdits.jsx),
  // and a later request replaces it. `onOpen` runs just before the file is
  // actually opened, and never if the reader keeps editing.
  const openFile = useCallback((file, { onOpen } = {}) => {
    if (!file) return
    step({ type: 'request', file, onOpen, unsaved: edits.isUnsaved() })
  }, [edits, step])

  const answerOpen = useCallback((answer) => step({ type: answer }), [step])

  // Nothing in the interface closes the file; whatever starts to will have
  // to ask about unsaved edits first, the way openFile does
  const closeFile = useCallback(() => {
    requestRef.current++
    pendingRef.current = null
    setPending(null)
    setState(EMPTY)
    setRevision(0)
    edits.reset()
    pins.reset()
  }, [edits, pins])

  const notifyEdit = useCallback((edit) => {
    if (Number.isFinite(edit?.modifiedCount)) edits.edited(edit.modifiedCount)
    setRevision(previous => previous + 1)
  }, [edits])

  const notifySaved = useCallback(() => edits.saved(), [edits])

  const bytes = useMemo(() => (state.buffer ? new Uint8Array(state.buffer) : null), [state.buffer])

  const value = useMemo(() => ({
    file: state.file,
    buffer: state.buffer,
    bytes,
    status: statusOf(state),
    analysis: state.analysis,
    error: state.error,
    openFile,
    closeFile,
    revision,
    notifyEdit,
    notifySaved
  }), [state, bytes, openFile, closeFile, revision, notifyEdit, notifySaved])

  const fileName = state.file?.name ?? null
  const unsaved = useMemo(() => ({
    fileName,
    pending,
    answerOpen,
    isUnsaved: edits.isUnsaved,
    getModifiedCount: edits.getModifiedCount,
    subscribe: edits.subscribe
  }), [fileName, pending, answerOpen, edits])

  return (
    <FileContext.Provider value={value}>
      <UnsavedEditsContext.Provider value={unsaved}>
        <PosterPinsContext.Provider value={pins}>{children}</PosterPinsContext.Provider>
      </UnsavedEditsContext.Provider>
    </FileContext.Provider>
  )
}
