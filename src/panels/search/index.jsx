import Search from './Search.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'search',
  title: 'Search',
  order: 35,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Search
}
