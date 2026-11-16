/**
 * Copies text to the clipboard. Falls back to a hidden textarea where the
 * async clipboard API is missing or refused (e.g. an insecure origin).
 * @param {string} text
 * @returns {Promise<boolean>} whether the copy worked
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the textarea fallback
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  const active = document.activeElement
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  if (active && typeof active.focus === 'function') active.focus()
  return ok
}
