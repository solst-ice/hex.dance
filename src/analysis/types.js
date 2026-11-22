// Shapes shared by the format parsers, the analysis worker and the panels.
// This module only holds JSDoc typedefs.

/**
 * Result of analysing a file. Produced by `analyzeBytes`, which fills every
 * property, so consumers never need to check for missing arrays.
 *
 * @typedef {Object} Analysis
 * @property {string} formatId      stable id: the `id` of the format module that recognised the file
 *                                  (e.g. 'elf', 'pe', 'zip', 'png', 'java-class'; see src/formats/index.js), or 'unknown'
 * @property {string} formatName    display name, e.g. 'Linux ELF Executable'
 * @property {string} category      the format module's `category` ('executable', 'archive', 'compressed', 'image',
 *                                  'audio', 'video', 'media', 'document', 'text', 'font', 'database', 'disk', 'data'),
 *                                  or 'unknown'
 * @property {SummaryItem[]} summary  key facts for the Overview panel
 * @property {Field[]} fields         structure tree with exact byte ranges (may be empty)
 * @property {Region[]} regions       coarse map of the file for an anatomy bar, sorted by offset (may be empty)
 * @property {SymbolEntry[]} symbols  executables only, else []
 * @property {ArchiveEntry[]} entries archives only, else []
 * @property {string[]} warnings
 * @property {UnusualNote[]} unusual  things about this file that a typical file of its format does not do (may be empty)
 * @property {ImageLayout|null} image how the file's parts are placed in memory when it is loaded; null for formats
 *                                  that are not loaded that way, or when the parser does not provide it
 * @property {'timeout'|'crash'} [gaveUp]  set by the page when the analysis did not finish (it timed out, or the
 *                                  worker failed): the result then holds only generic facts and a note in `warnings`
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
 * @property {number} [target]      for a field that points somewhere: the absolute file offset it points at, already
 *                                  converted from an address when needed. Only set when the target is inside the file.
 */

/**
 * Something a typical file of this format does not do. A fact the parser has checked, in plain words.
 *
 * @typedef {Object} UnusualNote
 * @property {string} text          one sentence, e.g. 'The entry point is in the last section, not the first.'
 * @property {number} [offset]      file offset of the bytes that show it, when there is one place
 * @property {number} [length]
 */

/**
 * What the loader maps into memory: PE sections, ELF PT_LOAD segments, Mach-O segments.
 *
 * @typedef {Object} ImageLayout
 * @property {string} addressLabel  how addresses are named for this format: 'RVA' or 'address'
 * @property {{ address: number, offset: number|null }|null} entry  where execution starts; `offset` is the file
 *                                  offset of that address, or null when it is not backed by the file
 * @property {ImageSection[]} sections  in table order, at most 1,024
 * @property {number} total         number of sections before the cap
 */

/**
 * @typedef {Object} ImageSection
 * @property {string} name          '' when the file gives none
 * @property {number} offset        file offset of its data
 * @property {number} size          bytes in the file (0 when it has none)
 * @property {number} address       where it is placed in memory, in the units of `addressLabel`
 * @property {number} memSize       bytes in memory
 * @property {string} flags         short, e.g. 'r-x', 'rw-', '-wx'
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
 * @property {string} [note]        e.g. 'ordinal 4', '-> KERNEL32.Sleep, ordinal 2', 'size 8'; for imports, the library
 * @property {number} [offset]      file offset of the symbol's bytes, when they are in the file
 * @property {number} [size]        size in bytes, when the format records it
 * @property {string} [kind]        'function' | 'data' | 'other'
 * @property {string} [library]     imports: the library expected to provide the symbol
 * @property {string} [reason]      why `offset` is missing, e.g. 'Imported: defined in libc.so.6'
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
