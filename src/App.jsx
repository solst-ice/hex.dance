/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useState } from 'react'
import FileUploader from './components/FileUploader'
import GlitchFavicon from './components/GlitchFavicon'
import MatrixRain from './components/MatrixRain'
import SampleFiles from './components/SampleFiles'
import ThemeSwitcher from './components/ThemeSwitcher'
import Title from './components/Title'
import Workspace from './components/Workspace'
import useWindowFileDrop from './components/useWindowFileDrop'
import { FileProvider, SelectionProvider, WorkspaceProvider, useFile } from './state/index.js'
import './App.css'
import './styles/ui.css'
import './styles/workspace.css'
import './styles/shell.css'
import './styles/theme.css'

// How long the header rain falls after a file is opened
const BURST_MS = 2500

// Rain behind the slim header, made of the open file's bytes. It falls
// briefly when a file is opened and while another file is dragged in.
function HeaderRain({ file, bytes, dragging }) {
  const [burst, setBurst] = useState(false)

  useEffect(() => {
    if (!file) return
    setBurst(true)
    const timer = setTimeout(() => setBurst(false), BURST_MS)
    return () => clearTimeout(timer)
  }, [file])

  return <MatrixRain active={burst || dragging} brightness={dragging ? 0.45 : 0.14} dragging={dragging} bytes={bytes} />
}

function Shell() {
  const { file, bytes, openFile } = useFile()
  const isDragging = useWindowFileDrop(openFile)
  const compact = Boolean(file)

  return (
    <>
      <GlitchFavicon />
      <div className={`container ${compact ? 'has-file' : ''}`}>
        <header className={`description site-header ${compact ? 'is-compact' : ''}`}>
          {compact && <HeaderRain file={file} bytes={bytes} dragging={isDragging} />}
          <div className="site-header-row">
            <Title glitchKey={file} />
            {compact && (
              <div className="site-header-file">
                <FileUploader onFile={openFile} isDragging={isDragging} fileName={file.name} />
                <SampleFiles onFile={openFile} variant="menu" />
              </div>
            )}
            <ThemeSwitcher />
          </div>
          {!compact && (
            <p className="site-intro">
              Look inside any file: a hex view and editor, with structure, symbols and metadata for
              the formats it recognises. Everything runs in your browser, so your files never leave your device.
            </p>
          )}
        </header>
        <main className={compact ? 'site-main' : 'site-main landing'}>
          {compact ? (
            <Workspace />
          ) : (
            <>
              <FileUploader onFile={openFile} isDragging={isDragging} fileName={null} />
              <SampleFiles onFile={openFile} variant="row" />
              <p className="landing-formats">
                Understands common executable, archive, image and document formats.
                Anything else opens as raw bytes.
              </p>
            </>
          )}
        </main>
        <footer className="site-footer">
          hex.dance by <a href="https://x.com/IceSolst/">solst/ICE</a>
          <span aria-hidden="true"> · </span>
          <a href="https://github.com/solst-ice/hex.dance">source code</a>
        </footer>
      </div>
      {file && isDragging && (
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop to open</span>
        </div>
      )}
    </>
  )
}

function App() {
  return (
    <FileProvider>
      <SelectionProvider>
        <WorkspaceProvider>
          <Shell />
        </WorkspaceProvider>
      </SelectionProvider>
    </FileProvider>
  )
}

export default App
