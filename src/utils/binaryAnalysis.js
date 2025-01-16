function isPEFile(view) {
  // Check for MZ header
  if (view.getUint16(0, true) !== 0x5A4D) return false;
  
  // Get PE header offset from e_lfanew
  const peOffset = view.getUint32(0x3C, true)
  
  // Check for PE signature "PE\0\0"
  return view.getUint32(peOffset, true) === 0x00004550
}

function isMachOFile(view) {
  const magic = view.getUint32(0)
  return magic === 0xfeedface || // 32-bit
         magic === 0xfeedfacf || // 64-bit
         magic === 0xcefaedfe || // 32-bit reversed
         magic === 0xcffaedfe || // 64-bit reversed
         magic === 0xcafebabe || // Universal
         magic === 0xbebafeca    // Universal reversed
}

function parsePEExports(view) {
  try {
    const peOffset = view.getUint32(0x3C, true)
    const peHeaderStart = peOffset
    const symbols = new Set()
    
    // Verify PE signature
    if (view.getUint32(peHeaderStart, true) !== 0x00004550) {
      throw new Error('Invalid PE signature')
    }
    
    const fileHeader = peHeaderStart + 4
    const machine = view.getUint16(fileHeader, true)
    const numberOfSections = view.getUint16(fileHeader + 2, true)
    const sizeOfOptionalHeader = view.getUint16(fileHeader + 16, true)
    const isPE64 = machine === 0x8664 // AMD64
    
    const optionalHeaderOffset = fileHeader + 20
    const optionalHeaderMagic = view.getUint16(optionalHeaderOffset, true)
    
    // Get data directories offset based on PE format
    let dataDirectoryOffset
    if (optionalHeaderMagic === 0x10B) { // PE32
      dataDirectoryOffset = optionalHeaderOffset + 96
    } else if (optionalHeaderMagic === 0x20B) { // PE32+ (64-bit)
      dataDirectoryOffset = optionalHeaderOffset + 112
    } else {
      throw new Error('Unsupported PE format')
    }
    
    const sectionHeadersOffset = optionalHeaderOffset + sizeOfOptionalHeader
    
    // Helper function to convert RVA to file offset
    function rvaToFileOffset(rva) {
      for (let i = 0; i < numberOfSections; i++) {
        const sectionHeader = sectionHeadersOffset + (i * 40)
        const virtualAddress = view.getUint32(sectionHeader + 12, true)
        const virtualSize = view.getUint32(sectionHeader + 8, true)
        const rawAddress = view.getUint32(sectionHeader + 20, true)
        const sectionSize = view.getUint32(sectionHeader + 16, true)
        
        if (rva >= virtualAddress && rva < (virtualAddress + virtualSize)) {
          const offset = rawAddress + (rva - virtualAddress)
          if (offset < view.byteLength) {
            return offset
          }
        }
      }
      return null
    }
    
    // Parse Export Directory
    const exportRVA = view.getUint32(dataDirectoryOffset, true)
    const exportSize = view.getUint32(dataDirectoryOffset + 4, true)
    
    if (exportRVA && exportSize) {
      const exportOffset = rvaToFileOffset(exportRVA)
      if (exportOffset) {
        const numberOfNames = view.getUint32(exportOffset + 24, true)
        const namesRVA = view.getUint32(exportOffset + 32, true)
        
        if (namesRVA) {
          const namesOffset = rvaToFileOffset(namesRVA)
          if (namesOffset) {
            // Read export names
            for (let i = 0; i < numberOfNames; i++) {
              const nameRVA = view.getUint32(namesOffset + (i * 4), true)
              const nameOffset = rvaToFileOffset(nameRVA)
              
              if (nameOffset) {
                let name = ''
                let j = 0
                while (j < 512) {
                  const char = view.getUint8(nameOffset + j)
                  if (char === 0) break
                  name += String.fromCharCode(char)
                  j++
                }
                if (name) {
                  symbols.add(`${name} (E)`)
                }
              }
            }
          }
        }
      }
    }
    
    // Parse Symbol Table
    const symbolTableRVA = view.getUint32(fileHeader + 8, true)
    const numberOfSymbols = view.getUint32(fileHeader + 12, true)
    
    if (symbolTableRVA && numberOfSymbols > 0) {
      const stringTableOffset = symbolTableRVA + (numberOfSymbols * 18)
      
      for (let i = 0; i < numberOfSymbols; i++) {
        const symOffset = symbolTableRVA + (i * 18)
        const nameOffset = view.getUint32(symOffset, true)
        const value = view.getUint32(symOffset + 4, true)
        const sectionNumber = view.getUint16(symOffset + 12, true)
        const type = view.getUint16(symOffset + 14, true)
        
        // Read name from string table if it's a string table reference
        if (nameOffset > 0) {
          let name = ''
          let strOffset = stringTableOffset + nameOffset
          let j = 0
          while (j < 512 && strOffset < view.byteLength) {
            const char = view.getUint8(strOffset + j)
            if (char === 0) break
            name += String.fromCharCode(char)
            j++
          }
          if (name) {
            symbols.add(`${name} (S)`)
          }
        }
      }
    }
    
    console.log(`Found ${symbols.size} total symbols`)
    return symbols
    
  } catch (err) {
    console.error('PE parsing error:', err)
    throw new Error(`PE parsing error: ${err.message}`)
  }
}

function parseMachOSymbols(view) {
  try {
    const initialMagic = view.getUint32(0, false)
    let offset = 0
    let currentMagic = initialMagic
    let isLittleEndian = false
    let is64Bit = false
    const functions = new Set()

    // Handle Universal binary
    if (currentMagic === 0xcafebabe || currentMagic === 0xbebafeca) {
      if (view.byteLength < 8) throw new Error('Invalid Universal binary')
      const firstArchOffset = 8
      offset = view.getUint32(firstArchOffset + 8, false)
      currentMagic = view.getUint32(offset, false)
    }

    // Check endianness and architecture
    isLittleEndian = currentMagic === 0xcefaedfe || currentMagic === 0xcffaedfe
    is64Bit = currentMagic === 0xfeedfacf || currentMagic === 0xcffaedfe

    // Parse header
    const headerSize = is64Bit ? 32 : 28
    const ncmds = view.getUint32(offset + 16, isLittleEndian)
    let cmdOffset = offset + headerSize

    // Parse load commands
    for (let i = 0; i < ncmds; i++) {
      if (cmdOffset + 8 > view.byteLength) break

      const cmd = view.getUint32(cmdOffset, isLittleEndian)
      const cmdsize = view.getUint32(cmdOffset + 4, isLittleEndian)

      // LC_SYMTAB = 2
      if (cmd === 2) {
        const symoff = view.getUint32(cmdOffset + 8, isLittleEndian)
        const nsyms = view.getUint32(cmdOffset + 12, isLittleEndian)
        const stroff = view.getUint32(cmdOffset + 16, isLittleEndian)
        const strsize = view.getUint32(cmdOffset + 20, isLittleEndian)

        if (symoff >= view.byteLength || stroff >= view.byteLength) continue

        const symbolSize = is64Bit ? 16 : 12

        for (let j = 0; j < nsyms; j++) {
          const symOffset = symoff + (j * symbolSize)
          if (symOffset + symbolSize > view.byteLength) break

          const strIndex = view.getUint32(symOffset, isLittleEndian)
          if (strIndex >= strsize) continue

          const type = view.getUint8(symOffset + (is64Bit ? 6 : 4))
          const sect = view.getUint8(symOffset + (is64Bit ? 7 : 5))

          // N_STAB = 0xe0, N_PEXT = 0x10, N_TYPE = 0x0e, N_EXT = 0x01
          const isStab = (type & 0xe0) !== 0
          const isExternal = (type & 0x01) !== 0
          const typeField = type & 0x0e

          // Accept both external symbols and symbols in sections
          const isValidSymbol = !isStab && (isExternal || sect !== 0)

          if (isValidSymbol) {
            let name = ''
            let strPos = stroff + strIndex
            let maxLen = 1024

            while (strPos < view.byteLength && maxLen > 0) {
              const char = view.getUint8(strPos)
              if (char === 0) break
              name += String.fromCharCode(char)
              strPos++
              maxLen--
            }

            if (name && name.startsWith('_')) {
              name = name.substring(1)
              const symType = typeField === 0x0 ? 'U' : 'T'
              functions.add(`${name} (${symType})`)
            }
          }
        }
      }
      cmdOffset += cmdsize
    }

    return functions

  } catch (err) {
    console.error('Error parsing Mach-O:', err)
    throw new Error('Invalid Mach-O file structure: ' + err.message)
  }
}

export function analyzeBinary(buffer) {
  const view = new DataView(buffer)
  
  if (isPEFile(view)) {
    return parsePEExports(view)
  }
  
  if (isMachOFile(view)) {
    return parseMachOSymbols(view)
  }
  
  return new Set() // Return empty set for unsupported formats
} 