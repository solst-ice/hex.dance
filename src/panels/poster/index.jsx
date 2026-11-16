import Poster from './Poster.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'poster',
  title: 'Poster',
  order: 80,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Poster
}
