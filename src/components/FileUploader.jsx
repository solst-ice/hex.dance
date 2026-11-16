/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useState } from 'react'
import MatrixRain from './MatrixRain'

/**
 * File picker. Without a file it is the large landing drop zone; once a file
 * is open it collapses to a one-line bar. Drops are handled for the whole
 * window by useWindowFileDrop, which also supplies `isDragging`.
 */
function FileUploader({ onFile, isDragging = false, fileName = null }) {
  const [isHovering, setIsHovering] = useState(false)

  const handleChange = (event) => {
    const file = event.target.files[0]
    // Clearing the value lets the same file be chosen again
    event.target.value = ''
    if (file) onFile(file)
  }

  if (fileName !== null) {
    return (
      <div className={`file-bar ${isDragging ? 'dragging' : ''}`}>
        <span className="file-bar-name" title={fileName}>{fileName}</span>
        <label className="file-bar-choose hd-button hd-button--small">
          <input type="file" id="file-input" onChange={handleChange} />
          {isDragging ? 'Drop to open' : 'Drop or choose another file'}
        </label>
      </div>
    )
  }

  return (
    <div
      className={`file-uploader ${isDragging ? 'dragging' : ''} ${isHovering ? 'hovering' : ''}`}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <MatrixRain
        brightness={isDragging ? 0.7 : isHovering ? 0.5 : 0.3}
        color={isDragging ? 'rgba(255, 54, 171' : 'rgba(0, 255, 255'}
      />
      <div className="upload-area">
        <input type="file" onChange={handleChange} id="file-input" />
        <label htmlFor="file-input">
          {isDragging ? 'Drop your file here!' : 'Drag & drop a binary or click to browse'}
        </label>
      </div>
    </div>
  )
}

export default FileUploader
