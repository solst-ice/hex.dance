import React, { useState } from 'react'
import FileUploader from './components/FileUploader'
import FunctionList from './components/FunctionList'
import HexDump from './components/HexDump'
import GlitchFavicon from './components/GlitchFavicon'
import FileMetadata from './components/FileMetadata'
import './App.css'

function App() {
  const [functions, setFunctions] = useState(new Set())
  const [fileBuffer, setFileBuffer] = useState(null)
  const [fileType, setFileType] = useState(null)
  const [currentFile, setCurrentFile] = useState(null)
  const [zipContents, setZipContents] = useState(null)

  const handleFileAnalysis = (data, buffer, type, file) => {
    setFunctions(type === 'zip' ? data.metadata : new Set(data))
    setFileBuffer(buffer)
    setFileType(type)
    setCurrentFile(file)
    if (type === 'zip') {
      setZipContents(data.contents)
    }
  }

  return (
    <>
      <GlitchFavicon />
      <div className="container">
        <div className="description">
          <h1 className="glitch-title">HEX.DANCE</h1>
          <p>client-side binary/file analysis, hex dump viewer & editor.<br />
          by <a href="https://x.com/IceSolst/">solst/ICE</a> (<a href="https://github.com/solst-ice/hex.dance">code</a>)</p>
        </div>
        <FileUploader onFileAnalysis={handleFileAnalysis} />
        {fileBuffer && (
          <>
            <FileMetadata 
              file={currentFile}
              buffer={fileBuffer}
              fileType={fileType}
            />
            {fileType !== 'macho' && functions.size > 0 && (
              <FunctionList 
                functions={functions} 
                title="File Metadata" 
              />
            )}
            {fileType === 'zip' && zipContents && (
              <div className="zip-contents">
                <h2>Archive Contents</h2>
                <pre className="tree-view">
                  {[...zipContents][0]}
                </pre>
              </div>
            )}
            <HexDump 
              buffer={fileBuffer} 
              fileName={currentFile.name}
            />
            {fileType === 'macho' && functions.size > 0 && (
              <FunctionList 
                functions={functions} 
                title="Found Symbols" 
              />
            )}
          </>
        )}
      </div>
    </>
  )
}

export default App