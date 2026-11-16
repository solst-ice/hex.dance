/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useMemo, useRef, useState } from 'react'
import { FileContext } from './contexts.js'
import { analyzeFile } from '../analysis/client.js'

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

  const openFile = useCallback((file) => {
    if (!file) return
    const request = ++requestRef.current
    const isCurrent = () => request === requestRef.current
    setState({ ...EMPTY, file })
    setRevision(0)

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
  }, [])

  const closeFile = useCallback(() => {
    requestRef.current++
    setState(EMPTY)
    setRevision(0)
  }, [])

  const notifyEdit = useCallback(() => setRevision(previous => previous + 1), [])

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
    notifyEdit
  }), [state, bytes, openFile, closeFile, revision, notifyEdit])

  return <FileContext.Provider value={value}>{children}</FileContext.Provider>
}
