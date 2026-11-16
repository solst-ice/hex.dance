import { analyzeBytes } from './analyze.js'

// Message in: { id, file }. Message out: { id, analysis } or { id, error }.
self.onmessage = async (event) => {
  const { id, file } = event.data || {}
  try {
    const buffer = await file.arrayBuffer()
    const analysis = analyzeBytes(new Uint8Array(buffer), { fileName: file.name, mimeType: file.type })
    self.postMessage({ id, analysis })
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) })
  }
}
