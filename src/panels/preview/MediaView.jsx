/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useState } from 'react'

/**
 * Shows a blob: URL as an image, audio or video element and reports what the
 * browser made of it. SVG goes through <img> too, where scripts never run.
 */
export default function MediaView({ url, media, caption }) {
  const [result, setResult] = useState({ url: null, info: null, error: false })
  const state = result.url === url ? result : { info: null, error: false }

  const loaded = (info) => {
    setResult({ url, info, error: false })
  }
  const failed = () => {
    setResult({ url, info: null, error: true })
  }

  if (!url) return <div className="pv-frame pv-frame--empty"><p className="hd-empty">Preparing…</p></div>

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
    <figure className="pv-figure" data-state={state.error ? 'error' : state.info ? 'ok' : 'loading'}>
      <div className={`pv-frame ${media.kind === 'image' ? 'pv-checker' : ''} ${state.error ? 'pv-frame--error' : ''}`}>
        {state.error
          ? <p className="pv-error" role="status">The browser could not decode these bytes as {media.label}.</p>
          : element}
      </div>
      <figcaption className="pv-caption">
        <span className="pv-caption-title">{caption}</span>
        {state.info && <span className="hd-muted pv-dims">{describe(state.info, media)}</span>}
      </figcaption>
    </figure>
  )
}

function describe(info, media) {
  const parts = []
  if (info.width && info.height) parts.push(`${info.width} × ${info.height} px`)
  else if (media.kind === 'image') parts.push('no intrinsic size')
  if (Number.isFinite(info.duration)) parts.push(`${info.duration.toFixed(2)} s`)
  return parts.join(', ')
}
