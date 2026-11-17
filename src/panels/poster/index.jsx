import Poster from './Poster.jsx'

/** @type {import('../index.js').PanelModule} */
export default {
  id: 'poster',
  title: 'Poster',
  description: "A poster of the file's bytes to save as an image",
  order: 80,
  group: 3,
  placement: 'tab',
  isAvailable: ({ file }) => Boolean(file),
  Component: Poster
}
