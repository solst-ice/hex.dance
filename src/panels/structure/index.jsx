import Structure from './Structure.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'structure',
  title: 'Structure',
  description: "The file's fields decoded and explained, with a guided tour of the format",
  order: 5,
  group: 1,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Structure
}
