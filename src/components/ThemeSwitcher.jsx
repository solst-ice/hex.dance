import { useState } from 'react'
import { THEMES, applyCrt, applyTheme, currentCrt, currentTheme } from './themes'
import useReducedMotion from './useReducedMotion'

/** Colour theme buttons and the CRT scanline toggle. */
function ThemeSwitcher() {
  const [theme, setTheme] = useState(currentTheme)
  const [crt, setCrt] = useState(currentCrt)
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
        title={reducedMotion ? 'Scanlines are off because reduced motion is on' : 'CRT scanlines'}
        onClick={() => {
          applyCrt(!crt)
          setCrt(!crt)
        }}
      >
        CRT
      </button>
    </div>
  )
}

export default ThemeSwitcher
