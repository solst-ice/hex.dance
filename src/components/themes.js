// Keep in sync with public/theme-init.js, which applies the saved choice
// before the first paint
export const THEME_KEY = 'hexdance.theme'
export const CRT_KEY = 'hexdance.crt'

export const THEMES = [
  { id: 'neon', label: 'Neon', color: '#060714' },
  { id: 'amber', label: 'Amber terminal', color: '#0c0803' },
  { id: 'green', label: 'Green phosphor', color: '#020904' },
  { id: 'tui', label: 'Text mode', color: '#000000' }
]

function read(key) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the choice then lasts for this page only
  }
}

export function currentTheme() {
  const id = document.documentElement.dataset.theme || read(THEME_KEY)
  return THEMES.some(theme => theme.id === id) ? id : 'neon'
}

export function currentCrt() {
  return document.documentElement.dataset.crt === 'on'
}

export function applyTheme(id) {
  const theme = THEMES.find(entry => entry.id === id) || THEMES[0]
  document.documentElement.dataset.theme = theme.id
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.color)
  write(THEME_KEY, theme.id)
}

// Whoever draws the CRT mode or shows its button follows it through here
const crtListeners = new Set()

export function subscribeCrt(listener) {
  crtListeners.add(listener)
  return () => crtListeners.delete(listener)
}

export function applyCrt(on) {
  if (on) document.documentElement.dataset.crt = 'on'
  else delete document.documentElement.dataset.crt
  write(CRT_KEY, on ? 'on' : 'off')
  crtListeners.forEach(listener => listener())
}
