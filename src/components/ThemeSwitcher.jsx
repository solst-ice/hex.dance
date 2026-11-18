import { useState, useSyncExternalStore } from 'react'
import { THEMES, applyCrt, applyTheme, currentCrt, currentTheme, subscribeCrt } from './themes'
import useReducedMotion from './useReducedMotion'

/** Colour theme buttons and the CRT mode toggle. */
function ThemeSwitcher() {
  const [theme, setTheme] = useState(currentTheme)
  const crt = useSyncExternalStore(subscribeCrt, currentCrt, () => false)
  const reducedMotion = useReducedMotion()

  return (
    <div className="theme-switcher" role="group" aria-label="Theme">
      {THEMES.map(entry => (
        <button
          key={entry.id}
          type="button"
          className={`theme-swatch theme-swatch--${entry.id}`}
          aria-pressed={theme === entry.id}
          aria-label={`${entry.label} theme`}
          title={`${entry.label} theme`}
          onClick={() => {
            applyTheme(entry.id)
            setTheme(entry.id)
          }}
        />
      ))}
      <button
        type="button"
        className="theme-crt hd-button hd-button--small"
        aria-pressed={crt && !reducedMotion}
        disabled={reducedMotion}
        title={
          reducedMotion
            ? 'CRT mode is off because reduced motion is on'
            : 'CRT mode: a failing tube monitor, with crawling scanlines, static and bursts of tearing and colour split'
        }
        onClick={() => applyCrt(!crt)}
      >
        CRT
      </button>
    </div>
  )
}

export default ThemeSwitcher
