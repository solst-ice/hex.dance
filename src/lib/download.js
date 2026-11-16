// Offering bytes to the user as a file, without leaving the page.

/**
 * Saves a blob under `name` through a temporary object URL.
 * @param {Blob} blob
 * @param {string} name
 */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Some browsers read the URL after click() returns
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} name
 */
export function downloadBytes(bytes, name) {
  downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), name)
}

/**
 * @param {string} text
 * @param {string} name
 */
export function downloadText(text, name) {
  downloadBlob(new Blob([text], { type: 'text/plain' }), name)
}
