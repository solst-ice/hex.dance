import Carve from './Carve.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'carve',
  title: 'Embedded',
  order: 32,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Carve
}
