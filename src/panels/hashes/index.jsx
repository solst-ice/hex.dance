import Hashes from './Hashes.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'hashes',
  title: 'Hashes',
  description: 'MD5, SHA and CRC-32 checksums of the file or the selection',
  order: 40,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Hashes
}
