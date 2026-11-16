// Shapes shared by the format parsers, the analysis worker and the panels.
// This module only holds JSDoc typedefs.

/**
 * Result of analysing a file. Produced by `analyzeBytes`, which fills every
 * property, so consumers never need to check for missing arrays.
 *
 * @typedef {Object} Analysis
 * @property {string} formatId      stable id: 'elf' | 'pe' | 'macho' | 'zip' | 'pdf' | 'png' | 'jpeg' | 'gif' | 'java-class' | 'unknown'
 * @property {string} formatName    display name, e.g. 'Linux ELF Executable'
 * @property {string} category      'executable' | 'archive' | 'image' | 'document' | 'data' | 'unknown'
 * @property {SummaryItem[]} summary  key facts for the Overview panel
 * @property {Field[]} fields         structure tree with exact byte ranges (may be empty)
 * @property {Region[]} regions       coarse map of the file for an anatomy bar, sorted by offset (may be empty)
 * @property {SymbolEntry[]} symbols  executables only, else []
 * @property {ArchiveEntry[]} entries archives only, else []
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} SummaryItem
 * @property {string} label
 * @property {string} value
 * @property {string[]} [details]   extra lines shown when expanded
 * @property {string} [group]       items sharing a group render together under that heading (e.g. 'Sections')
 */

/**
 * @typedef {Object} Field
 * @property {string} name          e.g. 'e_machine', 'Signature'
 * @property {number} offset        absolute file offset
 * @property {number} length        in bytes
 * @property {string} [value]       decoded, human-readable
 * @property {string} [description] one-line explanation
 * @property {string} [kind]        'magic' | 'size' | 'offset' | 'count' | 'flags' | 'string' | 'checksum' | 'data' | 'padding' | 'header'
 * @property {Field[]} [children]
 */

/**
 * @typedef {Object} Region
 * @property {string} name
 * @property {number} offset
 * @property {number} length
 * @property {string} [kind]        'header' | 'code' | 'data' | 'table' | 'metadata' | 'padding' | 'other'
 */

/**
 * @typedef {Object} SymbolEntry
 * @property {string} name
 * @property {string} type          nm-style letter
 * @property {string} [address]     hex string such as '0x1139' (an RVA for PE exports)
 * @property {string} [note]        e.g. 'ordinal 4', '-> KERNEL32.Sleep, ordinal 2', 'size 8'
 */

/**
 * @typedef {Object} ArchiveEntry
 * @property {string} path
 * @property {boolean} isDirectory
 * @property {number|null} size     null when the archive does not record it
 * @property {number} compressedSize
 * @property {string} method        e.g. 'stored', 'deflated'
 * @property {boolean} encrypted
 */

/**
 * @typedef {Object} FileMeta
 * @property {string} [fileName]
 * @property {string} [mimeType]
 */

/**
 * A format parser module (`src/formats/*.js`, default export).
 *
 * @typedef {Object} FormatModule
 * @property {string} id
 * @property {string} name          default `formatName`; `parse` may return a more specific one
 * @property {string} category
 * @property {(bytes: Uint8Array) => boolean} detect   cheap, safe for any length
 * @property {(bytes: Uint8Array, meta: FileMeta) => Partial<Analysis>} parse   may throw; `analyzeBytes` turns that into a warning
 */

export {}
