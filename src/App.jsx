import React, { useState } from 'react'
import FileUploader from './components/FileUploader'
import FunctionList from './components/FunctionList'
import HexDump from './components/HexDump'
import GlitchFavicon from './components/GlitchFavicon'
import './App.css'

function App() {
  const [functions, setFunctions] = useState(new Set())
  const [fileBuffer, setFileBuffer] = useState(null)

  const handleFileAnalysis = (funcs, buffer) => {
    setFunctions(new Set(funcs))
    setFileBuffer(buffer)
  }

  return (
    <>
      <GlitchFavicon />
      <div className="container">
        <div className="description">
          <h1 className="glitch-title">HEX.DANCE</h1>
          <p>Drop a binary file to analyze its contents and view the hex dump.</p>
        </div>
        <FileUploader onFileAnalysis={handleFileAnalysis} />
        {fileBuffer && <HexDump buffer={fileBuffer} />}
        <FunctionList functions={functions} />
      </div>
    </>
  )
}

export default App