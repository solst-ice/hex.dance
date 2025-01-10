import React, { useState, useEffect, useRef } from 'react'

function HexDump({ buffer }) {
  const [offset, setOffset] = useState(0)
  const [hoveredByte, setHoveredByte] = useState(null)
  const containerRef = useRef(null)
  const BYTES_PER_ROW = 16
  const ROWS_TO_DISPLAY = 16
  const [isDragging, setIsDragging] = useState(false)
  const [dragStartY, setDragStartY] = useState(0)
  const scrollRef = useRef(null)
  
  if (!buffer) return null
  const view = new DataView(buffer)

  const isZeroRow = (startOffset) => {
    if (startOffset >= buffer.byteLength) return false
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      if (startOffset + i >= buffer.byteLength) break
      if (view.getUint8(startOffset + i) !== 0) return false
    }
    return true
  }

  const findNextOffset = (startOffset, direction = 1) => {
    let currentOffset = startOffset
    
    while (currentOffset >= 0 && currentOffset < buffer.byteLength) {
      if (isZeroRow(currentOffset)) {
        // If moving forward, skip to end of zero sequence
        if (direction > 0) {
          currentOffset = findZeroSequenceEnd(currentOffset) + BYTES_PER_ROW
        } else {
          // If moving backward and we're not at start of sequence,
          // find start of sequence
          let temp = currentOffset - BYTES_PER_ROW
          while (temp >= 0 && isZeroRow(temp)) {
            currentOffset = temp
            temp -= BYTES_PER_ROW
          }
          if (!isZeroRow(temp)) {
            return currentOffset
          }
          currentOffset += direction * BYTES_PER_ROW
        }
      } else {
        return currentOffset
      }
    }
    return direction > 0 ? buffer.byteLength : 0
  }

  const findZeroSequenceEnd = (startOffset) => {
    let currentOffset = startOffset
    while (currentOffset < buffer.byteLength && isZeroRow(currentOffset)) {
      currentOffset += BYTES_PER_ROW
    }
    return currentOffset - BYTES_PER_ROW
  }

  useEffect(() => {
    const handleKeyDown = (e) => {
      switch(e.key) {
        case 'ArrowDown':
          setOffset(prev => {
            const next = findNextOffset(prev + BYTES_PER_ROW)
            return Math.min(next, buffer.byteLength - BYTES_PER_ROW * ROWS_TO_DISPLAY)
          })
          break
        case 'ArrowUp':
          setOffset(prev => {
            const next = findNextOffset(prev - BYTES_PER_ROW, -1)
            return Math.max(0, next)
          })
          break
        case 'PageDown':
          setOffset(prev => {
            const next = findNextOffset(prev + BYTES_PER_ROW * ROWS_TO_DISPLAY)
            return Math.min(next, buffer.byteLength - BYTES_PER_ROW * ROWS_TO_DISPLAY)
          })
          break
        case 'PageUp':
          setOffset(prev => {
            const next = findNextOffset(prev - BYTES_PER_ROW * ROWS_TO_DISPLAY, -1)
            return Math.max(0, next)
          })
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [buffer])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const handleWheel = (e) => {
      e.preventDefault()
      if (e.deltaY !== 0) {
        const direction = Math.sign(e.deltaY)
        setOffset(prev => {
          const next = findNextOffset(prev + direction * BYTES_PER_ROW, direction)
          return Math.max(0, Math.min(
            next,
            buffer.byteLength - BYTES_PER_ROW * ROWS_TO_DISPLAY
          ))
        })
      }
    }

    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [buffer])

  const rows = []
  let currentOffset = offset

  while (rows.length < ROWS_TO_DISPLAY && currentOffset < buffer.byteLength) {
    if (isZeroRow(currentOffset)) {
      // Found start of zero sequence
      const sequenceEnd = findZeroSequenceEnd(currentOffset)
      
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

    for (let col = 0; col < BYTES_PER_ROW; col++) {
      const byteOffset = rowOffset + col
      if (byteOffset >= buffer.byteLength) break

      const byte = view.getUint8(byteOffset)
      const isHovered = hoveredByte === byteOffset
      
      bytes.push(
        <span 
          key={`byte-${byteOffset}`}
          className={`hex-byte ${isHovered ? 'hovered' : ''}`}
          onMouseEnter={() => setHoveredByte(byteOffset)}
          onMouseLeave={() => setHoveredByte(null)}
        >
          {byte.toString(16).padStart(2, '0')}
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
    setOffset(Math.max(0, buffer.byteLength - BYTES_PER_ROW * ROWS_TO_DISPLAY))
  }

  // Count actual displayed rows (excluding skipped zero rows)
  const countDisplayableRows = () => {
    let count = 0
    let currentOffset = 0

    while (currentOffset < buffer.byteLength) {
      if (isZeroRow(currentOffset)) {
        // Found start of zero sequence
        const sequenceEnd = findZeroSequenceEnd(currentOffset)
        
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

    while (currentOffset < targetOffset && currentOffset < buffer.byteLength) {
      if (isZeroRow(currentOffset)) {
        const sequenceEnd = findZeroSequenceEnd(currentOffset)
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
  const currentDisplayedRow = findDisplayedRowNumber(offset)
  const scrollProgress = (currentDisplayedRow / Math.max(totalDisplayableRows - ROWS_TO_DISPLAY, 1)) * 100
  const visiblePercentage = Math.min((ROWS_TO_DISPLAY / totalDisplayableRows) * 100, 100)

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
    const newRow = Math.floor((newProgress / 100) * (totalDisplayableRows - ROWS_TO_DISPLAY))
    
    // Find the actual offset for this row number
    let currentOffset = 0
    let rowCount = 0
    
    while (rowCount < newRow && currentOffset < buffer.byteLength) {
      if (isZeroRow(currentOffset)) {
        const sequenceEnd = findZeroSequenceEnd(currentOffset)
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

    setOffset(currentOffset)
    setDragStartY(e.clientY)
  }

  const handleScrollMouseUp = () => {
    setIsDragging(false)
  }

  // Add event listeners for drag
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleScrollMouseMove)
      window.addEventListener('mouseup', handleScrollMouseUp)
    }
    return () => {
      window.removeEventListener('mousemove', handleScrollMouseMove)
      window.removeEventListener('mouseup', handleScrollMouseUp)
    }
  }, [isDragging, dragStartY])

  return (
    <div className="hex-dump-container">
      <div className="hex-dump-header">
        <h2>Hex Dump <span className="cyberpunk-subtitle">// memory analysis</span></h2>
      </div>
      <div className="hex-dump-wrapper">
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
              top: `${scrollProgress}%`,
              transform: `translateY(-${scrollProgress}%)`
            }}
            onMouseDown={handleScrollMouseDown}
          />
        </div>
        <div 
          className="hex-dump" 
          ref={containerRef}
          tabIndex={0}
        >
          {rows}
        </div>
      </div>
    </div>
  )
}

export default HexDump 