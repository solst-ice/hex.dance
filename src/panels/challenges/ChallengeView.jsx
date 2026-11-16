/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useId, useState } from 'react'
import { useSelection } from '../../state/hooks.js'
import { runCheck } from './challenges.js'
import { hintsRevealed, setHintsRevealed } from './progress.js'
import CrcTool from './CrcTool.jsx'
import { Rich } from './Rich.jsx'

const CHECK_DELAY_MS = 300

// Kept apart so only these buttons re-render when the selection changes
function ShowWhere({ targets, disabled }) {
  const { jumpTo } = useSelection()
  return targets.map(target => (
    <button key={target.label} type="button" className="hd-button hd-button--small ch-where" disabled={disabled}
      onClick={() => jumpTo(target.offset, target.length)}
      aria-label={`Show me where: ${target.label}, ${target.length} ${target.length === 1 ? 'byte' : 'bytes'} at offset 0x${target.offset.toString(16).toUpperCase()}`}>
      {targets.length > 1 ? `Show me: ${target.label}` : 'Show me where'}
    </button>
  ))
}

function AnswerForm({ answer, onSubmit }) {
  const [draft, setDraft] = useState('')
  const inputId = useId()
  const submit = (event) => {
    event.preventDefault()
    onSubmit(draft)
  }

  if (answer.kind === 'choice') {
    return (
      <form className="ch-answer" onSubmit={submit}>
        <fieldset className="ch-choices">
          <legend className="ch-label">{answer.label}</legend>
          {answer.options.map(option => (
            <label key={option.id} className="ch-choice">
              <input type="radio" name="ch-choice" value={option.id} checked={draft === option.id}
                onChange={() => setDraft(option.id)} />
              {option.label}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="hd-button" disabled={!draft}>Check</button>
      </form>
    )
  }

  return (
    <form className="ch-answer" onSubmit={submit}>
      <label className="ch-label" htmlFor={inputId}>{answer.label}</label>
      <div className="ch-answer-row">
        <input id={inputId} className="hd-input hd-mono ch-answer-input" value={draft} autoComplete="off" spellCheck={false}
          placeholder={answer.kind === 'offset' ? 'e.g. 0x1A or 26' : 'flag{…}'}
          onChange={event => setDraft(event.target.value)} />
        <button type="submit" className="hd-button">Check</button>
      </div>
    </form>
  )
}

export default function ChallengeView({
  challenge, number, bytes, revision, headingRef, wasSolved, onSolved, onReset, resetting, next, onNext
}) {
  const [result, setResult] = useState(null)
  const [submission, setSubmission] = useState(null)   // { text } for answer challenges
  const [hints, setHints] = useState(() => hintsRevealed(challenge.id))
  const needsAnswer = Boolean(challenge.answer)

  // Edit challenges re-check by themselves shortly after every edit
  useEffect(() => {
    if (!bytes || needsAnswer) return
    const timer = setTimeout(() => setResult(runCheck(challenge, bytes, undefined)), revision === 0 ? 0 : CHECK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [challenge, bytes, revision, needsAnswer])

  useEffect(() => {
    if (!submission) return
    setResult(runCheck(challenge, bytes, submission.text))
  }, [challenge, bytes, submission])

  const solvedNow = Boolean(result && result.solved)
  useEffect(() => {
    if (solvedNow) onSolved(challenge.id)
  }, [solvedNow, challenge.id, onSolved])

  const revealHint = () => {
    const count = Math.min(hints + 1, challenge.hints.length)
    setHints(count)
    setHintsRevealed(challenge.id, count)
  }

  const checkNow = () => {
    if (bytes) setResult(runCheck(challenge, bytes, undefined))
  }

  const whereLocked = challenge.whereAfterHints && hints < challenge.hints.length
  const progress = result && typeof result.progress === 'number' ? result.progress : null

  return (
    <article className="ch-view" aria-labelledby={`ch-title-${challenge.id}`}>
      <div className="hd-panel-header">
        <h2 className="hd-panel-title" id={`ch-title-${challenge.id}`} ref={headingRef} tabIndex={-1}>
          <span className="ch-title-number">{String(number).padStart(2, '0')}</span> {challenge.title}
        </h2>
        <span className="hd-row ch-meta">
          <span className={`hd-badge ch-diff ch-diff--${challenge.difficulty}`}>{challenge.difficulty}</span>
          {wasSolved && <span className="ch-solved-mark" title="Solved before">✓<span className="ch-visually-hidden"> solved before</span></span>}
        </span>
      </div>

      <div className="ch-brief">
        {challenge.brief.map((paragraph, index) => <p key={index}><Rich text={paragraph} /></p>)}
      </div>

      <p className="ch-goal"><span className="ch-goal-label">Goal</span> <Rich text={challenge.goal} /></p>

      {needsAnswer && <AnswerForm answer={challenge.answer} onSubmit={text => setSubmission({ text })} />}

      <div className={'ch-status' + (solvedNow ? ' is-solved' : '')} aria-live="polite">
        {!bytes && <p className="hd-empty">Loading the challenge file…</p>}
        {bytes && result && (
          <>
            {progress !== null && !solvedNow && (
              <div className="ch-progress" role="progressbar" aria-label="Progress"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                <span style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
            <p className="ch-message">{solvedNow && <strong>Solved. </strong>}<Rich text={result.message} /></p>
          </>
        )}
      </div>

      <div className="hd-row ch-actions">
        {!needsAnswer && <button type="button" className="hd-button hd-button--small" onClick={checkNow} disabled={!bytes}>Check</button>}
        <ShowWhere targets={challenge.where} disabled={!bytes || whereLocked} />
        <button type="button" className="hd-button hd-button--small" onClick={onReset} disabled={resetting}>
          {resetting ? 'Resetting…' : 'Reset'}
        </button>
      </div>
      {whereLocked && <p className="hd-muted ch-small">“Show me where” unlocks after the last hint.</p>}

      <section className="ch-hints" aria-label="Hints">
        {hints > 0 && (
          <ol className="ch-hint-list">
            {challenge.hints.slice(0, hints).map((hint, index) => <li key={index}><Rich text={hint} /></li>)}
          </ol>
        )}
        {hints < challenge.hints.length && (
          <button type="button" className="hd-button hd-button--small" onClick={revealHint}>
            {hints === 0 ? 'Show a hint' : 'Next hint'} ({hints + 1} of {challenge.hints.length})
          </button>
        )}
      </section>

      {challenge.tools?.includes('crc') && <CrcTool bytes={bytes} />}

      {solvedNow && (
        <section className="ch-learned" aria-label="What you learned">
          <h3 className="hd-section-title">What you learned</h3>
          {challenge.learned.map((paragraph, index) => <p key={index}><Rich text={paragraph} /></p>)}
          {challenge.spec && (
            <p className="ch-small">
              Further reading: <a href={challenge.spec.href} target="_blank" rel="noopener noreferrer">{challenge.spec.label}</a>
            </p>
          )}
          {next
            ? <button type="button" className="hd-button" onClick={onNext}>Next: {next.title}</button>
            : <p className="ch-small">That was the last unsolved challenge. Well done!</p>}
        </section>
      )}
    </article>
  )
}
