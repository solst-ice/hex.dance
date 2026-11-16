import Inspector from './Inspector.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'inspector',
  title: 'Inspector',
  order: 20,
  placement: 'dock',
  isAvailable: ({ file }) => Boolean(file),
  Component: Inspector
}
