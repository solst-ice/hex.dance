import { parseRIFF, riffForm } from './riff.js'
import { fitted } from './reader.js'

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'wav',
  name: 'WAV Audio',
  category: 'audio',
  detect: bytes => riffForm(bytes) === 'WAVE',
  parse: fitted(parseRIFF)
}
