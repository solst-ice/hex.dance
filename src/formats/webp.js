import { parseRIFF, riffForm } from './riff.js'
import { fitted } from './reader.js'

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'webp',
  name: 'WebP Image',
  category: 'image',
  detect: bytes => riffForm(bytes) === 'WEBP',
  parse: fitted(parseRIFF)
}
