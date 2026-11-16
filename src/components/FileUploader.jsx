/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useEffect, useState } from 'react'
import MatrixRain from './MatrixRain'

// How long the landing rain falls after the page loads before it waits for the pointer
const INTRO_MS = 6000

/**
 * File picker. Without a file it is the large landing drop zone; once a file
 * is open it collapses to a one-line bar. Drops are handled for the whole
 * window by useWindowFileDrop, which also supplies `isDragging`.
 */
function FileUploader({ onFile, isDragging = false, fileName = null }) {
  const [isHovering, setIsHovering] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [intro, setIntro] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setIntro(false), INTRO_MS)
    return () => clearTimeout(timer)
  }, [])

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
          {isDragging ? 'Drop to open' : 'Open file'}
        </label>
      </div>
    )
  }

  return (
    <div
      className={`file-uploader ${isDragging ? 'dragging' : ''} ${isHovering ? 'hovering' : ''}`}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
    >
      <MatrixRain
        active={intro || isHovering || isFocused || isDragging}
        brightness={isDragging ? 0.7 : isHovering ? 0.5 : 0.3}
        dragging={isDragging}
      />
      <div className="upload-area">
        <input type="file" onChange={handleChange} id="file-input" aria-describedby="file-input-hint" />
        <label htmlFor="file-input">
          {isDragging ? 'Drop your file here' : 'Drop a file here or click to browse'}
        </label>
        <p className="upload-hint" id="file-input-hint">Any file, any size. It is read locally and never uploaded.</p>
      </div>
    </div>
  )
}

export default FileUploader
