import Compare from './Compare.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'compare',
  title: 'Compare',
  description: 'Line this file up against another one and see what differs',
  order: 47,
  group: 2,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Compare
}
