import Anatomy from './Anatomy.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'anatomy',
  title: 'Anatomy',
  order: 10,
  placement: 'dock',
  isAvailable: ({ analysis }) => Boolean(analysis && (analysis.regions.length > 0 || analysis.fields.length > 0)),
  Component: Anatomy
}
