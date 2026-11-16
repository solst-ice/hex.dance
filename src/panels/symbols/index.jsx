import Symbols from './Symbols.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'symbols',
  title: 'Symbols',
  order: 10,
  placement: 'tab',
  isAvailable: ({ analysis }) => Boolean(analysis && analysis.symbols.length > 0),
  badge: ({ analysis }) => (analysis ? analysis.symbols.length.toLocaleString() : null),
  Component: Symbols
}
