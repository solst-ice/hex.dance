import Entropy from './Entropy.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'entropy',
  title: 'Entropy',
  description: 'How random the bytes are from start to end, and which values occur',
  order: 50,
  group: 3,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Entropy
}
