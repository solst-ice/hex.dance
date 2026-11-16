import Compare from './Compare.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'compare',
  title: 'Compare',
  order: 47,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Compare
}
