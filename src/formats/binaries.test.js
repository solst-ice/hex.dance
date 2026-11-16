import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBytes } from '../analysis/analyze.js'
import { readTL } from './der.js'
import * as F from './__fixtures__/moreFormats.js'

function facts(bytes) {
  const analysis = analyzeBytes(bytes)
  const out = { formatId: analysis.formatId, formatName: analysis.formatName, warnings: analysis.warnings }
  for (const entry of analysis.summary) out[entry.group ? `${entry.group}/${entry.label}` : entry.label] = entry.value
  return out
}

test('WebAssembly: sections, counts, imports and exports as symbols', () => {
  const analysis = analyzeBytes(F.buildWasm())
  assert.deepEqual(analysis.fields.map(f => f.name), ['Header', 'Type', 'Import', 'Function', 'Global', 'Export', 'Code', 'Custom "name"'])
  assert.deepEqual(analysis.symbols, [
    { name: 'env.log', type: 'U', note: 'imported function, type 0' },
    { name: 'env.memory', type: 'U', note: 'imported memory, 1+ pages' },
    { name: 'add', type: 'T', address: '0x1', note: 'exported function 1' },
    { name: 'sub', type: 'T', address: '0x2', note: 'exported function 2' }
  ])
  const f = facts(F.buildWasm())
  assert.equal(f.Functions, '2 defined, 1 imported')
  assert.equal(f['Memory 0'], '1+ pages (64 KB initial), imported')
  assert.equal(f['Custom Sections'], 'name')
  assert.equal(f['Debug Names'], 'Yes (2 function names)')
  const code = analysis.fields.find(field => field.name === 'Code')
  assert.deepEqual(code.children.slice(3).map(c => [c.name, c.length]), [['Function 1', 8], ['Function 2', 8]])
})

test('SQLite: header and schema', () => {
  const f = facts(F.buildSQLite({ tableName: 'people' }))
  assert.equal(f['SQLite Version'], '3.45.1')
  assert.equal(f['Page Size'], '1,024 bytes')
  assert.equal(f.Pages, '2')
  assert.equal(f['Text Encoding'], 'UTF-8')
  assert.equal(f['Schema Objects'], '1 table')
  assert.equal(f['Tables/people'], 'table, root page 2')
  assert.deepEqual(analyzeBytes(F.buildSQLite()).symbols, [{ name: 'items', type: 'D', note: 'table, root page 2' }])
  const truncated = F.buildSQLite().subarray(0, 1500)
  assert.ok(facts(truncated).warnings.includes('File size is not a multiple of the page size (476 extra bytes)'))
})

test('fonts: sfnt names and metrics, WOFF and WOFF2 directories', () => {
  const ttf = facts(F.buildTTF())
  assert.deepEqual([ttf.formatName, ttf['Full Name'], ttf.Family, ttf.Style, ttf.Version, ttf.Glyphs, ttf['Units per Em'], ttf.Weight],
    ['TrueType Font', 'Fixture Sans Regular', 'Fixture Sans', 'Regular', 'Version 1.000', '42', '1000', '400 (Regular)'])
  assert.deepEqual(ttf.warnings, [])
  const woff = facts(F.buildWOFF())
  assert.deepEqual([woff.formatName, woff['Full Name'], woff.Tables], ['WOFF Font', 'Fixture Sans Regular', '4'])
  const woff2 = analyzeBytes(F.buildWOFF2())
  assert.equal(woff2.formatName, 'WOFF2 Font')
  assert.deepEqual(woff2.fields.find(f => f.name === 'Table directory').children.map(c => c.name), ['head', 'maxp', 'glyf', 'loca'])
})

test('pcap and pcapng: link type, packets and time span', () => {
  const pcap = facts(F.buildPcap({ packets: 3 }))
  assert.deepEqual([pcap['Link Type'], pcap.Packets, pcap['Capture Duration'], pcap['Truncated Packets']], ['Ethernet (1)', '3', '2 s', '1 (cut at the snapshot length)'])
  const be = facts(F.buildPcap({ little: false, nano: true }))
  assert.deepEqual([be.Format, be['Timestamp Resolution']], ['pcap 2.4 (big-endian)', 'Nanoseconds'])
  const ng = facts(F.buildPcapng({ packets: 4 }))
  assert.deepEqual([ng.formatName, ng.Packets, ng['Captured With'], ng['Interfaces/Interface 0'], ng['First Packet']], ['pcapng Packet Capture', '4', 'fixture', 'Ethernet (1), eth0', '2023-11-14 22:13:20 UTC'])
})

test('binary plist: trailer and root keys', () => {
  const f = facts(F.buildBplist())
  assert.equal(f.Objects, '7')
  assert.equal(f.Root, 'dictionary of 3 keys')
  assert.equal(f['Root keys/name'], '"Fixture"')
  assert.equal(f['Root keys/count'], '3')
  assert.equal(f['Root keys/ok'], 'true')
})

test('DER: X.509 facts and an ASN.1 tree', () => {
  const f = facts(F.buildCertificate())
  assert.equal(f.formatName, 'X.509 Certificate (DER)')
  assert.equal(f.Subject, 'C=NL, CN=fixture.test')
  assert.equal(f.Issuer, 'C=NL, CN=Fixture CA')
  assert.equal(f.Version, 'v3')
  assert.equal(f['Serial Number'], '74565')
  assert.equal(f['Valid From'], '2024-01-02 03:04:05 UTC')
  assert.equal(f['Valid Until'], '2034-12-31 23:59:59 UTC')
  assert.equal(f['Signature Algorithm'], 'sha256WithRSAEncryption')
  assert.equal(f['Public Key'], 'rsaEncryption, 512 bits')
  assert.equal(f['Certificate Authority'], 'Yes')
  assert.equal(f['Subject Alt Names'], '2')
  const root = analyzeBytes(F.buildCertificate()).fields[0]
  assert.equal(root.name, 'SEQUENCE')
  assert.deepEqual(root.children.slice(0, 2).map(c => c.name), ['Tag', 'Length'])
  assert.equal(readTL(Uint8Array.of(0x30, 0x80, 0, 0), 0, 4), null)
  assert.deepEqual(readTL(Uint8Array.of(0x04, 0x82, 0x01, 0x00), 0, 400), { cls: 0, constructed: false, number: 4, tagByte: 4, tagEnd: 1, headerEnd: 4, length: 256, end: 260 })
})

test('ROM headers: iNES and Game Boy', () => {
  const nes = facts(F.buildNES({ prg: 8, chr: 0, mapper: 4 }))
  assert.deepEqual([nes.Mapper, nes['PRG ROM'], nes['CHR ROM'], nes.Mirroring, nes['Battery-backed RAM']], ['4 (MMC3 (TxROM))', '128 KB', 'None (CHR RAM)', 'Vertical', 'Yes'])
  const gb = facts(F.buildGameBoy())
  assert.deepEqual([gb.Title, gb.Cartridge, gb['ROM Size'], gb['RAM Size'], gb.Licensee, gb['Header Checksum'], gb['Global Checksum']],
    ['FIXTURE', 'MBC1 + RAM + battery', '32 KB', '8 KB', 'Nintendo', 'Valid', 'Valid'])
  const bad = F.buildGameBoy()
  bad[0x134] = 0x5A
  assert.ok(facts(bad).warnings.includes('Header checksum does not match; real hardware will not start this cartridge'))
})

test('partition tables: MBR and GPT with CRC checks', () => {
  const mbr = facts(F.buildMBR())
  assert.deepEqual([mbr.Scheme, mbr['Disk Signature'], mbr.Partitions, mbr['Partitions/Partition 1'], mbr['Partitions/Partition 2']],
    ['Master Boot Record (MBR)', '0xA1B2C3D4', '2', 'FAT32 (LBA), active, 10 KB', 'Linux, 20 KB'])
  const gpt = facts(F.buildGPT())
  assert.deepEqual([gpt.Scheme, gpt['Disk GUID'], gpt.Partitions, gpt['Partitions/Partition 1'], gpt['Partitions/Partition 2']],
    ['GUID Partition Table (GPT)', '12345678-1234-5678-9ABC-DEF012345678', '2', 'EFI system partition "EFI", 15 KB', 'Linux filesystem "root", 28.5 KB'])
  assert.deepEqual(gpt.warnings, [])
  const corrupt = F.buildGPT()
  corrupt[1024 + 60] ^= 1
  assert.ok(facts(corrupt).warnings.includes('GPT partition entries CRC32 does not match'))
})

test('ISO 9660: volume descriptor and directory tree for the Archive panel', () => {
  const analysis = analyzeBytes(F.buildISO({ label: 'MYDISC' }))
  assert.equal(analysis.category, 'archive')
  assert.deepEqual(analysis.entries.map(e => [e.path, e.isDirectory, e.size]), [['HELLO.TXT', false, 5], ['SUB', true, 0], ['SUB/NESTED.TXT', false, 5]])
  const f = facts(F.buildISO({ label: 'MYDISC' }))
  assert.deepEqual([f['Volume Label'], f['Volume Size'], f.Publisher, f.Created], ['MYDISC', '46 KB (23 blocks of 2048 bytes)', 'FIXTURE PUBLISHER', '2024-01-02 03:04:05'])
})
