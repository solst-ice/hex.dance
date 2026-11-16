// Applies the saved theme before the first paint. Loaded as a blocking
// script from index.html; keep the keys in sync with src/components/themes.js.
(function () {
  var colors = { neon: '#060714', amber: '#0c0803', green: '#020904' }
  var root = document.documentElement
  try {
    var theme = window.localStorage.getItem('hexdance.theme')
    if (colors[theme]) {
      root.dataset.theme = theme
      var meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', colors[theme])
    }
    if (window.localStorage.getItem('hexdance.crt') === 'on') root.dataset.crt = 'on'
  } catch {
    // Storage unavailable: keep the default theme
  }
})()
