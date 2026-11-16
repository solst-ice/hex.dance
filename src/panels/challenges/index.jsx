import Challenges from './Challenges.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'challenges',
  title: 'Learn',
  order: 90,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Challenges
}
