import Entropy from './Entropy.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'entropy',
  title: 'Entropy',
  order: 45,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Entropy
}
