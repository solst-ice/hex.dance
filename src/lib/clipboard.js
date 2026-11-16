/**
 * Copies text to the clipboard. Falls back to a hidden textarea where the
 * async clipboard API is missing or refused (e.g. an insecure origin), and
 * gives focus back to whatever had it.
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
  if (active && typeof active.focus === 'function') active.focus({ preventScroll: true })
  return ok
}

/** Whether this browser can put an image on the clipboard. */
export function canCopyImage() {
  return typeof window !== 'undefined' && typeof window.ClipboardItem === 'function' &&
    Boolean(navigator.clipboard?.write) && window.isSecureContext
}

/**
 * Puts an image on the clipboard. Takes a promise as well as a blob, so
 * Safari keeps the user gesture while the image is still being rendered.
 * Rejects when the browser refuses.
 * @param {Blob|Promise<Blob>} image
 * @param {string} [type]
 */
export async function copyImage(image, type = 'image/png') {
  await navigator.clipboard.write([new window.ClipboardItem({ [type]: image })])
}
