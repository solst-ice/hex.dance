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

  // Add PE file detection
  const isPE = (buffer) => {
    const view = new DataView(buffer)
    // Check for MZ signature
    if (view.getUint16(0, true) !== 0x5A4D) return false
    
    // Get PE header offset from e_lfanew
    const peOffset = view.getUint32(0x3C, true)
    // Check for PE signature
    return view.getUint32(peOffset, true) === 0x4550 // "PE\0\0"
  }

  // Add PE parser function
  function parsePE(buffer) {
    const view = new DataView(buffer)
    const functions = new Set()
    
    try {
      // Get PE header offset
      const peOffset = view.getUint32(0x3C, true)
      
      // Read COFF header fields
      const numberOfSections = view.getUint16(peOffset + 6, true)
      const optionalHeaderSize = view.getUint16(peOffset + 20, true)
      
      // Optional header offset
      const optOffset = peOffset + 24
      
      // Check if 32-bit or 64-bit PE
      const is64 = view.getUint16(optOffset, true) === 0x20B
      
      // Get data directory offset
      const dataDirectoryOffset = is64 
        ? optOffset + 112  // PE32+
        : optOffset + 96   // PE32
      
      // Get export directory RVA and size
      const exportDirRVA = view.getUint32(dataDirectoryOffset, true)
      const exportDirSize = view.getUint32(dataDirectoryOffset + 4, true)
      
      if (exportDirRVA === 0) {
        return functions // No exports
      }
      
      // Parse section headers to find export section
      const sectionHeadersOffset = optOffset + optionalHeaderSize
      let exportFileOffset = null
      
      for (let i = 0; i < numberOfSections; i++) {
        const sectionOffset = sectionHeadersOffset + (i * 40)
        const virtualAddress = view.getUint32(sectionOffset + 12, true)
        const rawAddress = view.getUint32(sectionOffset + 20, true)
        const sectionSize = view.getUint32(sectionOffset + 16, true)
        
        // Check if export directory is in this section
        if (exportDirRVA >= virtualAddress && exportDirRVA < virtualAddress + sectionSize) {
          exportFileOffset = rawAddress + (exportDirRVA - virtualAddress)
          break
        }
      }
      
      if (exportFileOffset === null) return functions
      
      // Read export directory
      const numberOfNames = view.getUint32(exportFileOffset + 24, true)
      const addressOfNames = view.getUint32(exportFileOffset + 32, true)
      
      // Find section containing name RVAs
      let nameTableOffset = null
      for (let i = 0; i < numberOfSections; i++) {
        const sectionOffset = sectionHeadersOffset + (i * 40)
        const virtualAddress = view.getUint32(sectionOffset + 12, true)
        const rawAddress = view.getUint32(sectionOffset + 20, true)
        const sectionSize = view.getUint32(sectionOffset + 16, true)
        
        if (addressOfNames >= virtualAddress && addressOfNames < virtualAddress + sectionSize) {
          nameTableOffset = rawAddress + (addressOfNames - virtualAddress)
          break
        }
      }
      
      if (nameTableOffset === null) return functions
      
      // Read function names
      for (let i = 0; i < numberOfNames; i++) {
        const nameRVA = view.getUint32(nameTableOffset + (i * 4), true)
        
        // Find section containing this name
        for (let j = 0; j < numberOfSections; j++) {
          const sectionOffset = sectionHeadersOffset + (j * 40)
          const virtualAddress = view.getUint32(sectionOffset + 12, true)
          const rawAddress = view.getUint32(sectionOffset + 20, true)
          const sectionSize = view.getUint32(sectionOffset + 16, true)
          
          if (nameRVA >= virtualAddress && nameRVA < virtualAddress + sectionSize) {
            const nameOffset = rawAddress + (nameRVA - virtualAddress)
            
            // Read null-terminated function name
            let name = ''
            let k = 0
            while (k < 256) { // Prevent infinite loop
              const char = view.getUint8(nameOffset + k)
              if (char === 0) break
              name += String.fromCharCode(char)
              k++
            }
            
            if (name) {
              functions.add(`${name} (E)`) // E for Export
            }
            break
          }
        }
      }
      
    } catch (err) {
      console.error('Error parsing PE file:', err)
      throw new Error('Invalid PE file structure: ' + err.message)
    }
    
    return functions
  }

  // Add ELF detection
  const isELF = (buffer) => {
    const view = new DataView(buffer)
    // Check for ELF magic number: 0x7F 'ELF'
    return view.getUint32(0, false) === 0x7F454C46
  }

  // Add ELF parser function
  function parseELF(buffer) {
    const view = new DataView(buffer)
    const functions = new Set()
    
    try {
      // Verify ELF magic number
      if (!isELF(buffer)) throw new Error('Not a valid ELF file')
      
      // Check if 32 or 64 bit
      const is64 = view.getUint8(4) === 2
      const isLittleEndian = view.getUint8(5) === 1
      
      // Get section header info
      const shoff = is64 ? view.getBigUint64(40, isLittleEndian) : view.getUint32(32, isLittleEndian)
      const shentsize = view.getUint16(is64 ? 58 : 46, isLittleEndian)
      const shnum = view.getUint16(is64 ? 60 : 48, isLittleEndian)
      const shstrndx = view.getUint16(is64 ? 62 : 50, isLittleEndian)
      
      // Find string table section
      const strTableOffset = Number(shoff) + (shstrndx * shentsize)
      const strTableAddr = is64
        ? view.getBigUint64(strTableOffset + 24, isLittleEndian)
        : view.getUint32(strTableOffset + 16, isLittleEndian)
      
      // Helper to read null-terminated string
      const readString = (offset) => {
        let str = ''
        let i = 0
        while (offset + i < buffer.byteLength) {
          const char = view.getUint8(offset + i)
          if (char === 0) break
          str += String.fromCharCode(char)
          i++
        }
        return str
      }
      
      // Find symbol tables
      for (let i = 0; i < shnum; i++) {
        const sectionOffset = Number(shoff) + (i * shentsize)
        const sectionType = view.getUint32(sectionOffset + 4, isLittleEndian)
        
        // SHT_SYMTAB = 2, SHT_DYNSYM = 11
        if (sectionType === 2 || sectionType === 11) {
          const symtabOffset = is64
            ? view.getBigUint64(sectionOffset + 24, isLittleEndian)
            : view.getUint32(sectionOffset + 16, isLittleEndian)
          const symtabSize = is64
            ? view.getBigUint64(sectionOffset + 32, isLittleEndian)
            : view.getUint32(sectionOffset + 20, isLittleEndian)
          const symtabEntsize = is64
            ? view.getBigUint64(sectionOffset + 56, isLittleEndian)
            : view.getUint32(sectionOffset + 36, isLittleEndian)
          
          // Get associated string table
          const linkIdx = view.getUint32(sectionOffset + 8, isLittleEndian)
          const strOffset = Number(shoff) + (linkIdx * shentsize)
          const strAddr = is64
            ? view.getBigUint64(strOffset + 24, isLittleEndian)
            : view.getUint32(strOffset + 16, isLittleEndian)
          
          // Parse symbols
          const numSymbols = Number(symtabSize) / Number(symtabEntsize)
          for (let j = 0; j < numSymbols; j++) {
            const symOffset = Number(symtabOffset) + (j * Number(symtabEntsize))
            
            // Get symbol info
            const nameOffset = view.getUint32(symOffset, isLittleEndian)
            const info = view.getUint8(is64 ? symOffset + 4 : symOffset + 12)
            const type = info & 0xf
            
            // ST_FUNC = 2, STT_OBJECT = 1
            if (type === 2 || type === 1) {
              const name = readString(Number(strAddr) + nameOffset)
              if (name) {
                const bind = info >> 4
                // Add symbol type: L=local, G=global, W=weak
                const bindType = bind === 0 ? 'L' : bind === 1 ? 'G' : bind === 2 ? 'W' : 'U'
                functions.add(`${name} (${bindType})`)
              }
            }
          }
        }
      }
      
    } catch (err) {
      console.error('Error parsing ELF file:', err)
      throw new Error('Invalid ELF file structure: ' + err.message)
    }
    
    return functions
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
          const view = new DataView(buffer)
          const magic = view.getUint32(0, false)
          const firstBytes = view.getUint16(0, false)
          
          // Basic metadata for any file
          const basicMetadata = new Set([
            `File Size: ${formatBytes(buffer.byteLength)}`,
            `First Bytes: 0x${magic.toString(16).padStart(8, '0').toUpperCase()}`,
            `File Type: ${file.type || 'application/octet-stream'}`
          ])

          // Try to identify and process known formats
          if (isMachO(buffer)) {
            const functions = parseMachO(buffer)
            onFileAnalysis(functions, buffer, 'macho', file)
          } else if (isPE(buffer)) {
            const functions = parsePE(buffer)
            onFileAnalysis(functions, buffer, 'pe', file)
          } else if (isELF(buffer)) {
            const functions = parseELF(buffer)
            onFileAnalysis(functions, buffer, 'elf', file)
          } else if (magic === 0x89504E47) {
            const metadata = parsePNG(buffer)
            onFileAnalysis(metadata, buffer, 'png', file)
          } else if (firstBytes === 0xFFD8) {
            const metadata = parseJPEG(buffer)
            onFileAnalysis(metadata, buffer, 'jpeg', file)
          } else if (magic === 0x47494638) {
            const metadata = parseGIF(buffer)
            onFileAnalysis(metadata, buffer, 'gif', file)
          } else if (String.fromCharCode(...new Uint8Array(buffer.slice(0, 5))) === '%PDF-') {
            const metadata = parsePDF(buffer)
            onFileAnalysis(metadata, buffer, 'pdf', file)
          } else if (magic === 0x504B0304) {
            const { metadata, contents } = parseZIP(buffer)
            onFileAnalysis({ metadata, contents }, buffer, 'zip', file)
          } else {
            // Unknown file type - show basic metadata and hex dump
            setError('Note: This file format is not specifically supported, showing basic information.')
            onFileAnalysis(basicMetadata, buffer, 'unknown', file)
          }
        } catch (err) {
          // On parsing error, still show basic metadata and hex dump
          setError('Error parsing file: ' + err.message)
          const basicMetadata = new Set([
            `File Size: ${formatBytes(buffer.byteLength)}`,
            `File Type: ${file.type || 'application/octet-stream'}`
          ])
          onFileAnalysis(basicMetadata, buffer, 'unknown', file)
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
          accept=".o,.dylib,.pdf,.zip,image/*"
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

// Add PDF parser function
function parsePDF(buffer) {
  const view = new DataView(buffer)
  const metadata = new Set()
  
  // Helper function to clean PDF strings
  const cleanPDFString = (str) => {
    return str
      .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
      .replace(/\uFFFD/g, '') // Remove replacement character
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim()
  }

  // Get PDF version
  let version = ''
  for (let i = 5; i < 8; i++) {
    const char = String.fromCharCode(view.getUint8(i))
    if (char === '\n' || char === '\r') break
    version += char
  }
  metadata.add(`Version: PDF ${version}`)
  
  // Get file size
  metadata.add(`File Size: ${formatBytes(buffer.byteLength)}`)
  
  // Look for metadata in PDF
  const text = new TextDecoder().decode(buffer)
  
  // Try to find creation date
  const creationMatch = text.match(/\/CreationDate\s*\((D:)?([^)]+)\)/)
  if (creationMatch) {
    let date = creationMatch[2]
    // Format PDF date (YYYYMMDDHHmmSS) to readable format
    if (date.length >= 14) {
      const year = date.slice(0, 4)
      const month = date.slice(4, 6)
      const day = date.slice(6, 8)
      const hour = date.slice(8, 10)
      const minute = date.slice(10, 12)
      const second = date.slice(12, 14)
      date = `${year}-${month}-${day} ${hour}:${minute}:${second}`
    }
    metadata.add(`Creation Date: ${cleanPDFString(date)}`)
  }
  
  // Try to find author
  const authorMatch = text.match(/\/Author\s*\(([^)]+)\)/)
  if (authorMatch) {
    metadata.add(`Author: ${cleanPDFString(authorMatch[1])}`)
  }
  
  // Try to find title
  const titleMatch = text.match(/\/Title\s*\(([^)]+)\)/)
  if (titleMatch) {
    const cleanTitle = cleanPDFString(titleMatch[1])
    if (cleanTitle) { // Only add if there's actual content after cleaning
      metadata.add(`Title: ${cleanTitle}`)
    }
  }
  
  // Try to find producer
  const producerMatch = text.match(/\/Producer\s*\(([^)]+)\)/)
  if (producerMatch) {
    metadata.add(`Producer: ${cleanPDFString(producerMatch[1])}`)
  }
  
  // Try to find page count
  const pageCountMatch = text.match(/\/Count\s+(\d+)/)
  if (pageCountMatch) {
    metadata.add(`Pages: ${pageCountMatch[1]}`)
  }
  
  return metadata
}

// Add ZIP parser function
function parseZIP(buffer) {
  const view = new DataView(buffer)
  const metadata = new Set()
  const contents = new Set()  // Separate set for contents
  let offset = 0
  const files = []
  const treeItems = new Set()

  // Get file size
  metadata.add(`File Size: ${formatBytes(buffer.byteLength)}`)

  // Parse central directory
  while (offset < buffer.byteLength - 4) {
    const signature = view.getUint32(offset, true)
    
    if (signature === 0x04034b50) {
      offset += 4
      offset += 4 // Skip version and flags
      const compressionMethod = view.getUint16(offset, true)
      offset += 2
      offset += 4 // Skip time and date
      offset += 4 // Skip CRC
      const compressedSize = view.getUint32(offset, true)
      offset += 4
      const uncompressedSize = view.getUint32(offset, true)
      offset += 4
      const fileNameLength = view.getUint16(offset, true)
      offset += 2
      const extraFieldLength = view.getUint16(offset, true)
      offset += 2

      // Read filename
      let fileName = ''
      for (let i = 0; i < fileNameLength; i++) {
        fileName += String.fromCharCode(view.getUint8(offset + i))
      }
      
      // Skip data
      offset += fileNameLength + extraFieldLength + compressedSize

      files.push({
        name: fileName,
        size: uncompressedSize,
        compressed: compressionMethod !== 0,
        isDirectory: fileName.endsWith('/')
      })
    } else {
      offset++
    }
  }

  // Build tree structure
  const tree = {}
  files.forEach(file => {
    const parts = file.name.split('/')
    let current = tree
    
    parts.forEach((part, index) => {
      if (!part && index === parts.length - 1) return // Skip empty parts at end (directories)
      
      if (!current[part]) {
        current[part] = {
          _files: [],
          _meta: file.name === parts.slice(0, index + 1).join('/') ? file : null
        }
      }
      
      if (index === parts.length - 1 && !file.isDirectory) {
        current[part]._files.push(file)
      }
      
      current = current[part]
    })
  })

  // Convert tree to ASCII format
  function renderTree(node, prefix = '', isLast = true, parentPrefix = '') {
    const entries = Object.entries(node)
      .filter(([key]) => !key.startsWith('_'))
      .sort(([a], [b]) => a.localeCompare(b))

    entries.forEach(([name, subNode], index) => {
      const isLastEntry = index === entries.length - 1
      const displayPrefix = parentPrefix + (isLast ? '└── ' : '├── ')
      const newParentPrefix = parentPrefix + (isLast ? '    ' : '│   ')
      
      // Add directory name
      if (subNode._meta?.isDirectory) {
        treeItems.add(`${displayPrefix}${name}/`)
      } else if (subNode._files.length === 0) {
        treeItems.add(`${displayPrefix}${name}/`)
      } else {
        treeItems.add(`${displayPrefix}${name}`)
      }

      // Add files in this directory
      subNode._files.forEach((file, fileIndex) => {
        const isLastFile = fileIndex === subNode._files.length - 1 && entries.length === 0
        const filePrefix = newParentPrefix + (isLastFile ? '└── ' : '├── ')
        treeItems.add(`${filePrefix}${file.name.split('/').pop()} (${formatBytes(file.size)}${file.compressed ? ', compressed' : ''})`)
      })

      // Recurse into subdirectories
      renderTree(subNode, prefix + '  ', isLastEntry, newParentPrefix)
    })
  }

  // Add file count
  const fileCount = files.filter(f => !f.isDirectory).length
  metadata.add(`Total Files: ${fileCount}`)
  
  // Add the tree structure to contents instead of metadata
  treeItems.add('.')
  renderTree(tree, '', true)
  contents.add(`${Array.from(treeItems).join('\n')}`)

  return { metadata, contents }  // Return both sets
}

// Helper function to format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export default FileUploader