import React from 'react'

function FileMetadata({ file, buffer, fileType }) {
  if (!file || !buffer) return null

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }

  const getMagicNumber = () => {
    const view = new DataView(buffer)
    const magic = view.getUint32(0, false)
    return `0x${magic.toString(16).padStart(8, '0').toUpperCase()}`
  }

  const getFileTypeInfo = () => {
    switch (fileType) {
      case 'macho':
        const magic = getMagicNumber()
        const magicDescriptions = {
          '0xFEEDFACE': '32-bit Mach-O',
          '0xFEEDFACF': '64-bit Mach-O',
          '0xCEFAEDFE': '32-bit Mach-O (reversed)',
          '0xCFFAEDFE': '64-bit Mach-O (reversed)',
          '0xCAFEBABE': 'Universal Binary',
          '0xBEBAFECA': 'Universal Binary (reversed)'
        }
        return magicDescriptions[magic] || 'Unknown Mach-O format'
      case 'png':
        return 'PNG Image'
      case 'jpeg':
        return 'JPEG Image'
      case 'gif':
        return 'GIF Image'
      case 'pdf':
        return 'PDF Document'
      case 'zip':
        return 'ZIP Archive'
      case 'unknown':
        return file.type || 'Unknown Format'
      case 'pe':
        return 'Windows PE Executable'
      case 'elf':
        return 'Linux ELF Executable'
      default:
        return 'Unknown format'
    }
  }

  return (
    <div className="file-metadata">
      <h2>File Information</h2>
      <div className="metadata-grid">
        <div className="metadata-item">
          <span className="metadata-label">File Name</span>
          <span className="metadata-value">{file.name}</span>
        </div>
        <div className="metadata-item">
          <span className="metadata-label">File Size</span>
          <span className="metadata-value">{formatBytes(file.size)}</span>
        </div>
        <div className="metadata-item">
          <span className="metadata-label">File Type</span>
          <span className="metadata-value">{getFileTypeInfo()}</span>
        </div>
        <div className="metadata-item">
          <span className="metadata-label">Magic Number</span>
          <span className="metadata-value">{getMagicNumber()}</span>
        </div>
        <div className="metadata-item">
          <span className="metadata-label">Last Modified</span>
          <span className="metadata-value">
            {new Date(file.lastModified).toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  )
}

export default FileMetadata 