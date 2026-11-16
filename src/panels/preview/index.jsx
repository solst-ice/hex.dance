import Preview from './Preview.jsx'
import { mediaFromFormatId, mediaFromMime, mediaFromName, sniffBytes } from './sniff.js'

const HEAD_BYTES = 4096
// File -> media sniffed from its first bytes ('pending' while being read)
const sniffed = new WeakMap()

// isAvailable only gets the File, so the first bytes are read on the side
// the first time it is asked. That read is tiny and finishes long before the
// analysis, whose arrival asks again.
function sniffHead(file) {
  if (sniffed.has(file)) return sniffed.get(file)
  sniffed.set(file, 'pending')
  file.slice(0, HEAD_BYTES).arrayBuffer().then(
    buffer => sniffed.set(file, sniffBytes(new Uint8Array(buffer))),
    () => sniffed.set(file, null)
  )
  return 'pending'
}

function isAvailable({ file, analysis }) {
  if (!file || !file.size) return false
  const head = sniffHead(file)
  if (head && head !== 'pending') return true
  if (mediaFromFormatId(analysis?.formatId) || mediaFromMime(file.type) || mediaFromName(file.name)) return true
  // The bytes are not known yet, so trust the analysis
  return head === 'pending' && ['image', 'audio', 'video'].includes(analysis?.category)
}

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'preview',
  title: 'Preview',
  order: 50,
  placement: 'tab',
  isAvailable,
  Component: Preview
}
