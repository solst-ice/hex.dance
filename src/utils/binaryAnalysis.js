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
    
    // Add basic PE metadata
    const fileHeader = peHeaderStart + 4
    const machine = view.getUint16(fileHeader, true)
    const numberOfSections = view.getUint16(fileHeader + 2, true)
    const characteristics = view.getUint16(fileHeader + 18, true)
    const timestamp = new Date(view.getUint32(fileHeader + 4, true) * 1000).toISOString()
    
    // Add machine type and timestamp
    const machineTypes = {
      0x14c: 'x86',
      0x8664: 'x64',
      0x1c0: 'ARM',
      0xaa64: 'ARM64'
    }
    symbols.add(`Architecture: ${machineTypes[machine] || `Unknown (0x${machine.toString(16)})`}`)
    symbols.add(`Timestamp: ${timestamp}`)
    symbols.add(`Characteristics: 0x${characteristics.toString(16).toUpperCase()}`)
    
    // Parse sections
    const optionalHeaderSize = view.getUint16(fileHeader + 16, true)
    const optionalHeaderOffset = fileHeader + 20
    const optionalHeaderMagic = view.getUint16(optionalHeaderOffset, true)
    const isPE32Plus = optionalHeaderMagic === 0x20B

    // Get section headers
    const sectionHeadersOffset = optionalHeaderOffset + optionalHeaderSize
    for (let i = 0; i < numberOfSections; i++) {
      const sectionOffset = sectionHeadersOffset + (i * 40)
      const name = Array.from(new Uint8Array(view.buffer, sectionOffset, 8))
        .map(b => b ? String.fromCharCode(b) : '')
        .join('')
        .replace(/\0/g, '')
      
      const virtualSize = view.getUint32(sectionOffset + 8, true)
      const virtualAddress = view.getUint32(sectionOffset + 12, true)
      const rawSize = view.getUint32(sectionOffset + 16, true)
      const rawAddress = view.getUint32(sectionOffset + 20, true)
      const characteristics = view.getUint32(sectionOffset + 36, true)

      // Decode section characteristics
      const sectionFlags = []
      if (characteristics & 0x20) sectionFlags.push('Code')
      if (characteristics & 0x40) sectionFlags.push('Initialized Data')
      if (characteristics & 0x80) sectionFlags.push('Uninitialized Data')
      if (characteristics & 0x200) sectionFlags.push('Link Info')
      if (characteristics & 0x1000000) sectionFlags.push('Extended Relocations')
      if (characteristics & 0x2000000) sectionFlags.push('Discardable')
      if (characteristics & 0x4000000) sectionFlags.push('Not Cached')
      if (characteristics & 0x8000000) sectionFlags.push('Not Paged')
      if (characteristics & 0x10000000) sectionFlags.push('Shared')
      if (characteristics & 0x20000000) sectionFlags.push('Executable')
      if (characteristics & 0x40000000) sectionFlags.push('Readable')
      if (characteristics & 0x80000000) sectionFlags.push('Writable')

      // Add detailed section info
      symbols.add(`Section ${name}:`)
      symbols.add(`  Virtual Size: 0x${virtualSize.toString(16).toUpperCase()} bytes`)
      symbols.add(`  Virtual Address: 0x${virtualAddress.toString(16).toUpperCase()}`)
      symbols.add(`  Raw Size: 0x${rawSize.toString(16).toUpperCase()} bytes`)
      symbols.add(`  Characteristics: ${sectionFlags.join(', ')}`)
    }
    
    // Parse exports
    const dataDirectoryOffset = isPE32Plus ? optionalHeaderOffset + 112 : optionalHeaderOffset + 96
    const exportRVA = view.getUint32(dataDirectoryOffset, true)
    const exportSize = view.getUint32(dataDirectoryOffset + 4, true)
    
    if (exportRVA && exportSize) {
      const exportOffset = rvaToFileOffset(view, exportRVA, sectionHeadersOffset, numberOfSections)
      if (exportOffset) {
        // Read export directory
        const dllName = readNullTerminatedString(view, rvaToFileOffset(view, view.getUint32(exportOffset + 12, true), sectionHeadersOffset, numberOfSections))
        const ordinalBase = view.getUint32(exportOffset + 16, true)
        const numberOfNames = view.getUint32(exportOffset + 24, true)
        
        symbols.add(`\nExport Directory:`)
        symbols.add(`  DLL Name: ${dllName}`)
        symbols.add(`  Ordinal Base: ${ordinalBase}`)
        symbols.add(`  Number of Exports: ${numberOfNames}`)
        
        const namesRVA = view.getUint32(exportOffset + 32, true)
        const ordinalsRVA = view.getUint32(exportOffset + 36, true)
        const functionsRVA = view.getUint32(exportOffset + 28, true)
        
        if (namesRVA) {
          const namesOffset = rvaToFileOffset(view, namesRVA, sectionHeadersOffset, numberOfSections)
          const ordinalsOffset = rvaToFileOffset(view, ordinalsRVA, sectionHeadersOffset, numberOfSections)
          const functionsOffset = rvaToFileOffset(view, functionsRVA, sectionHeadersOffset, numberOfSections)
          
          symbols.add(`\nExported Functions:`)
          for (let i = 0; i < numberOfNames; i++) {
            const nameRVA = view.getUint32(namesOffset + (i * 4), true)
            const nameOffset = rvaToFileOffset(view, nameRVA, sectionHeadersOffset, numberOfSections)
            
            if (nameOffset) {
              const name = readNullTerminatedString(view, nameOffset)
              if (name) {
                const ordinal = view.getUint16(ordinalsOffset + (i * 2), true)
                const functionRVA = view.getUint32(functionsOffset + (ordinal * 4), true)
                symbols.add(`  ${name} (Ordinal: ${ordinal + ordinalBase}, RVA: 0x${functionRVA.toString(16).toUpperCase()})`)
              }
            }
          }
        }
      }
    }
    
    return symbols
  } catch (err) {
    console.error('PE parsing error:', err)
    throw new Error(`PE parsing error: ${err.message}`)
  }
}

// Helper function to read null-terminated string
function readNullTerminatedString(view, offset) {
  if (!offset) return ''
  let result = ''
  let i = 0
  while (offset + i < view.byteLength && i < 512) {
    const char = view.getUint8(offset + i)
    if (char === 0) break
    result += String.fromCharCode(char)
    i++
  }
  return result
}

// Helper function to convert RVA to file offset
function rvaToFileOffset(view, rva, sectionHeadersOffset, numberOfSections) {
  for (let i = 0; i < numberOfSections; i++) {
    const sectionOffset = sectionHeadersOffset + (i * 40)
    const virtualAddress = view.getUint32(sectionOffset + 12, true)
    const virtualSize = view.getUint32(sectionOffset + 8, true)
    const rawAddress = view.getUint32(sectionOffset + 20, true)
    const rawSize = view.getUint32(sectionOffset + 16, true)
    
    if (rva >= virtualAddress && rva < (virtualAddress + virtualSize)) {
      const offset = rawAddress + (rva - virtualAddress)
      if (offset < view.byteLength) {
        return offset
      }
    }
  }
  return null
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

// Add ELF detection function
function isELFFile(view) {
  // Check for ELF magic number: 0x7F 'ELF'
  try {
    // First byte should be 0x7F
    if (view.getUint8(0) !== 0x7F) return false
    
    // Next three bytes should be 'ELF' in ASCII
    const e = view.getUint8(1)
    const l = view.getUint8(2)
    const f = view.getUint8(3)
    
    return e === 0x45 && l === 0x4C && f === 0x46
  } catch (err) {
    console.error('Error checking ELF magic:', err)
    return false
  }
}

// Add ELF parser function
function parseELFSymbols(view) {
  try {
    const symbols = new Set()
    
    // Parse ELF header
    const is64Bit = view.getUint8(4) === 2
    const isLittleEndian = view.getUint8(5) === 1
    const machine = view.getUint16(18, isLittleEndian)
    
    // Add basic ELF metadata
    const machineTypes = {
      0x03: 'Intel 80386 (x86)',
      0x3E: 'AMD x86-64',
      0x28: 'ARM',
      0xB7: 'AArch64',
      0x02: 'SPARC',
      0x14: 'PowerPC',
      0x15: 'PowerPC 64-bit',
      0x32: 'IA-64',
      0x3E8: 'RISC-V'
    }
    const metadata = {
      architecture: {
        title: `Architecture: ${machineTypes[machine] || `Unknown (0x${machine.toString(16)})`}`,
        details: [
          'Processor architecture for this binary',
          'Determines the instruction set and register layout',
          'Affects binary compatibility and performance',
          machineTypes[machine] ? `Common in ${machineTypes[machine].includes('x86') ? 'desktop/server' : 'mobile/embedded'} systems` : ''
        ]
      },
      class: {
        title: `Class: ${is64Bit ? 'ELF64' : 'ELF32'}`,
        details: [
          is64Bit ? '64-bit format, supports > 4GB address space' : '32-bit format, limited to 4GB address space',
          is64Bit ? 'Larger pointer size (8 bytes)' : 'Smaller pointer size (4 bytes)',
          is64Bit ? 'Better for large applications and modern systems' : 'Common in older or embedded systems',
          `Memory model: ${is64Bit ? 'LP64 (longs and pointers are 64-bit)' : 'ILP32 (ints, longs, and pointers are 32-bit)'}`
        ]
      },
      endianness: {
        title: `Endianness: ${isLittleEndian ? 'Little Endian' : 'Big Endian'}`,
        details: [
          isLittleEndian ? 'Least significant byte stored first (x86/ARM)' : 'Most significant byte stored first (older SPARC/PowerPC)',
          'Affects how multi-byte values are stored in memory',
          isLittleEndian ? 'Common in x86, ARM, and most modern processors' : 'Used in older RISC architectures',
          `Example: 0x1234 stored as ${isLittleEndian ? '34 12' : '12 34'}`
        ]
      }
    }

    // Add metadata to symbols set with JSON-encoded details
    symbols.add(`${metadata.architecture.title}\x00${JSON.stringify(metadata.architecture.details)}`)
    symbols.add(`${metadata.class.title}\x00${JSON.stringify(metadata.class.details)}`)
    symbols.add(`${metadata.endianness.title}\x00${JSON.stringify(metadata.endianness.details)}`)

    // Get section header info
    const shoff = is64Bit ? Number(view.getBigUint64(40, isLittleEndian)) : view.getUint32(32, isLittleEndian)
    const shentsize = view.getUint16(is64Bit ? 58 : 46, isLittleEndian)
    const shnum = view.getUint16(is64Bit ? 60 : 48, isLittleEndian)
    const shstrndx = view.getUint16(is64Bit ? 62 : 50, isLittleEndian)
    
    // Validate section header offset
    if (shoff >= view.byteLength) {
      throw new Error('Invalid section header offset')
    }

    // Helper function to read null-terminated string from string table
    function readStringFromTable(stringTable, offset) {
      if (offset >= stringTable.byteLength) return ''
      let str = ''
      let i = offset
      while (i < stringTable.byteLength) {
        const char = stringTable.getUint8(i)
        if (char === 0) break
        str += String.fromCharCode(char)
        i++
      }
      return str
    }
    
    // First pass: find string and symbol tables
    let symtab = null
    let strtab = null
    let dynsym = null
    let dynstr = null
    
    for (let i = 0; i < shnum; i++) {
      const secOffset = shoff + (i * shentsize)
      if (secOffset + shentsize > view.byteLength) break
      
      const sh_type = view.getUint32(secOffset + 4, isLittleEndian)
      const sh_offset = is64Bit ? 
        Number(view.getBigUint64(secOffset + 24, isLittleEndian)) : 
        view.getUint32(secOffset + 16, isLittleEndian)
      const sh_size = is64Bit ?
        Number(view.getBigUint64(secOffset + 32, isLittleEndian)) :
        view.getUint32(secOffset + 20, isLittleEndian)
      
      if (sh_type === 2) { // SHT_SYMTAB
        symtab = { offset: sh_offset, size: sh_size }
      } else if (sh_type === 11) { // SHT_DYNSYM
        dynsym = { offset: sh_offset, size: sh_size }
      } else if (sh_type === 3) { // SHT_STRTAB
        const nameOffset = view.getUint32(secOffset, isLittleEndian)
        const name = readStringFromTable(new DataView(view.buffer, shoff + (shstrndx * shentsize)), nameOffset)
        if (name === '.strtab') {
          strtab = { offset: sh_offset, size: sh_size }
        } else if (name === '.dynstr') {
          dynstr = { offset: sh_offset, size: sh_size }
        }
      }
    }
    
    // Function to parse symbol table
    function parseSymTable(symOffset, symSize, strTableOffset, prefix) {
      if (!symOffset || !strTableOffset) return
      
      const entrySize = is64Bit ? 24 : 16
      const numSymbols = Math.floor(symSize / entrySize)
      const strTable = new DataView(view.buffer, strTableOffset)
      
      for (let i = 0; i < numSymbols; i++) {
        const offset = symOffset + (i * entrySize)
        if (offset + entrySize > view.byteLength) break
        
        const st_name = view.getUint32(offset, isLittleEndian)
        const st_info = view.getUint8(is64Bit ? offset + 4 : offset + 12)
        const st_value = is64Bit ?
          Number(view.getBigUint64(offset + 8, isLittleEndian)) :
          view.getUint32(offset + 4, isLittleEndian)
        
        const type = st_info & 0xf
        const bind = st_info >> 4
        
        // Only process function (type 2) or object (type 1) symbols
        if ((type === 2 || type === 1) && st_name !== 0) {
          const name = readStringFromTable(strTable, st_name)
          if (name && name.length > 0 && !name.includes('\u0000')) {
            const bindType = bind === 0 ? 'L' : bind === 1 ? 'G' : bind === 2 ? 'W' : 'U'
            const symType = type === 2 ? 'F' : 'O'
            symbols.add(`${name} (${bindType}${symType}) @ 0x${st_value.toString(16).toUpperCase()}`)
          }
        }
      }
    }
    
    // Parse both static and dynamic symbol tables
    if (symtab && strtab) {
      parseSymTable(symtab.offset, symtab.size, strtab.offset, 'Static')
    }
    if (dynsym && dynstr) {
      parseSymTable(dynsym.offset, dynsym.size, dynstr.offset, 'Dynamic')
    }
    
    return symbols
    
  } catch (err) {
    console.error('ELF parsing error:', err)
    throw new Error(`ELF parsing error: ${err.message}`)
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
  
  if (isELFFile(view)) {
    return parseELFSymbols(view)
  }
  
  return new Set() // Return empty set for unsupported formats
} 