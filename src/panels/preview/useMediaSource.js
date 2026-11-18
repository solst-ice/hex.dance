import useBlobUrl from './useBlobUrl.js'
import useSvgImage from './useSvgImage.js'

const SVG_TYPE = 'image/svg+xml'

/**
 * What MediaView needs to show `bytes` as `media`: a blob: URL for raster
 * images, audio and video, or a decoded image for SVG, which never gets an
 * address of its own. `version` is the one currently shown.
 *
 * @returns {{ url: string|null, svg: ReturnType<typeof useSvgImage>|null, version: * }}
 */
export default function useMediaSource(bytes, version, media, delayMs) {
  const isSvg = media?.mime === SVG_TYPE
  const blob = useBlobUrl(bytes, version, isSvg ? null : media?.mime, delayMs)
  const svg = useSvgImage(isSvg ? bytes : null, version, delayMs)
  return isSvg ? { url: null, svg, version: svg.version } : { url: blob.url, svg: null, version: blob.version }
}
