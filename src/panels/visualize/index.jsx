import Visualize from './Visualize.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'visualize',
  title: 'Visualize',
  order: 60,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file && file.size > 0),
  Component: Visualize
}
