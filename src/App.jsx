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

  const handleFileAnalysis = (data, buffer, type, file) => {
    setFunctions(new Set(data))
    setFileBuffer(buffer)
    setFileType(type)
    setCurrentFile(file)
  }

  return (
    <>
      <GlitchFavicon />
      <div className="container">
        <div className="description">
          <h1 className="glitch-title">HEX.DANCE</h1>
          <p>Drop a binary or image file to analyze its contents and view the hex dump.</p>
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
            <HexDump buffer={fileBuffer} />
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