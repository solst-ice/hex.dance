import { useMemo } from 'react'
import { useFile } from '../../state/hooks.js'
import { formatBytes } from '../../formats/shared.js'
import { chooseMedia } from './sniff.js'
import useBlobUrl from './useBlobUrl.js'
import GlitchLab from './GlitchLab.jsx'
import MediaView from './MediaView.jsx'
import './preview.css'

const EDIT_DEBOUNCE_MS = { image: 250, audio: 700, video: 700 }

function Preview() {
  const { bytes, file, analysis, revision } = useFile()
  // Decided once per file: an edit that breaks the signature should show as a decode failure, not hide the preview
  const media = useMemo(() => (bytes ? chooseMedia({
    bytes, fileName: file?.name, mimeType: file?.type, formatId: analysis?.formatId
  }) : null), [bytes]) // eslint-disable-line react-hooks/exhaustive-deps
  const { url, version } = useBlobUrl(bytes, revision, media?.mime, EDIT_DEBOUNCE_MS[media?.kind] || 300)

  if (!bytes) return <section className="hd-panel"><p className="hd-empty">Reading file…</p></section>
  if (!media) {
    return (
      <section className="hd-panel preview-panel">
        <p className="hd-empty">The browser has no built-in way to show this file.</p>
      </section>
    )
  }

  const stale = version !== null && version !== revision
  return (
    <section className="hd-panel preview-panel" data-kind={media.kind} data-revision={version ?? ''}>
      <div className="hd-panel-header">
        <span className="hd-badge">{media.label}</span>
      </div>
      <MediaView url={url} media={media} caption={file?.name || 'File'} />
      <p className="pv-note hd-muted" aria-live="polite">
        {formatBytes(bytes.length)}, shown from the bytes in memory.{' '}
        {stale
          ? 'Updating after your edit…'
          : revision > 0
            ? 'Showing your edited bytes.'
            : 'Edit bytes in the hex view and this preview redraws, or fails, to match.'}
      </p>
      {media.kind === 'image' && <GlitchLab bytes={bytes} revision={revision} media={media} fileName={file?.name} originalUrl={url} />}
    </section>
  )
}

export default Preview
