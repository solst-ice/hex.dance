import Search from './Search.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'search',
  title: 'Search',
  description: 'Find bytes, text or numbers anywhere in the file',
  order: 35,
  group: 2,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Search
}
