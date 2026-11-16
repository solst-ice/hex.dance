import Strings from './Strings.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'strings',
  title: 'Strings',
  order: 30,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Strings
}
