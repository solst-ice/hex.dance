/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFile } from '../../state/hooks.js'
import { CHALLENGES, challengeById } from './challenges.js'
import { challengeIdForFile, loadSolved, rememberChallengeFile, saveSolved } from './progress.js'
import ChallengeView from './ChallengeView.jsx'
import { Rich } from './Rich.jsx'
import './challenges.css'

// Set just before a challenge file opens; the panel remounts for the new file
// and moves focus to the challenge heading so keyboard users are not lost.
let focusNextMount = false

async function fetchChallengeFile(challenge) {
  const response = await fetch(`${import.meta.env.BASE_URL}challenges/${challenge.file}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const buffer = await response.arrayBuffer()
  return new File([buffer], challenge.fileName, { type: challenge.type })
}

function ChallengeList({ solved, activeId, confirmId, loadingId, currentName, onStart, onConfirm, onCancel }) {
  return (
    <ol className="ch-list">
      {CHALLENGES.map((challenge, index) => {
        const isSolved = solved.has(challenge.id)
        const isActive = challenge.id === activeId
        return (
          <li key={challenge.id} className={'ch-item' + (isActive ? ' is-active' : '')}>
            <div className="ch-item-main">
              <span className="ch-item-number hd-mono" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <div className="ch-item-text">
                <span className="ch-item-title">{challenge.title}</span>
                <span className="ch-item-meta">
                  <span className={`hd-badge ch-diff ch-diff--${challenge.difficulty}`}>{challenge.difficulty}</span>
                  <span className="hd-muted">{challenge.teaches}</span>
                </span>
              </div>
              {isSolved && <span className="ch-solved-mark" title="Solved">✓<span className="ch-visually-hidden"> solved</span></span>}
              {!isActive && confirmId !== challenge.id && (
                <button type="button" className="hd-button hd-button--small" disabled={loadingId !== null}
                  onClick={() => onStart(challenge)} aria-label={`${isSolved ? 'Replay' : 'Start'} ${challenge.title}`}>
                  {loadingId === challenge.id ? 'Opening…' : isSolved ? 'Replay' : 'Start'}
                </button>
              )}
              {isActive && <span className="hd-badge hd-badge--yellow">Open</span>}
            </div>
            {confirmId === challenge.id && (
              <div className="ch-confirm" role="alert">
                <p>This replaces {currentName ? <strong className="hd-mono">{currentName}</strong> : 'the file'} in the hex view. Edits you have not downloaded will be lost.</p>
                <div className="hd-row">
                  <button type="button" className="hd-button hd-button--small" onClick={() => onConfirm(challenge)}>Open challenge</button>
                  <button type="button" className="hd-button hd-button--small" onClick={onCancel}>Cancel</button>
                </div>
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

export default function Challenges() {
  const { file, bytes, status, revision, openFile } = useFile()
  const [solved, setSolved] = useState(loadSolved)
  const [confirmId, setConfirmId] = useState(null)
  const [loadingId, setLoadingId] = useState(null)
  const [error, setError] = useState(null)
  const mounted = useRef(true)
  const headingRef = useRef(null)

  const activeId = challengeIdForFile(file)
  const active = challengeById(activeId)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      focusNextMount = false
    }
  }, [])

  // After this panel loads a challenge file, move focus to its heading. Only
  // a load started here sets the flag, and it is cleared at once, so the
  // panel never takes focus just for being mounted.
  useEffect(() => {
    if (focusNextMount && headingRef.current) headingRef.current.focus({ preventScroll: true })
    focusNextMount = false
  }, [file])

  const open = useCallback(async (challenge) => {
    setConfirmId(null)
    setError(null)
    setLoadingId(challenge.id)
    try {
      const next = await fetchChallengeFile(challenge)
      rememberChallengeFile(next, challenge.id)
      focusNextMount = true
      openFile(next)
    } catch {
      if (mounted.current) setError(`Could not load the “${challenge.title}” file.`)
    } finally {
      if (mounted.current) setLoadingId(null)
    }
  }, [openFile])

  const requestStart = (challenge) => {
    // Nothing to lose when the open file is an untouched challenge
    if (active && revision === 0) open(challenge)
    else setConfirmId(challenge.id)
  }

  const markSolved = useCallback((id) => {
    setSolved(previous => {
      if (previous.has(id)) return previous
      const next = new Set(previous)
      next.add(id)
      saveSolved(next)
      return next
    })
  }, [])

  const resetProgress = () => {
    const empty = new Set()
    saveSolved(empty)
    setSolved(empty)
  }

  const nextChallenge = active
    ? CHALLENGES.slice(CHALLENGES.indexOf(active) + 1).find(c => !solved.has(c.id)) ||
      CHALLENGES.find(c => !solved.has(c.id) && c !== active) ||
      null
    : null

  return (
    <div className="hd-panel ch-panel">
      {active ? (
        <ChallengeView
          key={active.id}
          challenge={active}
          number={CHALLENGES.indexOf(active) + 1}
          bytes={status === 'error' ? null : bytes}
          revision={revision}
          headingRef={headingRef}
          wasSolved={solved.has(active.id)}
          onSolved={markSolved}
          onReset={() => open(active)}
          resetting={loadingId === active.id}
          next={nextChallenge}
          onNext={() => nextChallenge && open(nextChallenge)}
        />
      ) : (
        <div className="hd-panel-header">
          <span className="hd-muted">{solved.size} of {CHALLENGES.length} solved</span>
        </div>
      )}

      {!active && (
        <p className="ch-intro">
          <Rich text="Small puzzles that teach how files work. Each one opens a file made for it; you fix or explore it in the hex view, and this tab checks your work as you go." />
        </p>
      )}

      {active && <h3 className="hd-section-title">All challenges <span className="hd-muted ch-count">{solved.size} of {CHALLENGES.length} solved</span></h3>}

      {error && <p className="hd-warning" role="alert">{error}</p>}

      <ChallengeList
        solved={solved}
        activeId={activeId}
        confirmId={confirmId}
        loadingId={loadingId}
        currentName={file?.name}
        onStart={requestStart}
        onConfirm={open}
        onCancel={() => setConfirmId(null)}
      />

      {solved.size > 0 && (
        <p className="ch-forget">
          <button type="button" className="ch-link-button" onClick={resetProgress}>Forget my progress</button>
        </p>
      )}
    </div>
  )
}
