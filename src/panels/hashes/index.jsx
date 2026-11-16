import Hashes from './Hashes.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'hashes',
  title: 'Hashes',
  order: 40,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Hashes
}
