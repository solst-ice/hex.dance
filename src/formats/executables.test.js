import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import elf from './elf.js'
import macho from './macho.js'
import pe from './pe.js'
import { analyzeBytes } from '../analysis/analyze.js'
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

const parse = (format, buffer) => format.parse(new Uint8Array(buffer), {})
const summaryOf = (result) => result.summary || []
const titles = (result) => summaryOf(result).map(entry => `${entry.label}: ${entry.value}`)
const symbolRow = (s) => [s.name, `(${s.type})`, s.address && `@ ${s.address}`, s.note].filter(Boolean).join(' ')
const symbolRows = (result) => (result.symbols || []).map(symbolRow)
const symbolNames = (result) => (result.symbols || []).map(s => s.name)

function truncate(buffer, length) {
  return buffer.slice(0, length)
}

// Every prefix of a valid file must either parse or fail with a clear Error,
// never hang or throw a bare RangeError from the DataView; analyzeBytes turns
// the error into a warning and never throws.
function assertTruncationsAreSafe(format, buffer) {
  for (let length = 0; length < buffer.byteLength; length++) {
    const bytes = new Uint8Array(truncate(buffer, length))
    if (format.detect(bytes)) {
      try {
        const result = format.parse(bytes, {})
        assert.equal(typeof result, 'object')
      } catch (err) {
        assert.ok(err instanceof Error, `length ${length}: ${err}`)
        assert.match(err.message, /(ELF|PE|Mach-O)/, `length ${length}: ${err.message}`)
      }
    }
    const analysis = analyzeBytes(bytes, {})
    assert.ok(Array.isArray(analysis.summary), `length ${length}`)
    assert.ok(Array.isArray(analysis.symbols), `length ${length}`)
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
    const result = parse(elf, buildELF())
    assert.deepEqual(titles(result).slice(0, 4), [
      'Architecture: AMD x86-64',
      'Class: ELF64',
      'Endianness: Little Endian',
      'Symbol table: .symtab (11 symbols)'
    ])
    assert.equal(result.summary[3].details[0], 'Read from .symtab, names from .names')
    assert.deepEqual(symbolRows(result), expected64)
  })

  it('skips FILE and SECTION symbols', () => {
    const names = symbolNames(parse(elf, buildELF()))
    assert.ok(!names.includes('hello.c'))
    assert.ok(!names.includes(''))
  })

  it('parses 32-bit big-endian files', () => {
    const result = parse(elf, buildELF({ is64: false, littleEndian: false, machine: 0x14 }))
    assert.deepEqual(titles(result).slice(0, 3), ['Architecture: PowerPC', 'Class: ELF32', 'Endianness: Big Endian'])
    assert.deepEqual(symbolRows(result), expected64)
  })

  it('falls back to .dynsym for stripped binaries', () => {
    const result = parse(elf, buildELF({ dynamic: true }))
    assert.equal(titles(result)[3], 'Symbol table: .dynsym (11 symbols)')
    assert.ok(result.summary[3].details.some(d => d.includes('dynamic symbols only')))
    assert.deepEqual(symbolRows(result), expected64)
  })

  it('names RISC-V by its real e_machine value', () => {
    assert.equal(titles(parse(elf, buildELF({ machine: 0xF3 })))[0], 'Architecture: RISC-V')
    assert.equal(titles(parse(elf, buildELF({ machine: 0x3E8 })))[0], 'Architecture: Unknown (0x3e8)')
  })

  it('keeps the explanatory details of the header rows', () => {
    const [arch, cls, endian] = parse(elf, buildELF()).summary
    assert.equal(arch.details[0], 'Processor architecture for this binary')
    assert.equal(arch.details.at(-1), 'Common in desktop/server systems')
    assert.equal(cls.details.at(-1), 'Memory model: LP64 (longs and pointers are 64-bit)')
    assert.equal(endian.details.at(-1), 'Example: 0x1234 stored as 34 12')
  })

  it('reports files without section headers instead of throwing', () => {
    const result = parse(elf, buildELF({ noSectionHeaders: true }))
    assert.equal(titles(result)[3], 'Section headers: none (symbols unavailable)')
    assert.ok(titles(result).includes('Stripped: unknown (no section headers)'))
    assert.equal(result.symbols.length, 0)
  })

  it('tolerates a zero or bogus symbol sh_entsize', () => {
    assert.deepEqual(symbolRows(parse(elf, buildELF({ symEntsize: 0 }))), expected64)
    assert.deepEqual(symbolRows(parse(elf, buildELF({ symEntsize: 7 }))), expected64)
  })

  it('returns no symbols when the symbol table points outside the file', () => {
    const result = parse(elf, buildELF({ symOffsetOverride: 0x7fffffff }))
    assert.equal(result.symbols.length, 0)
    assert.equal(titles(result)[3], 'Symbol table: .symtab (0 symbols)')
  })

  it('marks the magic and the header region', () => {
    const result = parse(elf, buildELF())
    assert.deepEqual(result.fields[0], {
      name: 'Magic', offset: 0, length: 4, value: '\\x7FELF', kind: 'magic', description: 'ELF identification'
    })
    assert.deepEqual(result.regions[0], { name: 'ELF header', offset: 0, length: 64, kind: 'header' })
    assert.ok(result.regions.some(region => region.name === '.symtab'))
  })

  it('handles truncated files', () => {
    assertTruncationsAreSafe(elf, buildELF())
    assertTruncationsAreSafe(elf, buildELF({ is64: false, littleEndian: false }))
  })
})

describe('Mach-O', () => {
  const header64 = ['Architecture: arm64', 'File Type: Executable', 'Class: Mach-O 64-bit, little endian']
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
    const result = parse(macho, buildMachO())
    assert.deepEqual(titles(result).slice(0, 3), header64)
    assert.equal(result.formatName, '64-bit Mach-O (reversed)')
    assert.deepEqual(symbolRows(result), sampleWithSections)
  })

  it('falls back to S/s when no segment command describes the section', () => {
    assert.deepEqual(symbolRows(parse(macho, buildMachO({ segments: [] }))), [
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
    const result = parse(macho, buildMachO({ is64: false, cputype: CPU_TYPE_X86 }))
    assert.equal(titles(result)[0], 'Architecture: x86')
    assert.equal(result.formatName, '32-bit Mach-O (reversed)')
    assert.deepEqual(symbolNames(result), [
      'compute', 'global_counter', 'helper', 'main', 'malloc', 'message', '_mh_execute_header', 'printf', 'scratch'
    ])
    assert.ok(symbolRows(result).includes('main (T) @ 0x3F00'))
    assert.ok(symbolRows(result).includes('scratch (B) @ 0x8010'))
  })

  it('parses universal binaries using slice-relative offsets', () => {
    const fat = buildFatMachO([
      { cputype: CPU_TYPE_X86_64, image: buildMachO({ cputype: CPU_TYPE_X86_64 }) },
      { cputype: CPU_TYPE_ARM64, image: buildMachO() }
    ])
    const result = parse(macho, fat)
    assert.equal(result.formatName, 'Universal Binary')
    assert.equal(titles(result)[0], 'Universal Binary: x86_64, arm64')
    const sliceDetails = result.summary[0].details
    assert.match(sliceDetails[0], /^x86_64: offset 0x1000, \d+ bytes, executable, 9 symbols$/)
    assert.match(sliceDetails[1], /^arm64: offset 0x\w+, \d+ bytes, executable, 9 symbols$/)
    assert.equal(sliceDetails[2], 'Symbols below are from the x86_64 slice')
    assert.equal(titles(result)[1], 'Architecture: x86_64')
    assert.deepEqual(symbolRows(result), sampleWithSections)
    const names = result.regions.map(r => r.name)
    assert.deepEqual(names.slice(0, 3), ['Universal header', 'Padding', 'x86_64: Mach header'])
    assert.ok(names.includes('arm64: Load commands'))
    assert.ok(names.includes('arm64: Symbol table'))
  })

  it('parses a single-slice universal binary without segment commands', () => {
    const fat = buildFatMachO([{ cputype: CPU_TYPE_ARM64, image: buildMachO({ segments: [] }) }])
    assert.equal(parse(macho, fat).symbols.length, 9)
  })

  it('does not treat a Java class file as a universal binary', () => {
    for (const buffer of [buildJavaClass(), buildJavaClass(45), truncate(buildJavaClass(), 8)]) {
      const result = parse(macho, buffer)
      assert.equal(summaryOf(result).length, 0)
      assert.equal((result.symbols || []).length, 0)
      assert.equal(analyzeBytes(new Uint8Array(buffer)).formatId, 'java-class')
    }
  })

  it('rejects a fat header whose arch table does not fit', () => {
    const fat = buildFatMachO([{ cputype: CPU_TYPE_ARM64, image: buildMachO() }])
    const result = parse(macho, truncate(fat, 20))
    assert.equal(summaryOf(result).length, 0)
    assert.equal((result.symbols || []).length, 0)
  })

  it('stops on zero-sized load commands even with a huge ncmds', () => {
    const result = parse(macho, buildMachO({ extraCommands: [{ cmd: 0x99, cmdsize: 0 }], ncmdsOverride: 0xffffffff }))
    assert.deepEqual(titles(result).slice(0, 3), header64)
  })

  it('handles truncated files', () => {
    assertTruncationsAreSafe(macho, buildMachO())
    assertTruncationsAreSafe(macho, buildMachO({ is64: false }))
    assertTruncationsAreSafe(macho, buildFatMachO([{ cputype: CPU_TYPE_ARM64, image: buildMachO() }], 0x40))
  })
})

describe('PE', () => {
  const expectedExports = [
    'Alpha (T) @ 0x1010 ordinal 2',
    'Forwarded (I) -> NTDLL.RtlZeroMemory, ordinal 4',
    'sample_init (T) @ 0x1000 ordinal 1',
    'sample_table (D) @ 0x3000 ordinal 3'
  ]

  it('emits header items, one grouped item per section, the export directory, then exports by name', () => {
    const result = parse(pe, buildPE())
    const original = /^(Architecture|Timestamp|Characteristics|Section \d|Export Directory):/
    assert.deepEqual(titles(result).filter(t => original.test(t)), [
      'Architecture: x64',
      'Timestamp: 2010-01-01T00:00:00.000Z',
      'Characteristics: 0x2022',
      'Section 1: .text',
      'Section 2: .edata',
      'Section 3: .data',
      'Section 4: .rdata0',
      'Section 5: .rdata1',
      'Export Directory: sample.dll'
    ])
    assert.deepEqual(symbolRows(result), expectedExports)
    const [, , characteristics, text] = result.summary
    assert.deepEqual(characteristics.details, ['Executable image', 'Large address aware', 'DLL'])
    assert.equal(text.group, 'Sections')
    assert.deepEqual(text.details, [
      'Virtual Size: 0x100 bytes',
      'Virtual Address: 0x1000',
      'Raw Size: 0x200 bytes',
      'Raw Address: 0x400',
      'Characteristics: Code, Executable, Readable'
    ])
    assert.deepEqual(result.summary.find(s => s.label === 'Export Directory').details, [
      'DLL Name: sample.dll',
      'Ordinal Base: 1',
      'Number of Functions: 5',
      'Number of Names: 4',
      'Exported by ordinal only (or unused slots): 1'
    ])
  })

  it('marks both signatures and maps section raw data to regions', () => {
    const result = parse(pe, buildPE())
    assert.deepEqual(result.fields.filter(f => f.kind === 'magic').map(f => f.name), ['DOS signature', 'PE signature'])
    const text = result.regions.find(region => region.name === '.text')
    assert.deepEqual(text, { name: '.text', offset: 0x400, length: 0x200, kind: 'code' })
  })

  it('keeps sections with identical characteristics as separate items', () => {
    const result = parse(pe, buildPE({ extraDataSections: 3 }))
    const sections = result.summary.filter(entry => entry.group === 'Sections')
    assert.equal(sections.length, 6)
    const characteristics = sections.map(entry => entry.details.at(-1))
    assert.equal(characteristics.filter(c => c === 'Characteristics: Initialized Data, Readable').length, 4)
  })

  it('maps RVAs into sections whose VirtualSize is 0', () => {
    assert.deepEqual(symbolRows(parse(pe, buildPE({ edataVirtualSize: 0 }))), expectedExports)
  })

  it('parses PE32 images and applies the ordinal base', () => {
    const result = parse(pe, buildPE({ pe32Plus: false, machine: 0x14c, ordinalBase: 10 }))
    assert.equal(titles(result)[0], 'Architecture: x86')
    assert.ok(symbolRows(result).includes('Alpha (T) @ 0x1010 ordinal 11'))
  })

  it('emits only header and section items when there are no exports', () => {
    const result = parse(pe, buildPE({ exports: [] }))
    assert.ok(!titles(result).some(t => t.startsWith('Export Directory')))
    assert.equal(result.symbols.length, 0)
  })

  it('reports DOS-only and truncated MZ files without symbols', () => {
    for (const buffer of [buildDosOnly(), truncate(buildDosOnly(), 0x30), truncate(buildPE(), 0x82)]) {
      const result = parse(pe, buffer)
      assert.deepEqual(titles(result), ['PE header: not found (MS-DOS executable or truncated file)'])
      assert.equal((result.symbols || []).length, 0)
    }
  })

  it('handles truncated files', () => {
    assertTruncationsAreSafe(pe, buildPE())
  })
})

describe('executable detection', () => {
  it('leaves tiny or unknown input to the generic summary', () => {
    for (const bytes of [[], [0x4d], [0x7f, 0x45, 0x4c], [1, 2, 3, 4, 5, 6, 7, 8]]) {
      const analysis = analyzeBytes(new Uint8Array(bytes))
      assert.equal(analysis.symbols.length, 0)
      assert.equal(analysis.formatId, 'unknown')
    }
  })
})
