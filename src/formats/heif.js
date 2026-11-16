import { IMAGE_BRANDS, isoBrand, parseISOBMFF } from './isobmff.js'
import { fitted } from './reader.js'

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'heif',
  name: 'HEIF Image',
  category: 'image',
  detect: bytes => IMAGE_BRANDS.has(isoBrand(bytes)),
  parse: fitted(parseISOBMFF)
}
