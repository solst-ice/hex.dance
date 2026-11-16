import { parseRIFF, riffForm } from './riff.js'
import { fitted } from './reader.js'

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'avi',
  name: 'AVI Video',
  category: 'video',
  detect: bytes => riffForm(bytes) === 'AVI ',
  parse: fitted(parseRIFF)
}
