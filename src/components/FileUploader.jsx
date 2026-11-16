import { useState, useCallback } from 'react'
import MatrixRain from './MatrixRain'
import { analyzeBinary } from '../utils/binaryAnalysis'
import { detectFileType, parseJavaClass, basicMetadata } from '../utils/detectFileType'
import { parsePNG, parseJPEG, parseGIF } from '../utils/images'
import { parsePDF } from '../utils/pdf'
import { parseZIP } from '../utils/zip'

function FileUploader({ onFileAnalysis }) {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isHovering, setIsHovering] = useState(false)

  const processFile = useCallback(async (file) => {
    if (!file) return

    setLoading(true)
    setError('')

    let buffer = null
    try {
      buffer = await file.arrayBuffer()
      const kind = detectFileType(buffer)

      switch (kind) {
        case 'png':
          onFileAnalysis(parsePNG(buffer), buffer, 'png', file)
          break
        case 'jpeg':
          onFileAnalysis(parseJPEG(buffer), buffer, 'jpeg', file)
          break
        case 'gif':
          onFileAnalysis(parseGIF(buffer), buffer, 'gif', file)
          break
        case 'pdf':
          onFileAnalysis(parsePDF(buffer), buffer, 'pdf', file)
          break
        case 'zip': {
          const { metadata, contents } = parseZIP(buffer)
          onFileAnalysis(metadata, buffer, 'zip', file, contents)
          break
        }
        case 'pe':
        case 'macho':
        case 'elf':
          onFileAnalysis(analyzeBinary(buffer), buffer, kind, file)
          break
        case 'java-class':
          onFileAnalysis(
            new Set([...basicMetadata(buffer, file.type), ...parseJavaClass(buffer)]),
            buffer,
            'unknown',
            file
          )
          break
        default:
          setError('Note: This file format is not specifically supported. Showing basic information.')
          onFileAnalysis(basicMetadata(buffer, file.type), buffer, 'unknown', file)
      }
    } catch (error) {
      console.error('Error processing file:', error)
      // Even on error, try to show basic file info
      if (!buffer) buffer = await file.arrayBuffer()
      setError('Error analyzing file: ' + error.message)
      onFileAnalysis(basicMetadata(buffer, file.type), buffer, 'unknown', file)
    } finally {
      setLoading(false)
    }
  }, [onFileAnalysis])

  const handleFileUpload = (event) => {
    processFile(event.target.files[0])
  }

  const handleDragEnter = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    
    // Only set dragging if we're not already dragging
    if (!isDragging) {
      setIsDragging(true)
    }
  }, [isDragging])

  const handleDragLeave = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()

    // Only handle drag leave if the mouse leaves the container
    if (e.currentTarget.contains(e.relatedTarget)) {
      return
    }
    
    setIsDragging(false)
  }, [])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    
    // Ensure dragging state stays true during drag over
    if (!isDragging) {
      setIsDragging(true)
    }
  }, [isDragging])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const file = e.dataTransfer.files[0]
    processFile(file)
  }, [processFile])

  const handleMouseEnter = () => setIsHovering(true)
  const handleMouseLeave = () => setIsHovering(false)

  return (
    <div 
      className={`file-uploader ${isDragging ? 'dragging' : ''} ${isHovering ? 'hovering' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <MatrixRain 
        brightness={isDragging ? 0.7 : isHovering ? 0.5 : 0.3}
        color={isDragging ? 'rgba(255, 54, 171' : 'rgba(0, 255, 255'}
      />
      <div className="upload-area">
        <input
          type="file"
          onChange={handleFileUpload}
          disabled={loading}
          id="file-input"
        />
        <label htmlFor="file-input">
          {isDragging ? 'Drop your file here!' : 'Drag & drop a binary or click to browse'}
        </label>
      </div>
      {loading && <p className="status">Analyzing file...</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

export default FileUploader
