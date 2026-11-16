import Structure from './Structure.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'structure',
  title: 'Structure',
  order: 5,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Structure
}
