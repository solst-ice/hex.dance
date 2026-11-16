import { dataView, decodeFlags, hex, inBounds, item, MAX_SYMBOLS, readCString, readFixedString, sortSymbols } from './shared.js'

// The Windows loader rejects images with more sections; every export lookup
// walks the section list, so an unbounded count makes parsing quadratic
const MAX_PE_SECTIONS = 96

const PE_MACHINES = {
  0x14c: 'x86',
  0x8664: 'x64',
  0x1c0: 'ARM',
  0x1c4: 'ARMv7 (Thumb-2)',
  0xaa64: 'ARM64'
}

const PE_FILE_FLAGS = [
  [0x0001, 'Relocations stripped'],
  [0x0002, 'Executable image'],
  [0x0020, 'Large address aware'],
  [0x0100, '32-bit machine'],
  [0x0200, 'Debug info stripped'],
  [0x1000, 'System file'],
  [0x2000, 'DLL']
]

const PE_SECTION_FLAGS = [
  [0x20, 'Code'],
  [0x40, 'Initialized Data'],
  [0x80, 'Uninitialized Data'],
  [0x200, 'Link Info'],
  [0x1000000, 'Extended Relocations'],
  [0x2000000, 'Discardable'],
  [0x4000000, 'Not Cached'],
  [0x8000000, 'Not Paged'],
  [0x10000000, 'Shared'],
  [0x20000000, 'Executable'],
  [0x40000000, 'Readable'],
  [0x80000000, 'Writable']
]

function rvaToFileOffset(view, rva, sections) {
  for (const section of sections) {
    // VirtualSize may legally be 0, in which case only the raw size describes the section
    const span = Math.max(section.virtualSize, section.rawSize)
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      const delta = rva - section.virtualAddress
      if (delta >= section.rawSize) return null
      const offset = section.rawAddress + delta
      return offset < view.byteLength ? offset : null
    }
  }
  return null
}

function sectionForRva(rva, sections) {
  return sections.find(s => rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize))
}

function peHeaderOffset(view) {
  if (view.byteLength < 0x40 || view.getUint16(0, true) !== 0x5A4D) return null
  const peOffset = view.getUint32(0x3C, true)
  if (!inBounds(view, peOffset, 24) || view.getUint32(peOffset, true) !== 0x00004550) return null
  return peOffset
}

function parsePE(view) {
  const peOffset = view.getUint32(0x3C, true)
  const fileHeader = peOffset + 4
  const machine = view.getUint16(fileHeader, true)
  const declaredSections = view.getUint16(fileHeader + 2, true)
  const timeDateStamp = view.getUint32(fileHeader + 4, true)
  const symbolTableOffset = view.getUint32(fileHeader + 8, true)
  const numberOfSymbols = view.getUint32(fileHeader + 12, true)
  const optionalHeaderSize = view.getUint16(fileHeader + 16, true)
  const characteristics = view.getUint16(fileHeader + 18, true)

  const summary = [
    item('Architecture', PE_MACHINES[machine] || `Unknown (${hex(machine)})`),
    item('Timestamp', new Date(timeDateStamp * 1000).toISOString()),
    item('Characteristics', hex(characteristics), decodeFlags(characteristics, PE_FILE_FLAGS))
  ]
  const fields = [
    { name: 'DOS signature', offset: 0, length: 2, value: 'MZ', kind: 'magic', description: 'MS-DOS executable header magic' },
    { name: 'e_lfanew', offset: 0x3C, length: 4, value: hex(peOffset), kind: 'offset', description: 'File offset of the PE header' },
    { name: 'PE signature', offset: peOffset, length: 4, value: 'PE\\0\\0', kind: 'magic', description: 'Start of the PE header' }
  ]
  const regions = [{ name: 'DOS header', offset: 0, length: 0x40, kind: 'header' }]
  const symbols = []
  const warnings = []
  const result = () => ({ summary, fields, regions, symbols: sortSymbols(symbols), warnings })

  const optionalHeaderOffset = fileHeader + 20
  const sectionHeadersOffset = optionalHeaderOffset + optionalHeaderSize

  // Long section names ("/4") point into the COFF string table that follows the symbol table
  const stringTableOffset = symbolTableOffset ? symbolTableOffset + numberOfSymbols * 18 : 0
  const sectionName = (raw) => {
    const match = /^\/(\d+)$/.exec(raw)
    if (!match || !stringTableOffset || !inBounds(view, stringTableOffset, 4)) return raw
    const offset = stringTableOffset + Number(match[1])
    return inBounds(view, offset, 1) ? readCString(view, offset) || raw : raw
  }

  const sections = []
  for (let i = 0; i < Math.min(declaredSections, MAX_PE_SECTIONS); i++) {
    const offset = sectionHeadersOffset + i * 40
    if (!inBounds(view, offset, 40)) break
    const section = {
      name: sectionName(readFixedString(view, offset, 8)),
      virtualSize: view.getUint32(offset + 8, true),
      virtualAddress: view.getUint32(offset + 12, true),
      rawSize: view.getUint32(offset + 16, true),
      rawAddress: view.getUint32(offset + 20, true),
      characteristics: view.getUint32(offset + 36, true)
    }
    sections.push(section)
    summary.push(item(`Section ${i + 1}`, section.name || '(unnamed)', [
      `Virtual Size: ${hex(section.virtualSize)} bytes`,
      `Virtual Address: ${hex(section.virtualAddress)}`,
      `Raw Size: ${hex(section.rawSize)} bytes`,
      `Raw Address: ${hex(section.rawAddress)}`,
      `Characteristics: ${decodeFlags(section.characteristics, PE_SECTION_FLAGS).join(', ') || 'None'}`
    ], 'Sections'))
    if (section.rawSize > 0 && section.rawAddress < view.byteLength) {
      regions.push({
        name: section.name || `Section ${i + 1}`,
        offset: section.rawAddress,
        length: Math.min(section.rawSize, view.byteLength - section.rawAddress),
        kind: section.characteristics & 0x20000020 ? 'code' : 'data'
      })
    }
  }
  regions.splice(1, 0, {
    name: 'PE headers',
    offset: peOffset,
    length: Math.min(sectionHeadersOffset + sections.length * 40, view.byteLength) - peOffset,
    kind: 'header'
  })
  if (sections.length < declaredSections) {
    warnings.push(`Section table truncated: ${sections.length} of ${declaredSections} sections readable`)
  }

  if (!inBounds(view, optionalHeaderOffset, 2)) return result()
  const isPE32Plus = view.getUint16(optionalHeaderOffset, true) === 0x20B
  const dataDirectoryOffset = optionalHeaderOffset + (isPE32Plus ? 112 : 96)
  if (!inBounds(view, dataDirectoryOffset, 8) || dataDirectoryOffset + 8 > sectionHeadersOffset ||
      view.getUint32(dataDirectoryOffset - 4, true) < 1) { // NumberOfRvaAndSizes
    return result()
  }
  const exportRVA = view.getUint32(dataDirectoryOffset, true)
  const exportSize = view.getUint32(dataDirectoryOffset + 4, true)
  if (!exportRVA || !exportSize) return result()

  const exportOffset = rvaToFileOffset(view, exportRVA, sections)
  if (exportOffset === null || !inBounds(view, exportOffset, 40)) {
    summary.push(item('Export Directory', 'unreadable (outside file data)'))
    return result()
  }

  const nameOffset = rvaToFileOffset(view, view.getUint32(exportOffset + 12, true), sections)
  const dllName = nameOffset === null ? '' : readCString(view, nameOffset)
  const ordinalBase = view.getUint32(exportOffset + 16, true)
  const numberOfFunctions = view.getUint32(exportOffset + 20, true)
  const numberOfNames = view.getUint32(exportOffset + 24, true)
  const functionsOffset = rvaToFileOffset(view, view.getUint32(exportOffset + 28, true), sections)
  const namesOffset = rvaToFileOffset(view, view.getUint32(exportOffset + 32, true), sections)
  const ordinalsOffset = rvaToFileOffset(view, view.getUint32(exportOffset + 36, true), sections)

  const namedOrdinals = new Set()
  if (namesOffset !== null && ordinalsOffset !== null && functionsOffset !== null) {
    const count = Math.min(
      numberOfNames,
      MAX_SYMBOLS,
      Math.floor((view.byteLength - namesOffset) / 4),
      Math.floor((view.byteLength - ordinalsOffset) / 2)
    )
    for (let i = 0; i < count; i++) {
      const nameRVA = view.getUint32(namesOffset + i * 4, true)
      const symbolNameOffset = rvaToFileOffset(view, nameRVA, sections)
      const name = symbolNameOffset === null ? '' : readCString(view, symbolNameOffset)
      if (!name) continue
      const index = view.getUint16(ordinalsOffset + i * 2, true)
      namedOrdinals.add(index)
      const ordinal = `ordinal ${index + ordinalBase}`
      if (!inBounds(view, functionsOffset + index * 4, 4)) {
        symbols.push({ name, type: 'T', note: ordinal })
        continue
      }
      const functionRVA = view.getUint32(functionsOffset + index * 4, true)
      if (functionRVA >= exportRVA && functionRVA < exportRVA + exportSize) {
        const forwarderOffset = rvaToFileOffset(view, functionRVA, sections)
        const target = forwarderOffset === null ? '?' : readCString(view, forwarderOffset)
        symbols.push({ name, type: 'I', note: `-> ${target}, ${ordinal}` })
      } else {
        const section = sectionForRva(functionRVA, sections)
        const type = section && !(section.characteristics & 0x20000020) ? 'D' : 'T'
        symbols.push({ name, type, address: hex(functionRVA), note: ordinal })
      }
    }
  }

  summary.push(item('Export Directory', dllName || '(unnamed)', [
    `DLL Name: ${dllName || '(none)'}`,
    `Ordinal Base: ${ordinalBase}`,
    `Number of Functions: ${numberOfFunctions}`,
    `Number of Names: ${numberOfNames}`,
    numberOfFunctions > namedOrdinals.size && numberOfFunctions <= MAX_SYMBOLS
      ? `Exported by ordinal only (or unused slots): ${numberOfFunctions - namedOrdinals.size}`
      : ''
  ]))
  return result()
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'pe',
  name: 'Windows PE Executable',
  category: 'executable',
  detect: bytes => bytes.length >= 2 && bytes[0] === 0x4D && bytes[1] === 0x5A,
  parse(bytes) {
    const view = dataView(bytes)
    if (peHeaderOffset(view) === null) {
      return {
        summary: [item('PE header', 'not found (MS-DOS executable or truncated file)')],
        fields: [{ name: 'DOS signature', offset: 0, length: 2, value: 'MZ', kind: 'magic' }]
      }
    }
    try {
      return parsePE(view)
    } catch (err) {
      throw new Error(`PE parsing error: ${err.message}`)
    }
  }
}
