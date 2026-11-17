import Archive from './Archive.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'archive',
  title: 'Archive',
  description: 'The files stored inside this archive',
  order: 20,
  group: 1,
  placement: 'tab',
  isAvailable: ({ analysis }) => Boolean(analysis && analysis.category === 'archive'),
  badge: ({ analysis }) => (analysis ? analysis.entries.filter(entry => !entry.isDirectory).length.toLocaleString() : null),
  Component: Archive
}
