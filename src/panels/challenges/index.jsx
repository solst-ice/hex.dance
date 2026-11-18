import Challenges from './Challenges.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'challenges',
  title: 'Learn',
  description: 'Guided challenges: fix and explore files made for the purpose',
  order: 90,
  group: 3,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Challenges
}
