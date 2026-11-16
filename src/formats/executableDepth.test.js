import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import elf from './elf.js'
import macho from './macho.js'
import pe from './pe.js'
import { analyzeBytes } from '../analysis/analyze.js'
import { MAX_FIELD_NODES, tileRegions } from './binfields.js'
import {
  buildELF,
  buildFatMachO,
  buildFullPE,
  buildLinkedELF,
  buildMachO,
  buildPE,
  CPU_TYPE_ARM64,
  CPU_TYPE_X86_64
} from './__fixtures__/executables.js'

const parse = (format, buffer) => format.parse(new Uint8Array(buffer), {})
const fact = (result, label, group) => {
  const found = result.summary.find(s => s.label === label && (!group || s.group === group))
  return found ? found.value : undefined
}
const symbol = (result, name) => result.symbols.find(s => s.name === name)

function countNodes(fields) {
  let count = 0
  for (const f of fields) count += 1 + (f.children ? countNodes(f.children) : 0)
  return count
}

// Fields lie inside the file, children inside their parent, and siblings are
// sorted and do not overlap; regions tile the file without gaps or overlaps.
function assertWellFormed(analysis, size, label = '') {
  const check = (nodes, start, end, path) => {
    let previousEnd = start
    for (const node of nodes) {
      const where = `${label} ${path}/${node.name} @${node.offset}+${node.length}`
      assert.ok(Number.isSafeInteger(node.offset) && node.length > 0, where)
      assert.ok(node.offset >= start && node.offset + node.length <= end, `${where} outside its parent [${start}, ${end})`)
      assert.ok(node.offset >= previousEnd, `${where} overlaps the previous sibling (ends at ${previousEnd})`)
      previousEnd = node.offset + node.length
      if (node.children) check(node.children, node.offset, node.offset + node.length, `${path}/${node.name}`)
    }
  }
  check(analysis.fields, 0, size, '')
  assert.ok(countNodes(analysis.fields) <= MAX_FIELD_NODES + 64, `${label} too many nodes`)
  let cursor = 0
  for (const region of analysis.regions) {
    assert.equal(region.offset, cursor, `${label} region ${region.name} does not start where the previous one ended`)
    assert.ok(region.length > 0, `${label} region ${region.name}`)
    cursor = region.offset + region.length
  }
  if (size > 0 && analysis.regions.length) assert.equal(cursor, size, `${label} regions do not reach the end of the file`)
}

const FIXTURES = {
  'ELF symbols': () => buildELF(),
  'ELF 32-bit big endian': () => buildELF({ is64: false, littleEndian: false }),
  'linked ELF': () => buildLinkedELF(),
  'linked ELF32 BE exec': () => buildLinkedELF({ is64: false, littleEndian: false, kind: 'exec', relro: 'partial' }),
  'linked ELF without section headers': () => buildLinkedELF({ noSectionHeaders: true }),
  'PE exports': () => buildPE(),
  'full PE32+': () => buildFullPE(),
  'full PE32': () => buildFullPE({ pe32Plus: false }),
  'Mach-O': () => buildMachO(),
  'Mach-O with commands': () => buildRichMachO(),
  'universal Mach-O': () => buildFatMachO([
    { cputype: CPU_TYPE_X86_64, image: buildMachO({ cputype: CPU_TYPE_X86_64 }) },
    { cputype: CPU_TYPE_ARM64, image: buildRichMachO() }
  ], 0x100)
}

function buildRichMachO(options = {}) {
  return buildMachO({
    flags: 0x200085, // NOUNDEFS DYLDLINK TWOLEVEL PIE
    segments: [
      { segname: '__TEXT', vmaddr: 0x100000000, fileoff: 0, filesize: 0x1000, sections: [
        { sectname: '__text', flags: 0x80000400, addr: 0x100000e00, size: 0x100, offset: 0xe00 },
        { sectname: '__cstring', flags: 0x2, addr: 0x100000f00, size: 0x100, offset: 0xf00 }
      ] },
      { segname: '__DATA', vmaddr: 0x100008000, fileoff: 0x1000, filesize: 0, sections: [
        { sectname: '__data', flags: 0, addr: 0x100008000, size: 0x10, offset: 0 },
        { sectname: '__bss', flags: 0x1, addr: 0x100008010, size: 0x20, offset: 0 }
      ] }
    ],
    symbols: [
      { name: '_main', type: 0x0f, sect: 1, value: 0x100000e40 },
      { name: '_message', type: 0x0e, sect: 2, value: 0x100000f00 },
      { name: '_scratch', type: 0x0f, sect: 4, value: 0x100008010 },
      { name: '_printf', type: 0x01, sect: 0, desc: 0x0100, value: 0 },
      { name: '_SSL_new', type: 0x01, sect: 0, desc: 0x0200, value: 0 },
      { name: '_lookup', type: 0x01, sect: 0, desc: 0xfe00, value: 0 }
    ],
    dylibs: ['/usr/lib/libSystem.B.dylib', '@rpath/libssl.3.dylib'],
    uuid: Array.from({ length: 16 }, (_, i) => i * 17),
    buildVersion: { platform: 1, minos: 0x000b0000, sdk: 0x000e0200 },
    entryoff: 0xe40,
    rpath: '@executable_path/../Frameworks',
    encryption: { cryptoff: 0x1000, cryptsize: 0, cryptid: 0 },
    codeSignature: { identifier: 'com.example.sample', flags: 0x10002 },
    padTo: 0x1000,
    ...options
  })
}

describe('field trees and regions', () => {
  for (const [name, build] of Object.entries(FIXTURES)) {
    it(`are well formed for ${name}`, () => {
      const buffer = build()
      assertWellFormed(analyzeBytes(new Uint8Array(buffer)), buffer.byteLength, name)
    })
  }

  it('stay well formed for every truncated prefix', () => {
    for (const [name, build] of Object.entries(FIXTURES)) {
      const buffer = build()
      for (let length = 0; length <= buffer.byteLength; length++) {
        const bytes = new Uint8Array(buffer.slice(0, length))
        const analysis = analyzeBytes(bytes)
        assertWellFormed(analysis, length, `${name}[0, ${length})`)
        for (const s of analysis.symbols) {
          if (s.offset !== undefined) assert.ok(s.offset >= 0 && s.offset < length, `${name}[0, ${length}) ${s.name}`)
        }
      }
    }
  })

  it('keeps the magic as a top-level field', () => {
    for (const [name, build] of Object.entries(FIXTURES)) {
      const analysis = analyzeBytes(new Uint8Array(build()))
      assert.ok(analysis.fields.some(f => f.kind === 'magic' && f.offset === 0), name)
    }
  })

  it('caps the tree for files with very many section headers or load commands', () => {
    // 65535 zeroed ELF section headers
    const elfBytes = new Uint8Array(64 + 65535 * 64)
    elfBytes.set([0x7F, 0x45, 0x4C, 0x46, 2, 1, 1], 0)
    const dv = new DataView(elfBytes.buffer)
    dv.setBigUint64(40, 64n, true)
    dv.setUint16(58, 64, true)
    dv.setUint16(60, 65535, true)
    let t = performance.now()
    let analysis = analyzeBytes(elfBytes)
    assert.ok(performance.now() - t < 2000)
    assertWellFormed(analysis, elfBytes.length, 'many sections')
    assert.ok(countNodes(analysis.fields) < 7000)

    // 100000 empty Mach-O load commands
    const commands = Array.from({ length: 100000 }, () => ({ cmd: 0x99, cmdsize: 8 }))
    const machoBytes = new Uint8Array(buildMachO({ extraCommands: commands, segments: [] }))
    t = performance.now()
    analysis = analyzeBytes(machoBytes)
    assert.ok(performance.now() - t < 2000)
    assertWellFormed(analysis, machoBytes.length, 'many load commands')
    assert.ok(countNodes(analysis.fields) <= MAX_FIELD_NODES + 64)
  })
})

describe('ELF first look', () => {
  it('reports type, entry, interpreter, libraries, build ID and hardening', () => {
    const result = parse(elf, buildLinkedELF())
    assert.equal(fact(result, 'Type'), 'Position-independent executable (PIE)')
    assert.equal(fact(result, 'Interpreter'), '/lib64/ld-linux-x86-64.so.2')
    assert.equal(fact(result, 'Build ID'), 'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3')
    assert.equal(fact(result, 'Stripped'), 'yes')
    assert.deepEqual(result.summary.filter(s => s.label === 'Needed').map(s => s.value), ['libc.so.6', 'libfoo.so.2'])
    assert.equal(fact(result, 'RUNPATH'), '$ORIGIN/lib')
    assert.equal(fact(result, 'NX stack', 'Security'), 'yes')
    assert.equal(fact(result, 'PIE', 'Security'), 'yes')
    assert.equal(fact(result, 'RELRO', 'Security'), 'full')
    assert.equal(fact(result, 'Stack canary', 'Security'), 'yes')
    assert.equal(fact(result, 'FORTIFY', 'Security'), 'yes (1 checked function)')
    assert.match(fact(result, 'Entry point'), /^0x/)
  })

  it('tells executables, PIEs and shared objects apart', () => {
    assert.equal(fact(parse(elf, buildLinkedELF({ kind: 'exec' })), 'Type'), 'Executable')
    assert.equal(fact(parse(elf, buildLinkedELF({ kind: 'exec' })), 'PIE'), 'no (fixed load address)')
    const shared = parse(elf, buildLinkedELF({ kind: 'shared' }))
    assert.equal(fact(shared, 'Type'), 'Shared object')
    assert.equal(fact(shared, 'Soname'), 'libsample.so.1')
    assert.equal(fact(parse(elf, buildELF()), 'Type'), 'Shared object')
  })

  it('grades RELRO and the stack', () => {
    assert.equal(fact(parse(elf, buildLinkedELF({ relro: 'partial' })), 'RELRO'), 'partial')
    assert.equal(fact(parse(elf, buildLinkedELF({ relro: 'none' })), 'RELRO'), 'none')
    assert.equal(fact(parse(elf, buildLinkedELF({ execStack: true })), 'NX stack'), 'no (executable stack)')
    assert.equal(fact(parse(elf, buildLinkedELF({ noStackHeader: true })), 'NX stack'), 'unknown (no PT_GNU_STACK)')
  })

  it('names the library of versioned imports and locates defined symbols in the file', () => {
    const buffer = buildLinkedELF()
    const result = parse(elf, buffer)
    const printf = symbol(result, 'printf@GLIBC_2.2.5')
    assert.equal(printf.type, 'U')
    assert.equal(printf.library, 'libc.so.6')
    assert.equal(printf.note, 'libc.so.6')
    assert.equal(printf.offset, undefined)
    assert.match(printf.reason, /libc\.so\.6/)
    const exported = symbol(result, 'exported_fn')
    assert.equal(exported.kind, 'function')
    assert.equal(exported.size, 16)
    const bytes = new Uint8Array(buffer)
    assert.deepEqual([...bytes.subarray(exported.offset, exported.offset + 16)], Array(16).fill(0xc3))
  })

  it('reads everything it can from program headers when section headers are missing', () => {
    const result = parse(elf, buildLinkedELF({ noSectionHeaders: true }))
    assert.equal(fact(result, 'Interpreter'), '/lib64/ld-linux-x86-64.so.2')
    assert.equal(fact(result, 'Build ID'), 'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3')
    assert.deepEqual(result.summary.filter(s => s.label === 'Needed').map(s => s.value), ['libc.so.6', 'libfoo.so.2'])
    assert.ok(result.regions.some(r => r.name.startsWith('LOAD segment')))
  })

  it('decodes every ELF header field and each program and section header', () => {
    const result = parse(elf, buildLinkedELF())
    const header = result.fields.find(f => f.name === 'ELF header')
    assert.deepEqual(header.children.map(f => f.name), [
      'e_type', 'e_machine', 'e_version', 'e_entry', 'e_phoff', 'e_shoff', 'e_flags', 'e_ehsize',
      'e_phentsize', 'e_phnum', 'e_shentsize', 'e_shnum', 'e_shstrndx'
    ])
    const phdrs = result.fields.find(f => f.name === 'Program header table')
    assert.equal(phdrs.children.length, 9)
    assert.equal(phdrs.children[0].children.length, 8)
    const sections = result.fields.find(f => f.name === 'Section header table')
    assert.equal(sections.children[7].name, '[7] .text')
    assert.equal(sections.children[7].children.length, 10)
    assert.equal(result.regions.find(r => r.name === '.text').kind, 'code')
    assert.equal(result.regions.find(r => r.name === '.dynsym').kind, 'table')
    assert.ok(result.fields.some(f => f.name === 'Dynamic section'))
  })

  it('decodes 32-bit big-endian program headers in their own member order', () => {
    const result = parse(elf, buildLinkedELF({ is64: false, littleEndian: false, kind: 'exec' }))
    const first = result.fields.find(f => f.name === 'Program header table').children[0]
    assert.deepEqual(first.children.map(f => f.name), ['p_type', 'p_offset', 'p_vaddr', 'p_paddr', 'p_filesz', 'p_memsz', 'p_flags', 'p_align'])
    assert.equal(fact(result, 'Interpreter'), '/lib/ld-linux.so.2')
  })
})

describe('PE first look', () => {
  it('reports subsystem, entry, image base, linker, security flags and extras', () => {
    const result = parse(pe, buildFullPE())
    assert.equal(fact(result, 'Subsystem'), 'Windows console')
    assert.equal(fact(result, 'Entry point'), 'RVA 0x1010')
    assert.equal(fact(result, 'Image base'), '0x140000000')
    assert.equal(fact(result, 'Linker version'), '14.29')
    assert.equal(fact(result, 'ASLR', 'Security'), 'yes')
    assert.equal(fact(result, 'High-entropy VA', 'Security'), 'yes')
    assert.equal(fact(result, 'DEP', 'Security'), 'yes')
    assert.equal(fact(result, 'Control Flow Guard', 'Security'), 'yes')
    assert.equal(fact(result, 'Authenticode signature', 'Security'), 'present (PKCS #7 (Authenticode), 16 bytes)')
    assert.equal(fact(result, 'PDB path'), 'C:\\build\\sample.pdb')
    assert.equal(fact(result, '.NET assembly'), 'yes, metadata version v4.0.30319')
    assert.equal(fact(result, 'Overlay'), '64 bytes')
    assert.equal(fact(result, 'Rich header'), 'present (2 entries)')
  })

  it('reports missing protections', () => {
    const result = parse(pe, buildFullPE({ dllCharacteristics: 0, certificate: false, rich: false, clr: false, overlay: 0 }))
    assert.equal(fact(result, 'ASLR'), 'no')
    assert.equal(fact(result, 'DEP'), 'no')
    assert.equal(fact(result, 'Authenticode signature'), 'none')
    assert.equal(fact(result, 'Overlay'), 'none')
    assert.equal(fact(result, 'Rich header'), undefined)
    assert.equal(fact(result, '.NET assembly'), undefined)
  })

  it('groups imports by DLL, including ordinals and delay-loaded DLLs', () => {
    for (const pe32Plus of [true, false]) {
      const buffer = buildFullPE({ pe32Plus })
      const result = parse(pe, buffer)
      const imports = result.summary.filter(s => s.group === 'Imports')
      assert.deepEqual(imports.map(s => `${s.label}: ${s.value}`), [
        'KERNEL32.dll: 3 functions',
        'WS2_32.dll: 2 functions',
        'USER32.dll: 1 function, delay-loaded'
      ])
      assert.deepEqual(imports[0].details, ['CreateFileW', 'VirtualProtect', 'IsDebuggerPresent'])
      const ordinal = symbol(result, 'WS2_32.dll#23')
      assert.equal(ordinal.note, 'WS2_32.dll, ordinal 23')
      assert.equal(symbol(result, 'MessageBoxW').note, 'USER32.dll, delay-loaded')
      const bytes = new Uint8Array(buffer)
      for (const s of result.symbols.filter(x => x.type === 'U' && !x.name.includes('#'))) {
        assert.equal(String.fromCharCode(...bytes.subarray(s.offset + 2, s.offset + 2 + s.name.length)), s.name)
        assert.equal(s.library, s.note.split(',')[0])
      }
    }
  })

  it('decodes the headers into a tree', () => {
    const result = parse(pe, buildFullPE())
    assert.deepEqual(result.fields.slice(0, 6).map(f => f.name), [
      'DOS signature', 'DOS header', 'DOS stub', 'PE signature', 'COFF file header', 'Optional header'
    ])
    const optional = result.fields.find(f => f.name === 'Optional header')
    assert.deepEqual(optional.children.map(f => f.name), ['Standard fields', 'Windows-specific fields', 'Data directories'])
    assert.equal(optional.children[2].children.length, 16)
    assert.equal(result.fields.find(f => f.name === 'DOS header').children.at(-1).name, 'e_lfanew')
    const regions = result.regions.map(r => r.name)
    assert.ok(['Rich header', 'Overlay', 'Certificate table', '.text', '.rdata'].every(name => regions.includes(name)))
  })

  it('locates exports in the file', () => {
    const buffer = buildPE()
    const result = parse(pe, buffer)
    assert.equal(symbol(result, 'sample_init').offset, 0x400)
    assert.equal(symbol(result, 'Alpha').offset, 0x410)
    assert.equal(symbol(result, 'sample_table').offset, 0x800)
    const forwarded = symbol(result, 'Forwarded')
    assert.equal(String.fromCharCode(...new Uint8Array(buffer, forwarded.offset, forwarded.size - 1)), 'NTDLL.RtlZeroMemory')
  })
})

describe('Mach-O first look', () => {
  it('reports libraries, UUID, versions, entry point and signature', () => {
    const result = parse(macho, buildRichMachO())
    assert.equal(fact(result, 'UUID'), '00112233-4455-6677-8899-AABBCCDDEEFF')
    assert.equal(fact(result, 'Minimum OS'), 'macOS 11.0')
    assert.equal(fact(result, 'SDK'), '14.2')
    assert.equal(fact(result, 'Entry point'), '0x100000E40')
    assert.deepEqual(result.summary.filter(s => s.label === 'Linked').map(s => s.value), ['/usr/lib/libSystem.B.dylib', '@rpath/libssl.3.dylib'])
    assert.equal(fact(result, 'RPATH'), '@executable_path/../Frameworks')
    assert.equal(fact(result, 'PIE', 'Security'), 'yes')
    assert.equal(fact(result, 'Code signature', 'Security'), 'present, ad-hoc')
    assert.equal(fact(result, 'Hardened runtime', 'Security'), 'yes')
    assert.equal(fact(result, 'Encrypted', 'Security'), 'no')
    assert.equal(fact(result, 'Header flags'), 'NOUNDEFS DYLDLINK TWOLEVEL PIE')
    const signature = result.summary.find(s => s.label === 'Code signature')
    assert.ok(signature.details.includes('Identifier: com.example.sample'))
  })

  it('attributes two-level namespace imports to their library', () => {
    const result = parse(macho, buildRichMachO())
    assert.equal(symbol(result, 'printf').library, '/usr/lib/libSystem.B.dylib')
    assert.equal(symbol(result, 'SSL_new').note, '@rpath/libssl.3.dylib')
    assert.equal(symbol(result, 'lookup').library, undefined)
    // Without MH_TWOLEVEL the ordinal means nothing
    assert.equal(symbol(parse(macho, buildRichMachO({ flags: 0 })), 'printf').library, undefined)
  })

  it('locates defined symbols through their section', () => {
    const result = parse(macho, buildRichMachO())
    assert.equal(symbol(result, 'main').offset, 0xe40)
    assert.equal(symbol(result, 'message').offset, 0xf00)
    assert.equal(symbol(result, 'scratch').offset, undefined)
    assert.match(symbol(result, 'scratch').reason, /zero-filled/)
  })

  it('decodes load commands', () => {
    const result = parse(macho, buildRichMachO())
    const commands = result.fields.find(f => f.name === 'Load commands').children.map(f => f.name)
    assert.deepEqual(commands, [
      'LC_SEGMENT_64', 'LC_SEGMENT_64', 'LC_LOAD_DYLIB', 'LC_LOAD_DYLIB', 'LC_RPATH', 'LC_UUID', 'LC_BUILD_VERSION',
      'LC_MAIN', 'LC_ENCRYPTION_INFO_64', 'LC_CODE_SIGNATURE', 'LC_SYMTAB'
    ])
    const text = result.fields.find(f => f.name === 'Load commands').children[0]
    assert.ok(text.children.some(f => f.name === '__TEXT,__text'))
    const regions = result.regions.map(r => r.name)
    assert.ok(['Mach header', 'Load commands', '__TEXT,__text', '__TEXT,__cstring', 'Symbol table', 'String table', 'Code signature'].every(n => regions.includes(n)))
  })

  it('describes each slice of a universal binary', () => {
    const result = parse(macho, FIXTURES['universal Mach-O']())
    const fat = result.fields.find(f => f.name === 'Fat header')
    assert.equal(fat.children.length, 3)
    assert.deepEqual(result.fields.filter(f => f.name.endsWith(' slice')).map(f => f.name), ['x86_64 slice', 'arm64 slice'])
  })
})

describe('tileRegions', () => {
  it('trims overlaps and fills gaps', () => {
    const tiled = tileRegions([
      { name: 'b', offset: 10, length: 10, kind: 'data' },
      { name: 'a', offset: 0, length: 5, kind: 'header' },
      { name: 'inner', offset: 12, length: 2, kind: 'data' },
      { name: 'tail', offset: 15, length: 10, kind: 'data' },
      { name: 'outside', offset: 40, length: 1 }
    ], 30, 'gap', new Uint8Array(30))
    assert.deepEqual(tiled.map(r => `${r.name}@${r.offset}+${r.length}`), ['a@0+5', 'gap@5+5', 'b@10+10', 'tail@20+5', 'gap@25+5'])
    assert.equal(tiled[1].kind, 'padding')
  })
})
