import Dance from './Dance.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'dance',
  title: 'Dance',
  description: 'The bytes played as sound',
  order: 70,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file && file.size > 0),
  Component: Dance
}
