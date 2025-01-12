import { useState, useCallback } from 'react'
import MatrixRain from './MatrixRain'

function FileUploader({ onFileAnalysis }) {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isHovering, setIsHovering] = useState(false)

const isMachO = (buffer) => {
    const view = new DataView(buffer)
    const magic = view.getUint32(0, false)
    console.log('Magic number:', magic.toString(16))
    
    return magic === 0xfeedface || // 32-bit
           magic === 0xfeedfacf || // 64-bit
           magic === 0xcefaedfe || // 32-bit reversed
           magic === 0xcffaedfe || // 64-bit reversed
           magic === 0xcafebabe || // Universal
           magic === 0xbebafeca    // Universal reversed
  }

  const parseMachO = (buffer) => {
    const view = new DataView(buffer)
    const initialMagic = view.getUint32(0, false)
    let offset = 0
    let currentMagic = initialMagic
    let isLittleEndian = false
    let is64Bit = false

    try {
      console.log('File size:', buffer.byteLength, 'bytes')
      console.log('Initial magic:', initialMagic.toString(16))

      // Handle Universal binary
      if (currentMagic === 0xcafebabe || currentMagic === 0xbebafeca) {
        if (buffer.byteLength < 8) throw new Error('Invalid Universal binary: file too small')
        
        const nfat_arch = view.getUint32(4, false)
        console.log('Universal binary with', nfat_arch, 'architectures')
        
        const FAT_HEADER_SIZE = 8
        const FAT_ARCH_SIZE = 20
        
        if (buffer.byteLength < FAT_HEADER_SIZE + FAT_ARCH_SIZE) {
          throw new Error('Invalid Universal binary: missing architecture data')
        }

        const firstArchOffset = FAT_HEADER_SIZE
        offset = view.getUint32(firstArchOffset + 8, false)
        console.log('First architecture offset:', offset)
        
        if (offset >= buffer.byteLength) throw new Error('Invalid architecture offset')
        
        // Read magic at architecture offset
        currentMagic = view.getUint32(offset, false)
        console.log('Architecture magic:', currentMagic.toString(16))
      }

      // Check if we need to read in little-endian and if it's 64-bit
      isLittleEndian = currentMagic === 0xcefaedfe || currentMagic === 0xcffaedfe
      is64Bit = currentMagic === 0xfeedfacf || currentMagic === 0xcffaedfe
      console.log('Using little-endian:', isLittleEndian)
      console.log('Using 64-bit:', is64Bit)

      // Ensure we have enough bytes for the header
      const headerSize = currentMagic === 0xfeedfacf || currentMagic === 0xcffaedfe ? 32 : 28
      if (buffer.byteLength < offset + headerSize) throw new Error('Invalid Mach-O header')
      
      const ncmds = view.getUint32(offset + 16, isLittleEndian)
      console.log('Number of load commands:', ncmds)
      if (ncmds <= 0 || ncmds > 1000) throw new Error('Invalid number of load commands: ' + ncmds)
      
      let cmdOffset = offset + headerSize
      console.log('Starting command offset:', cmdOffset)

      const functions = new Set()

      for (let i = 0; i < ncmds; i++) {
        if (cmdOffset + 8 > buffer.byteLength) {
          console.log('Command offset out of bounds:', cmdOffset)
          break
        }
        
        const cmd = view.getUint32(cmdOffset, isLittleEndian)
        const cmdsize = view.getUint32(cmdOffset + 4, isLittleEndian)
        console.log(`Command ${i}:`, { cmd, cmdsize, offset: cmdOffset })

        if (cmdsize < 8 || cmdOffset + cmdsize > buffer.byteLength) {
          console.log('Invalid command size:', cmdsize)
          break
        }

        // LC_SYMTAB = 2
        if (cmd === 2) {
          console.log('Found SYMTAB command')
          
          const symoff = view.getUint32(cmdOffset + 8, isLittleEndian)
          const nsyms = view.getUint32(cmdOffset + 12, isLittleEndian)
          const stroff = view.getUint32(cmdOffset + 16, isLittleEndian)
          const strsize = view.getUint32(cmdOffset + 20, isLittleEndian)
          console.log('SYMTAB details:', { symoff, nsyms, stroff, strsize, fileSize: buffer.byteLength })

          // Validate offsets
          if (symoff >= buffer.byteLength || stroff >= buffer.byteLength) {
            console.error('Invalid symbol or string table offset')
            continue
          }

          const symbolSize = is64Bit ? 16 : 12
          console.log('Symbol size:', symbolSize)

          for (let j = 0; j < nsyms; j++) {
            const symOffset = symoff + (j * symbolSize)
            if (symOffset + symbolSize > buffer.byteLength) break

            const strIndex = view.getUint32(symOffset, isLittleEndian)
            if (strIndex >= strsize) continue

            const type = view.getUint8(symOffset + (is64Bit ? 6 : 4))
            const sect = view.getUint8(symOffset + (is64Bit ? 7 : 5))
            
            // Debug symbol information
            const symbolInfo = {
              offset: symOffset,
              strIndex,
              type: type.toString(16),
              sect,
              typeCheck: (type & 0x0f).toString(16),
              isExternal: (type & 0x01) !== 0,
              isPrivateExternal: (type & 0x10) !== 0,
              isStab: (type & 0xe0) !== 0
            }
            console.log(`Symbol ${j}:`, symbolInfo)

            // Updated symbol type checking
            // N_STAB = 0xe0, N_PEXT = 0x10, N_TYPE = 0x0e, N_EXT = 0x01
            const isStab = (type & 0xe0) !== 0
            const isExternal = (type & 0x01) !== 0
            const typeField = type & 0x0e

            // Accept both external symbols and symbols in sections
            const isValidSymbol = !isStab && (isExternal || sect !== 0)

            if (isValidSymbol) {
              try {
                let name = ''
                let strPos = stroff + strIndex
                let maxLen = 1024

                if (strPos >= buffer.byteLength) continue

                while (strPos < buffer.byteLength && maxLen > 0) {
                  const char = view.getUint8(strPos)
                  if (char === 0) break
                  name += String.fromCharCode(char)
                  strPos++
                  maxLen--
                }

                if (name && name.startsWith('_')) {
                  name = name.substring(1)
                  const symType = typeField === 0x0 ? 'U' : 'T'
                  console.log('Adding symbol:', name, { type: symType, strIndex, strOffset: stroff + strIndex })
                  functions.add(`${name} (${symType})`)
                }
              } catch (err) {
                console.error('Error reading symbol name:', err)
              }
            }
          }
        }
        cmdOffset += cmdsize
      }

      const result = Array.from(functions).sort()
      console.log('Final symbol list:', result)
      return result

    } catch (err) {
      console.error('Error during Mach-O parsing:', err)
      throw new Error('Invalid Mach-O file structure: ' + err.message)
    }
  }

  const processFile = async (file) => {
    if (!file) return

    setLoading(true)
    setError('')

    try {
      const reader = new FileReader()
      reader.onload = (e) => {
        const buffer = e.target.result
        try {
          // Check file type by magic numbers
          const view = new DataView(buffer)
          const magic = view.getUint32(0, false)
          const firstBytes = view.getUint16(0, false)  // For JPEG detection
          
          // Image format signatures
          const isPNG = magic === 0x89504E47
          const isJPG = firstBytes === 0xFFD8  // JPEG starts with FF D8
          const isGIF = magic === 0x47494638

          // Mach-O signatures
          const isMachO = magic === 0xfeedface || // 32-bit
                         magic === 0xfeedfacf || // 64-bit
                         magic === 0xcefaedfe || // 32-bit reversed
                         magic === 0xcffaedfe || // 64-bit reversed
                         magic === 0xcafebabe || // Universal
                         magic === 0xbebafeca    // Universal reversed

          if (isMachO) {
            const functions = parseMachO(buffer)
            onFileAnalysis(functions, buffer, 'macho', file)
          } else if (isPNG) {
            const metadata = parsePNG(buffer)
            onFileAnalysis(metadata, buffer, 'png', file)
          } else if (isJPG) {
            const metadata = parseJPEG(buffer)
            onFileAnalysis(metadata, buffer, 'jpeg', file)
          } else if (isGIF) {
            const metadata = parseGIF(buffer)
            onFileAnalysis(metadata, buffer, 'gif', file)
          } else {
            throw new Error('Unsupported file format. Please upload a Mach-O binary or image file (PNG, JPEG, GIF).')
          }
        } catch (err) {
          setError(err.message)
        }
      }
      reader.readAsArrayBuffer(file)
    } catch (err) {
      console.error('Error processing file:', err)
      setError('Error processing file: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

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
  }, [])

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
          accept=".o,.dylib,*"
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

// Image format parsers
function parsePNG(buffer) {
  const view = new DataView(buffer)
  const metadata = new Set()
  
  // PNG Header: 89 50 4E 47 0D 0A 1A 0A
  // Then chunks: Length (4) + Type (4) + Data + CRC (4)
  let offset = 8 // Skip signature

  while (offset < buffer.byteLength) {
    const length = view.getUint32(offset, false)
    offset += 4
    
    // Read chunk type
    const type = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    )
    
    if (type === 'IHDR') {
      const width = view.getUint32(offset + 4, false)
      const height = view.getUint32(offset + 8, false)
      const bitDepth = view.getUint8(offset + 12)
      const colorType = view.getUint8(offset + 13)
      
      metadata.add(`Width: ${width}px`)
      metadata.add(`Height: ${height}px`)
      metadata.add(`Bit Depth: ${bitDepth}`)
      metadata.add(`Color Type: ${colorType}`)
    }
    
    offset += 4 + length + 4 // Type + Data + CRC
  }

  return metadata
}

function parseJPEG(buffer) {
  const view = new DataView(buffer)
  const metadata = new Set()
  let offset = 2 // Skip SOI marker

  while (offset < buffer.byteLength) {
    const marker = view.getUint16(offset, false)
    offset += 2
    
    // SOFn markers contain dimensions
    if ((marker & 0xFFF0) === 0xFFC0) {
      const length = view.getUint16(offset, false)
      const precision = view.getUint8(offset + 2)
      const height = view.getUint16(offset + 3, false)
      const width = view.getUint16(offset + 5, false)
      const components = view.getUint8(offset + 7)
      
      metadata.add(`Width: ${width}px`)
      metadata.add(`Height: ${height}px`)
      metadata.add(`Precision: ${precision} bits`)
      metadata.add(`Components: ${components}`)
      break
    }
    
    const length = view.getUint16(offset, false)
    offset += length
  }

  return metadata
}

function parseGIF(buffer) {
  const view = new DataView(buffer)
  const metadata = new Set()
  
  // GIF Header
  const version = String.fromCharCode(
    view.getUint8(3),
    view.getUint8(4),
    view.getUint8(5)
  )
  
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  const flags = view.getUint8(10)
  const bgColor = view.getUint8(11)
  
  metadata.add(`Version: GIF${version}`)
  metadata.add(`Width: ${width}px`)
  metadata.add(`Height: ${height}px`)
  metadata.add(`Background Color Index: ${bgColor}`)
  metadata.add(`Color Resolution: ${((flags >> 4) & 7) + 1} bits`)
  metadata.add(`Global Color Table: ${(flags & 0x80) ? 'Yes' : 'No'}`)
  
  return metadata
}

export default FileUploader