/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useLayoutEffect, useRef, useState } from 'react'
import { describeSvgSize, fitCanvas } from './svg.js'

/**
 * Shows a blob: URL as an image, audio or video element, or an SVG drawn on a
 * canvas (`svg`, from useSvgImage), and reports what the browser made of it.
 * An SVG never gets an address of its own: opened as a page, it would run.
 */
export default function MediaView({ url, svg, media, caption }) {
  const [result, setResult] = useState({ url: null, info: null, error: false })
  const state = result.url === url ? result : { info: null, error: false }

  const loaded = (info) => {
    setResult({ url, info, error: false })
  }
  const failed = () => {
    setResult({ url, info: null, error: true })
  }

  if (svg) return <SvgView svg={svg} media={media} caption={caption} />
  if (!url) return <Preparing />

  let element
  if (media.kind === 'image') {
    element = (
      <img
        key={url}
        src={url}
        alt={caption}
        className="pv-image"
        decoding="async"
        onLoad={e => loaded({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        onError={failed}
      />
    )
  } else {
    const Tag = media.kind === 'audio' ? 'audio' : 'video'
    element = (
      <Tag
        key={url}
        src={url}
        controls
        preload="metadata"
        className={`pv-${media.kind}`}
        aria-label={caption}
        onLoadedMetadata={e => loaded({
          width: e.currentTarget.videoWidth || 0,
          height: e.currentTarget.videoHeight || 0,
          duration: e.currentTarget.duration
        })}
        onError={failed}
      />
    )
  }

  return (
    <Figure media={media} caption={caption} error={state.error} ready={Boolean(state.info)}
      dims={state.info ? describe(state.info, media) : null}>
      {element}
    </Figure>
  )
}

function Preparing() {
  return <div className="pv-frame pv-frame--empty"><p className="hd-empty">Preparing…</p></div>
}

function Figure({ media, caption, error, ready, dims, frameRef, children }) {
  return (
    <figure className="pv-figure" data-state={error ? 'error' : ready ? 'ok' : 'loading'}>
      <div ref={frameRef} className={`pv-frame ${media.kind === 'image' ? 'pv-checker' : ''} ${error ? 'pv-frame--error' : ''}`}>
        {error
          ? <p className="pv-error" role="status">The browser could not decode these bytes as {media.label}.</p>
          : children}
      </div>
      <figcaption className="pv-caption">
        <span className="pv-caption-title">{caption}</span>
        {dims && <span className="hd-muted pv-dims">{dims}</span>}
      </figcaption>
    </figure>
  )
}

// Follows the width the frame offers and the screen's pixel density, so the
// drawing is redone at the size it is seen at
function useFrameWidth(frameRef) {
  const [box, setBox] = useState({ width: 0, dpr: 1 })
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return undefined
    let media = null
    const measure = () => {
      const width = frame.clientWidth
      const dpr = window.devicePixelRatio || 1
      setBox(previous => (previous.width === width && previous.dpr === dpr ? previous : { width, dpr }))
      // Zooming the page or moving to another screen changes the density
      media?.removeEventListener('change', measure)
      media = window.matchMedia?.(`(resolution: ${dpr}dppx)`) || null
      media?.addEventListener('change', measure)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => {
      observer.disconnect()
      media?.removeEventListener('change', measure)
    }
  }, [frameRef])
  return box
}

function SvgView({ svg, media, caption }) {
  const frameRef = useRef(null)
  const canvasRef = useRef(null)
  const { width, dpr } = useFrameWidth(frameRef)
  const { image, size, error } = svg
  const fit = image && size && width ? fitCanvas(size, width, dpr) : null
  const [drawError, setDrawError] = useState(null)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !fit) return
    const ctx = canvas.getContext('2d')
    try {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      setDrawError(null)
    } catch {
      setDrawError(image)
    }
  }, [image, fit?.pixelWidth, fit?.pixelHeight]) // eslint-disable-line react-hooks/exhaustive-deps

  const failed = error || (drawError !== null && drawError === image)
  // The frame is always there to be measured; the canvas joins it once the image has decoded
  if (!image && !failed) {
    return <Figure media={media} caption={caption} frameRef={frameRef}><p className="hd-empty">Preparing…</p></Figure>
  }
  return (
    <Figure media={media} caption={caption} error={failed} ready={!failed} frameRef={frameRef}
      dims={failed || !size ? null : describeSvgSize(size)}>
      {fit && (
        <canvas
          ref={canvasRef}
          className="pv-image pv-svg"
          role="img"
          aria-label={caption}
          width={fit.pixelWidth}
          height={fit.pixelHeight}
          style={{ width: `${fit.cssWidth}px`, height: `${fit.cssHeight}px` }}
        />
      )}
    </Figure>
  )
}

function describe(info, media) {
  const parts = []
  if (info.width && info.height) parts.push(`${info.width} × ${info.height} px`)
  else if (media.kind === 'image') parts.push('no intrinsic size')
  if (Number.isFinite(info.duration)) parts.push(`${info.duration.toFixed(2)} s`)
  return parts.join(', ')
}
