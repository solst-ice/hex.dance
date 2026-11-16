import FileUploader from './components/FileUploader'
import GlitchFavicon from './components/GlitchFavicon'
import Workspace from './components/Workspace'
import useWindowFileDrop from './components/useWindowFileDrop'
import { FileProvider, SelectionProvider, useFile } from './state/index.js'
import './App.css'
import './styles/ui.css'
import './styles/workspace.css'

function Shell() {
  const { file, openFile } = useFile()
  const isDragging = useWindowFileDrop(openFile)

  return (
    <>
      <GlitchFavicon />
      <div className={`container ${file ? 'has-file' : ''}`}>
        <div className="description">
          <h1 className="glitch-title">HEX.DANCE</h1>
          <p>client-side binary/file analysis, hex dump viewer & editor.<br />
          by <a href="https://x.com/IceSolst/">solst/ICE</a> (<a href="https://github.com/solst-ice/hex.dance">code</a>)</p>
        </div>
        <FileUploader onFile={openFile} isDragging={isDragging} fileName={file ? file.name : null} />
        {file && <Workspace />}
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
        <Shell />
      </SelectionProvider>
    </FileProvider>
  )
}

export default App
