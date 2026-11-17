import Overview from './Overview.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'overview',
  title: 'Overview',
  description: 'What the file is: its type, size and the metadata its format records',
  order: 0,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  badge: ({ analysis }) => (analysis && analysis.warnings.length ? '!' : null),
  Component: Overview
}
