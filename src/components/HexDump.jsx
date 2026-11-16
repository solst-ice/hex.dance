import { useState, useEffect, useRef, useMemo } from 'react'

const BYTES_PER_ROW = 16

// Offset of the first row of the last full page; 0 when the file fits on one page
const lastPageOffset = (byteLength, rowsToDisplay) => {
  const totalRows = Math.ceil(byteLength / BYTES_PER_ROW)
  return Math.max(0, totalRows - Math.max(1, rowsToDisplay)) * BYTES_PER_ROW
}

// Every offset change goes through here so it stays row-aligned and in range
const clampOffset = (value, byteLength, rowsToDisplay) => {
  if (!Number.isFinite(value)) return 0
  const aligned = Math.floor(value / BYTES_PER_ROW) * BYTES_PER_ROW
  return Math.min(Math.max(0, aligned), lastPageOffset(byteLength, rowsToDisplay))
}

const isZeroRow = (view, startOffset) => {
  if (startOffset < 0 || startOffset >= view.byteLength) return false
  for (let i = 0; i < BYTES_PER_ROW; i++) {
    if (startOffset + i >= view.byteLength) break
    if (view.getUint8(startOffset + i) !== 0) return false
  }
  return true
}

const findZeroSequenceEnd = (view, startOffset) => {
  let currentOffset = startOffset
  while (currentOffset < view.byteLength && isZeroRow(view, currentOffset)) {
    currentOffset += BYTES_PER_ROW
  }
  return currentOffset - BYTES_PER_ROW
}

const findNextOffset = (view, startOffset, direction = 1) => {
  let currentOffset = startOffset

  while (currentOffset >= 0 && currentOffset < view.byteLength) {
    if (isZeroRow(view, currentOffset)) {
      // If moving forward, skip to end of zero sequence
      if (direction > 0) {
        currentOffset = findZeroSequenceEnd(view, currentOffset) + BYTES_PER_ROW
      } else {
        // If moving backward and we're not at start of sequence,
        // find start of sequence
        let temp = currentOffset - BYTES_PER_ROW
        while (temp >= 0 && isZeroRow(view, temp)) {
          currentOffset = temp
          temp -= BYTES_PER_ROW
        }
        if (!isZeroRow(view, temp)) {
          return currentOffset
        }
        currentOffset += direction * BYTES_PER_ROW
      }
    } else {
      return currentOffset
    }
  }
  return direction > 0 ? view.byteLength : 0
}

function HexDump({ buffer, fileName }) {
  const [offset, setOffset] = useState(0)
  const [hoveredByte, setHoveredByte] = useState(null)
  const containerRef = useRef(null)
  const [rowsToDisplay, setRowsToDisplay] = useState(16)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStartY, setDragStartY] = useState(0)
  const scrollRef = useRef(null)
  const [editMode, setEditMode] = useState(false)
  const [modifiedBuffer, setModifiedBuffer] = useState(null)
  const [hasModifications, setHasModifications] = useState(false)
  const [showDownload, setShowDownload] = useState(false)
  const hexInputRefs = useRef({})
  const [isFullscreen, setIsFullscreen] = useState(false)

  const view = useMemo(() => (buffer ? new DataView(buffer) : null), [buffer])
  const byteLength = view ? view.byteLength : 0

  useEffect(() => {
    if (!buffer) return
    setModifiedBuffer(new Uint8Array(buffer))
    setHasModifications(false)
    setShowDownload(false)
    setOffset(0)
  }, [buffer])

  // Page size changes (fullscreen, resize) can move the last valid row start
  useEffect(() => {
    setOffset(prev => clampOffset(prev, byteLength, rowsToDisplay))
  }, [byteLength, rowsToDisplay])

  useEffect(() => {
    if (!view) return

    const handleKeyDown = (e) => {
      let move
      switch (e.key) {
        case 'ArrowDown':
          move = prev => findNextOffset(view, prev + BYTES_PER_ROW)
          break
        case 'ArrowUp':
          move = prev => findNextOffset(view, prev - BYTES_PER_ROW, -1)
          break
        case 'PageDown':
          move = prev => findNextOffset(view, prev + BYTES_PER_ROW * rowsToDisplay)
          break
        case 'PageUp':
          move = prev => findNextOffset(view, prev - BYTES_PER_ROW * rowsToDisplay, -1)
          break
        default:
          return
      }
      setOffset(prev => clampOffset(move(prev), view.byteLength, rowsToDisplay))
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [view, rowsToDisplay])

  useEffect(() => {
    const element = containerRef.current
    if (!element || !view) return

    const handleWheel = (e) => {
      e.preventDefault()
      if (e.deltaY !== 0) {
        const direction = Math.sign(e.deltaY)
        setOffset(prev => clampOffset(
          findNextOffset(view, prev + direction * BYTES_PER_ROW, direction),
          view.byteLength,
          rowsToDisplay
        ))
      }
    }

    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [view, rowsToDisplay])

  // Add event listeners for drag; the ref always holds the latest move handler
  const dragMoveRef = useRef(null)
  useEffect(() => {
    if (!isDragging) return
    const handleMouseMove = (e) => dragMoveRef.current?.(e)
    const handleMouseUp = () => setIsDragging(false)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  // Calculate visible rows based on container height
  useEffect(() => {
    const updateVisibleRows = () => {
      if (!containerRef.current) return
      const containerHeight = containerRef.current.clientHeight
      const rowHeight = 24 // Approximate height of each row in pixels
      const newRowCount = Math.floor(containerHeight / rowHeight)
      setRowsToDisplay(isFullscreen ? newRowCount : 16)
    }

    updateVisibleRows()
    window.addEventListener('resize', updateVisibleRows)
    return () => window.removeEventListener('resize', updateVisibleRows)
  }, [isFullscreen])

  // Update rows when toggling fullscreen
  useEffect(() => {
    const timer = setTimeout(() => {
      const containerHeight = containerRef.current?.clientHeight || 0
      const rowHeight = 24 // Approximate height of each row in pixels
      const newRowCount = Math.floor(containerHeight / rowHeight)
      setRowsToDisplay(isFullscreen ? newRowCount : 16)
    }, 100) // Small delay to allow transition to complete

    return () => clearTimeout(timer)
  }, [isFullscreen])

  if (!buffer) return null

  const isEmpty = byteLength === 0
  const displayOffset = clampOffset(offset, byteLength, rowsToDisplay)

  const toggleEditMode = () => {
    if (editMode) {
      setShowDownload(hasModifications)
      setEditMode(false)
    } else {
      setEditMode(true)
    }
  }

  const handleHexChange = (offset, value) => {
    const hex = value.replace(/[^0-9A-Fa-f]/g, '')
    if (hex.length === 2) {
      const byte = parseInt(hex, 16)
      const newBuffer = new Uint8Array(modifiedBuffer)
      newBuffer[offset] = byte
      setModifiedBuffer(newBuffer)
      setHasModifications(true)
    }
  }

  const renderHexByte = (byte, offset) => {
    if (editMode) {
      return (
        <input
          ref={el => hexInputRefs.current[offset] = el}
          type="text"
          maxLength="2"
          className="hex-input"
          defaultValue={byte?.toString(16).padStart(2, '0') || '00'}
          onChange={(e) => handleHexChange(offset, e.target.value)}
        />
      )
    }
    return byte !== undefined ? byte.toString(16).padStart(2, '0') : '00'
  }

  const downloadModifiedFile = () => {
    const blob = new Blob([modifiedBuffer], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    
    // Parse the filename and add -hexdance before the extension
    const lastDot = fileName.lastIndexOf('.')
    const newFileName = lastDot !== -1
      ? `${fileName.slice(0, lastDot)}-hexdance${fileName.slice(lastDot)}`
      : `${fileName}-hexdance`

    const a = document.createElement('a')
    a.href = url
    a.download = newFileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const rows = []
  let currentOffset = displayOffset

  while (rows.length < rowsToDisplay && currentOffset < byteLength) {
    if (isZeroRow(view, currentOffset)) {
      // Found start of zero sequence
      const sequenceEnd = findZeroSequenceEnd(view, currentOffset)
      
      // Add first row of sequence
      rows.push(renderRow(currentOffset))

      // If sequence is more than one row, add skip indicator and last row
      if (sequenceEnd > currentOffset) {
        const skippedRows = (sequenceEnd - currentOffset) / BYTES_PER_ROW - 1
        if (skippedRows > 0) {
          rows.push(
            <div key={`skip-${currentOffset}`} className="hex-row skipped">
              <span className="offset">...</span>
              <div className="hex-bytes">
                <span className="skip-indicator">{skippedRows} identical rows skipped</span>
              </div>
              <div className="ascii-chars"></div>
            </div>
          )
          rows.push(renderRow(sequenceEnd))
        }
        currentOffset = sequenceEnd + BYTES_PER_ROW
      } else {
        currentOffset += BYTES_PER_ROW
      }
    } else {
      rows.push(renderRow(currentOffset))
      currentOffset += BYTES_PER_ROW
    }
  }

  // Helper function to render a single row
  function renderRow(rowOffset) {
    const bytes = []
    const ascii = []

    for (let i = 0; i < BYTES_PER_ROW; i++) {
      const byteOffset = rowOffset + i
      if (byteOffset >= byteLength) break

      // Always use modifiedBuffer if it exists, with fallback for undefined values
      const byte = modifiedBuffer ? modifiedBuffer[byteOffset] : view.getUint8(byteOffset)
      const isHovered = hoveredByte === byteOffset
      
      bytes.push(
        <span 
          key={`byte-${byteOffset}`}
          className={`hex-byte ${isHovered ? 'hovered' : ''}`}
          onMouseEnter={() => setHoveredByte(byteOffset)}
          onMouseLeave={() => setHoveredByte(null)}
        >
          {renderHexByte(byte, byteOffset)}
        </span>
      )

      ascii.push(
        <span 
          key={`ascii-${byteOffset}`}
          className={`ascii-char ${isHovered ? 'hovered' : ''}`}
          onMouseEnter={() => setHoveredByte(byteOffset)}
          onMouseLeave={() => setHoveredByte(null)}
        >
          {byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'}
        </span>
      )
    }

    return (
      <div key={rowOffset} className="hex-row">
        <span className="offset">{rowOffset.toString(16).padStart(8, '0')}</span>
        <div className="hex-bytes">{bytes}</div>
        <div className="ascii-chars">{ascii}</div>
      </div>
    )
  }

  const handleSkipToTop = () => {
    setOffset(0)
  }

  const handleSkipToBottom = () => {
    setOffset(lastPageOffset(byteLength, rowsToDisplay))
  }

  // Count actual displayed rows (excluding skipped zero rows)
  const countDisplayableRows = () => {
    let count = 0
    let currentOffset = 0

    while (currentOffset < byteLength) {
      if (isZeroRow(view, currentOffset)) {
        // Found start of zero sequence
        const sequenceEnd = findZeroSequenceEnd(view, currentOffset)
        
        // Count only first and last row of zero sequence
        if (sequenceEnd > currentOffset) {
          count += 2 // First and last row
          currentOffset = sequenceEnd + BYTES_PER_ROW
        } else {
          count += 1 // Single zero row
          currentOffset += BYTES_PER_ROW
        }
      } else {
        count += 1
        currentOffset += BYTES_PER_ROW
      }
    }
    return count
  }

  // Find the actual row number (excluding skipped rows)
  const findDisplayedRowNumber = (targetOffset) => {
    let count = 0
    let currentOffset = 0

    while (currentOffset < targetOffset && currentOffset < byteLength) {
      if (isZeroRow(view, currentOffset)) {
        const sequenceEnd = findZeroSequenceEnd(view, currentOffset)
        if (sequenceEnd > currentOffset) {
          if (targetOffset > sequenceEnd) {
            count += 2 // Count first and last row of sequence
          } else if (targetOffset > currentOffset) {
            count += 1 // Count only first row
          }
          currentOffset = sequenceEnd + BYTES_PER_ROW
        } else {
          count += 1
          currentOffset += BYTES_PER_ROW
        }
      } else {
        count += 1
        currentOffset += BYTES_PER_ROW
      }
    }
    return count
  }

  // Calculate scroll progress based on actual displayed rows
  const totalDisplayableRows = countDisplayableRows()
  const currentDisplayedRow = findDisplayedRowNumber(displayOffset)
  const maxScroll = editMode ? 95 : 98  // Higher limit when not in edit mode
  const scrollProgress = Math.min(
    (currentDisplayedRow / Math.max(totalDisplayableRows - rowsToDisplay, 1)) * 100,
    maxScroll  // Use conditional max scroll value
  )
  const visiblePercentage = totalDisplayableRows > 0
    ? Math.min((rowsToDisplay / totalDisplayableRows) * 100, 100)
    : 100

  // Add drag handlers
  const handleScrollMouseDown = (e) => {
    setIsDragging(true)
    setDragStartY(e.clientY)
    e.preventDefault()
  }

  const handleScrollMouseMove = (e) => {
    if (!isDragging || !scrollRef.current) return

    const scrollRect = scrollRef.current.getBoundingClientRect()
    const scrollHeight = scrollRect.height
    const deltaY = e.clientY - dragStartY
    const deltaPercent = (deltaY / scrollHeight) * 100

    // Calculate new offset based on scroll position
    const newProgress = Math.max(0, Math.min(100, scrollProgress + deltaPercent))
    const newRow = Math.floor((newProgress / 100) * (totalDisplayableRows - rowsToDisplay))
    
    // Find the actual offset for this row number
    let currentOffset = 0
    let rowCount = 0
    
    while (rowCount < newRow && currentOffset < byteLength) {
      if (isZeroRow(view, currentOffset)) {
        const sequenceEnd = findZeroSequenceEnd(view, currentOffset)
        if (sequenceEnd > currentOffset) {
          rowCount += 2
          currentOffset = sequenceEnd + BYTES_PER_ROW
        } else {
          rowCount += 1
          currentOffset += BYTES_PER_ROW
        }
      } else {
        rowCount += 1
        currentOffset += BYTES_PER_ROW
      }
    }

    setOffset(clampOffset(currentOffset, byteLength, rowsToDisplay))
    setDragStartY(e.clientY)
  }
  dragMoveRef.current = handleScrollMouseMove

  return (
    <div className={`hex-dump-container ${editMode ? 'edit-mode' : ''} ${isFullscreen ? 'fullscreen' : ''}`}>
      <div className="hex-dump-header">
        <h2>Hex Dump</h2>
        <div className="header-controls">
          {editMode && <span className="edit-mode-label">EDIT MODE ENABLED</span>}
          <button 
            className="fullscreen-button"
            onClick={() => setIsFullscreen(!isFullscreen)}
            title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          >
            <span>{isFullscreen ? '⊠' : '⛶'}</span>
          </button>
          {(!isEmpty || editMode) && (
            <button 
              className={`edit-button ${editMode ? 'active' : ''}`}
              onClick={toggleEditMode}
            >
              {editMode ? 'SAVE' : 'EDIT'}
            </button>
          )}
          {showDownload && (
            <button 
              className="download-button" 
              onClick={downloadModifiedFile}
            >
              DOWNLOAD
            </button>
          )}
        </div>
      </div>
      <div className="hex-dump-wrapper">
        {!isEmpty && (
          <>
            <button 
              onClick={handleSkipToTop} 
              className="nav-arrow top"
              title="Jump to top"
            >
              ▲
            </button>
            <button 
              onClick={handleSkipToBottom} 
              className="nav-arrow bottom"
              title="Jump to bottom"
            >
              ▼
            </button>
            <div className="scroll-indicator" ref={scrollRef}>
              <div 
                className="scroll-thumb" 
                style={{ 
                  height: `${visiblePercentage}%`,
                  top: `${Math.min(scrollProgress, maxScroll)}%`,
                  transform: `translateY(-${Math.min(scrollProgress, maxScroll)}%)`
                }}
                onMouseDown={handleScrollMouseDown}
              />
            </div>
          </>
        )}
        <div 
          className="hex-dump" 
          ref={containerRef}
          tabIndex={0}
        >
          {isEmpty ? (
            <p className="hex-dump-empty" style={{ color: 'var(--neon-blue)', opacity: 0.7, margin: '10px 0' }}>
              This file is empty (0 bytes), so there is nothing to show.
            </p>
          ) : rows}
        </div>
      </div>
    </div>
  )
}

export default HexDump