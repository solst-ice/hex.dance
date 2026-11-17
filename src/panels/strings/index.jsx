import Strings from './Strings.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'strings',
  title: 'Strings',
  description: 'Readable text found in the bytes',
  order: 30,
  group: 2,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Strings
}
