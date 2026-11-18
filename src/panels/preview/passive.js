// Which types the page may hand to the browser as a blob: or data: address
// made from file bytes. Such an address can be opened as a page of its own
// (dragged to the tab bar, or its address pasted), and then it runs on this
// site's origin: an SVG, HTML or XML document would run its scripts there,
// read what the site stores and reach other sites. Raster images, audio and
// video are only ever shown, never run, so only they keep their own type;
// everything else is labelled as plain bytes, which the browser downloads.

export const DOWNLOAD_TYPE = 'application/octet-stream'

const PASSIVE_IMAGES = new Set([
  'image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
  'image/x-icon', 'image/vnd.microsoft.icon', 'image/avif'
])

// A bare type/subtype with nothing after it: parameters could smuggle in a
// different meaning, and the browser reads the whole string
const BARE_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/
const ACTIVE_HINT = /xml|html|svg|xsl|script|javascript|ecmascript|json/

/** Whether `type` is safe to give the browser as an address made from file bytes. */
export function isPassiveType(type) {
  if (typeof type !== 'string') return false
  const t = type.toLowerCase()
  if (!BARE_TYPE.test(t) || ACTIVE_HINT.test(t)) return false
  if (t === DOWNLOAD_TYPE || PASSIVE_IMAGES.has(t)) return true
  return t.startsWith('audio/') || t.startsWith('video/')
}

/** The type to give a Blob of file bytes that the page will make an address for. */
export function passiveType(type) {
  return isPassiveType(type) ? type.toLowerCase() : DOWNLOAD_TYPE
}
