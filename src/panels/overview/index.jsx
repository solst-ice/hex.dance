import Overview from './Overview.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'overview',
  title: 'Overview',
  order: 0,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  badge: ({ analysis }) => (analysis && analysis.warnings.length ? '!' : null),
  Component: Overview
}
