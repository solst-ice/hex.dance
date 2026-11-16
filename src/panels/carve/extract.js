// Opening a hit's bytes as the file the app shows (downloads go through src/lib/download.js).

// Where each opened extract came from, so the panel can say so
const origins = new WeakMap()

export function originOf(file) {
  return file ? origins.get(file) || null : null
}

/** Builds a File from the bytes (a copy) and remembers its parent and offset. */
export function extractedFile(bytes, name, origin) {
  const file = new File([bytes], name, { type: 'application/octet-stream' })
  origins.set(file, origin)
  return file
}
