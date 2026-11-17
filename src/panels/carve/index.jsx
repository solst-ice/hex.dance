import Carve from './Carve.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'carve',
  title: 'Embedded',
  description: 'Other files hidden inside this one, found by their signatures',
  order: 32,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Carve
}
