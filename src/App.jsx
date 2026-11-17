/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import './styles/sections.css'
import './styles/shell.css'
import './styles/theme.css'
import './styles/theme-tui.css'

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

// Publishes the slim header's height as --hd-header-h, for the parts of the
// workspace that stick under it on wide screens
function useHeaderHeight(ref, active) {
  useLayoutEffect(() => {
    const header = ref.current
    if (!active || !header) return
    const root = document.documentElement
    const update = () => root.style.setProperty('--hd-header-h', `${header.offsetHeight}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(header)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--hd-header-h')
    }
  }, [ref, active])
}

function Footer() {
  return (
    <footer className="site-footer">
      hex.dance by <a href="https://x.com/IceSolst/">solst/ICE</a>
      <span aria-hidden="true"> · </span>
      <a href="https://github.com/solst-ice/hex.dance">source code</a>
    </footer>
  )
}

function Shell() {
  const { file, bytes, openFile } = useFile()
  const isDragging = useWindowFileDrop(openFile)
  const compact = Boolean(file)
  const headerRef = useRef(null)
  useHeaderHeight(headerRef, compact)

  return (
    <>
      <GlitchFavicon />
      <div className={`container ${compact ? 'has-file' : ''}`}>
        <header ref={headerRef} className={`description site-header ${compact ? 'is-compact' : ''}`}>
          {compact && <HeaderRain file={file} bytes={bytes} dragging={isDragging} />}
          <div className="site-header-row">
            <Title glitchKey={file} banner={!compact} />
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
            <Workspace footer={<Footer />} />
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
        {!compact && <Footer />}
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
