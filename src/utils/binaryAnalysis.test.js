import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBinary } from './binaryAnalysis.js'
import {
  buildDosOnly,
  buildELF,
  buildFatMachO,
  buildJavaClass,
  buildMachO,
  buildPE,
  CPU_TYPE_ARM64,
  CPU_TYPE_X86,
  CPU_TYPE_X86_64
} from './__fixtures__/executables.js'

const rows = (buffer) => [...analyzeBinary(buffer)]
const titles = (list) => list.map(row => row.split('\x00')[0])
const details = (row) => JSON.parse(row.split('\x00')[1])
const symbolRows = (list) => list.filter(row => /^.+? \([A-Za-z?]\)/.test(row) && !row.includes('\x00'))
const symbolNames = (list) => symbolRows(list).map(row => row.split(' (')[0])

function truncate(buffer, length) {
  return buffer.slice(0, length)
}

// Every prefix of a valid file must either parse or fail with a clear Error,
// never hang or throw a bare RangeError from the DataView.
function assertTruncationsAreSafe(buffer) {
  for (let length = 0; length < buffer.byteLength; length++) {
    try {
      const result = analyzeBinary(truncate(buffer, length))
      assert.ok(result instanceof Set)
    } catch (err) {
      assert.ok(err instanceof Error, `length ${length}: ${err}`)
      assert.match(err.message, /(ELF|PE|Mach-O)/, `length ${length}: ${err.message}`)
    }
  }
}

describe('ELF', () => {
  const expected64 = [
    'buffer (B) @ 0x3010',
    'completed.0 (b) @ 0x3020',
    'data_start (W) @ 0x3000',
    'global_counter (D) @ 0x3000',
    '__gmon_start__ (w)',
    'helper (t) @ 0x1010',
    'main (T) @ 0x1040',
    'malloc (U)',
    'printf (U)',
    '_start (T) @ 0x1000',
    'version_string (R) @ 0x2000'
  ]

  it('lists symbols resolved through the symbol table sh_link, with nm letters, sorted by name', () => {
    const list = rows(buildELF())
    assert.deepEqual(titles(list).slice(0, 4), [
      'Architecture: AMD x86-64',
      'Class: ELF64',
      'Endianness: Little Endian',
      'Symbol table: .symtab (11 symbols)'
    ])
    assert.deepEqual(details(list[3])[0], 'Read from .symtab, names from .names')
    assert.deepEqual(list.slice(4), expected64)
  })

  it('skips FILE and SECTION symbols', () => {
    const names = symbolNames(rows(buildELF()))
    assert.ok(!names.includes('hello.c'))
    assert.ok(!names.includes(''))
  })

  it('parses 32-bit big-endian files', () => {
    const list = rows(buildELF({ is64: false, littleEndian: false, machine: 0x14 }))
    assert.deepEqual(titles(list).slice(0, 3), ['Architecture: PowerPC', 'Class: ELF32', 'Endianness: Big Endian'])
    assert.deepEqual(list.slice(4), expected64)
  })

  it('falls back to .dynsym for stripped binaries', () => {
    const list = rows(buildELF({ dynamic: true }))
    assert.equal(titles(list)[3], 'Symbol table: .dynsym (11 symbols)')
    assert.ok(details(list[3]).some(d => d.includes('dynamic symbols only')))
    assert.deepEqual(list.slice(4), expected64)
  })

  it('names RISC-V by its real e_machine value', () => {
    assert.equal(titles(rows(buildELF({ machine: 0xF3 })))[0], 'Architecture: RISC-V')
    assert.equal(titles(rows(buildELF({ machine: 0x3E8 })))[0], 'Architecture: Unknown (0x3e8)')
  })

  it('reports files without section headers instead of throwing', () => {
    const list = rows(buildELF({ noSectionHeaders: true }))
    assert.equal(list.length, 4)
    assert.equal(list[3], 'Section headers: none (symbols unavailable)')
  })

  it('tolerates a zero or bogus symbol sh_entsize', () => {
    assert.deepEqual(rows(buildELF({ symEntsize: 0 })).slice(4), expected64)
    assert.deepEqual(rows(buildELF({ symEntsize: 7 })).slice(4), expected64)
  })

  it('returns no symbols when the symbol table points outside the file', () => {
    const list = rows(buildELF({ symOffsetOverride: 0x7fffffff }))
    assert.equal(symbolRows(list).length, 0)
    assert.equal(titles(list)[3], 'Symbol table: .symtab (0 symbols)')
  })

  it('handles truncated files', () => {
    assertTruncationsAreSafe(buildELF())
    assertTruncationsAreSafe(buildELF({ is64: false, littleEndian: false }))
  })
})

describe('Mach-O', () => {
  const sampleWithSections = [
    'compute (T) @ 0x100003E80',
    'global_counter (D) @ 0x100008000',
    'helper (t) @ 0x100003E60',
    'main (T) @ 0x100003F00',
    'malloc (U)',
    'message (s) @ 0x100003F80',
    '_mh_execute_header (T) @ 0x100000000',
    'printf (U)',
    'scratch (B) @ 0x100008010'
  ]

  it('reads n_type/n_sect at the same offsets in nlist_64 and classifies by section', () => {
    const list = rows(buildMachO())
    assert.deepEqual(list.slice(0, 3), ['Architecture: arm64', 'File Type: Executable', 'Class: Mach-O 64-bit, little endian'])
    assert.deepEqual(list.slice(3), sampleWithSections)
  })

  it('falls back to S/s when no segment command describes the section', () => {
    const list = rows(buildMachO({ segments: [] }))
    assert.deepEqual(symbolRows(list), [
      'compute (S) @ 0x100003E80',
      'global_counter (S) @ 0x100008000',
      'helper (s) @ 0x100003E60',
      'main (S) @ 0x100003F00',
      'malloc (U)',
      'message (s) @ 0x100003F80',
      '_mh_execute_header (S) @ 0x100000000',
      'printf (U)',
      'scratch (S) @ 0x100008010'
    ])
  })

  it('parses 32-bit images', () => {
    const list = rows(buildMachO({ is64: false, cputype: CPU_TYPE_X86 }))
    assert.equal(list[0], 'Architecture: x86')
    assert.deepEqual(symbolNames(list), [
      'compute', 'global_counter', 'helper', 'main', 'malloc', 'message', '_mh_execute_header', 'printf', 'scratch'
    ])
    assert.ok(list.includes('main (T) @ 0x3F00'))
    assert.ok(list.includes('scratch (B) @ 0x8010'))
  })

  it('parses universal binaries using slice-relative offsets', () => {
    const fat = buildFatMachO([
      { cputype: CPU_TYPE_X86_64, image: buildMachO({ cputype: CPU_TYPE_X86_64 }) },
      { cputype: CPU_TYPE_ARM64, image: buildMachO() }
    ])
    const list = rows(fat)
    assert.equal(titles(list)[0], 'Universal Binary: x86_64, arm64')
    const sliceDetails = details(list[0])
    assert.match(sliceDetails[0], /^x86_64: offset 0x1000, \d+ bytes, executable, 9 symbols$/)
    assert.match(sliceDetails[1], /^arm64: offset 0x\w+, \d+ bytes, executable, 9 symbols$/)
    assert.equal(sliceDetails[2], 'Symbols below are from the x86_64 slice')
    assert.equal(list[1], 'Architecture: x86_64')
    assert.deepEqual(list.slice(4), sampleWithSections)
  })

  it('parses a single-slice universal binary without segment commands', () => {
    const fat = buildFatMachO([{ cputype: CPU_TYPE_ARM64, image: buildMachO({ segments: [] }) }])
    assert.equal(symbolRows(rows(fat)).length, 9)
  })

  it('does not treat a Java class file as a universal binary', () => {
    assert.deepEqual(rows(buildJavaClass()), [])
    assert.deepEqual(rows(buildJavaClass(45)), [])
    assert.deepEqual(rows(truncate(buildJavaClass(), 8)), [])
  })

  it('rejects a fat header whose arch table does not fit', () => {
    const fat = buildFatMachO([{ cputype: CPU_TYPE_ARM64, image: buildMachO() }])
    assert.deepEqual(rows(truncate(fat, 20)), [])
  })

  it('stops on zero-sized load commands even with a huge ncmds', () => {
    const list = rows(buildMachO({ extraCommands: [{ cmd: 0x99, cmdsize: 0 }], ncmdsOverride: 0xffffffff }))
    assert.deepEqual(list.slice(0, 3), ['Architecture: arm64', 'File Type: Executable', 'Class: Mach-O 64-bit, little endian'])
  })

  it('handles truncated files', () => {
    assertTruncationsAreSafe(buildMachO())
    assertTruncationsAreSafe(buildMachO({ is64: false }))
    assertTruncationsAreSafe(buildFatMachO([{ cputype: CPU_TYPE_ARM64, image: buildMachO() }], 0x40))
  })
})

describe('PE', () => {
  const expectedExports = [
    'Alpha (T) RVA 0x1010, ordinal 2',
    'Forwarded (I) -> NTDLL.RtlZeroMemory, ordinal 4',
    'sample_init (T) RVA 0x1000, ordinal 1',
    'sample_table (D) RVA 0x3000, ordinal 3'
  ]

  it('emits header rows, one row per section, the export directory, then exports by name', () => {
    const list = rows(buildPE())
    assert.deepEqual(titles(list), [
      'Architecture: x64',
      'Timestamp: 2010-01-01T00:00:00.000Z',
      'Characteristics: 0x2022',
      'Section 1: .text',
      'Section 2: .edata',
      'Section 3: .data',
      'Section 4: .rdata0',
      'Section 5: .rdata1',
      'Export Directory: sample.dll',
      ...expectedExports
    ])
    assert.deepEqual(details(list[2]), ['Executable image', 'Large address aware', 'DLL'])
    assert.deepEqual(details(list[3]), [
      'Virtual Size: 0x100 bytes',
      'Virtual Address: 0x1000',
      'Raw Size: 0x200 bytes',
      'Raw Address: 0x400',
      'Characteristics: Code, Executable, Readable'
    ])
    assert.deepEqual(details(list[8]), [
      'DLL Name: sample.dll',
      'Ordinal Base: 1',
      'Number of Functions: 5',
      'Number of Names: 4',
      'Exported by ordinal only (or unused slots): 1'
    ])
  })

  it('keeps sections with identical characteristics as separate rows', () => {
    const list = rows(buildPE({ extraDataSections: 3 }))
    const sections = list.filter(row => row.startsWith('Section '))
    assert.equal(sections.length, 6)
    const characteristics = sections.map(row => details(row).at(-1))
    assert.equal(characteristics.filter(c => c === 'Characteristics: Initialized Data, Readable').length, 4)
  })

  it('maps RVAs into sections whose VirtualSize is 0', () => {
    const list = rows(buildPE({ edataVirtualSize: 0 }))
    assert.deepEqual(symbolRows(list), expectedExports)
  })

  it('parses PE32 images and applies the ordinal base', () => {
    const list = rows(buildPE({ pe32Plus: false, machine: 0x14c, ordinalBase: 10 }))
    assert.equal(list[0], 'Architecture: x86')
    assert.ok(list.includes('Alpha (T) RVA 0x1010, ordinal 11'))
  })

  it('emits only header and section rows when there are no exports', () => {
    const list = rows(buildPE({ exports: [] }))
    assert.ok(!titles(list).some(t => t.startsWith('Export Directory')))
    assert.equal(symbolRows(list).length, 0)
  })

  it('returns an empty set for DOS-only and truncated MZ files', () => {
    assert.deepEqual(rows(buildDosOnly()), [])
    assert.deepEqual(rows(truncate(buildDosOnly(), 0x30)), [])
    assert.deepEqual(rows(truncate(buildPE(), 0x82)), [])
  })

  it('handles truncated files', () => {
    assertTruncationsAreSafe(buildPE())
  })
})

describe('analyzeBinary', () => {
  it('returns an empty set for tiny or unknown input', () => {
    for (const bytes of [[], [0x4d], [0x7f, 0x45, 0x4c], [1, 2, 3, 4, 5, 6, 7, 8]]) {
      assert.deepEqual(rows(new Uint8Array(bytes).buffer), [])
    }
  })
})
