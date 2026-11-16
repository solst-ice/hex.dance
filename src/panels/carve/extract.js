// Getting a hit's bytes out: as a download, or as the file the app shows.

// Where each opened extract came from, so the panel can say so
const origins = new WeakMap()

export function originOf(file) {
  return file ? origins.get(file) || null : null
}

export function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Builds a File from the bytes (a copy) and remembers its parent and offset. */
export function extractedFile(bytes, name, origin) {
  const file = new File([bytes], name, { type: 'application/octet-stream' })
  origins.set(file, origin)
  return file
}
