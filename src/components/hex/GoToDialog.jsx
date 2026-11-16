/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useId, useState } from 'react'

function GoToDialog({ onSubmit, onClose }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(null)
  const inputId = useId()

  const submit = e => {
    e.preventDefault()
    const problem = onSubmit(value)
    if (problem) setError(problem)
  }

  const onKeyDown = e => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <form className="hx-goto" role="dialog" aria-label="Go to offset" onSubmit={submit} onKeyDown={onKeyDown}>
      <label htmlFor={inputId}>Go to offset</label>
      <input
        id={inputId}
        autoFocus
        autoComplete="off"
        spellCheck="false"
        placeholder="0x1F40, 1F40h, 8000, +16"
        value={value}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? inputId + '-err' : undefined}
        onChange={e => { setValue(e.target.value); setError(null) }}
      />
      <button type="submit" className="hx-btn">GO</button>
      <button type="button" className="hx-btn" onClick={onClose}>CANCEL</button>
      {error && <p className="hx-goto-error" id={inputId + '-err'} role="alert">{error}</p>}
    </form>
  )
}

export default GoToDialog
