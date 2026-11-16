import { field, fitted, formatNumber } from './reader.js'
import { formatBytes, item } from './shared.js'

const MAPPERS = {
  0: 'NROM', 1: 'MMC1 (SxROM)', 2: 'UxROM', 3: 'CNROM', 4: 'MMC3 (TxROM)', 5: 'MMC5 (ExROM)', 7: 'AxROM', 9: 'MMC2 (PxROM)', 10: 'MMC4 (FxROM)',
  11: 'Color Dreams', 13: 'CPROM', 15: '100-in-1', 16: 'Bandai FCG', 18: 'Jaleco SS8806', 19: 'Namco 163', 21: 'VRC4a/c', 22: 'VRC2a', 23: 'VRC2b/VRC4e',
  24: 'VRC6a', 25: 'VRC4b/d', 26: 'VRC6b', 34: 'BNROM / NINA-001', 64: 'RAMBO-1', 66: 'GxROM', 69: 'Sunsoft FME-7', 71: 'Camerica', 73: 'VRC3',
  75: 'VRC1', 79: 'NINA-03/06', 85: 'VRC7', 94: 'UN1ROM', 105: 'NES-EVENT', 118: 'TxSROM', 119: 'TQROM', 180: 'UNROM (Crazy Climber)', 206: 'Namco 118'
}

function parseNES(bytes) {
  const warnings = []
  const summary = []
  const regions = []
  const flags6 = bytes[6]
  const flags7 = bytes[7]
  const nes2 = (flags7 & 0x0C) === 0x08
  let mapper = (flags6 >> 4) | (flags7 & 0xF0)
  let submapper = null
  let prgUnits = bytes[4]
  let chrUnits = bytes[5]
  let prgSize
  let chrSize
  if (nes2) {
    mapper |= (bytes[8] & 0x0F) << 8
    submapper = bytes[8] >> 4
    const prgMsb = bytes[9] & 0x0F
    const chrMsb = bytes[9] >> 4
    // An MSB nibble of 0xF selects the exponent-multiplier notation
    prgSize = prgMsb === 0x0F ? 2 ** (bytes[4] >> 2) * ((bytes[4] & 3) * 2 + 1) : ((prgMsb << 8) | prgUnits) * 16384
    chrSize = chrMsb === 0x0F ? 2 ** (bytes[5] >> 2) * ((bytes[5] & 3) * 2 + 1) : ((chrMsb << 8) | chrUnits) * 8192
  } else {
    // Old dumping tools wrote junk into bytes 7-15; then only the low nibble is trustworthy
    const junk = bytes[12] || bytes[13] || bytes[14] || bytes[15]
    if (junk) {
      mapper &= 0x0F
      warnings.push('Header bytes 12-15 are not zero (written by an old tool); mapper high bits ignored')
    }
    if (prgUnits === 0) prgUnits = 256
    prgSize = prgUnits * 16384
    chrSize = chrUnits * 8192
  }
  const trainer = (flags6 & 4) !== 0
  const fourScreen = (flags6 & 8) !== 0
  const mirroring = fourScreen ? 'Four-screen' : flags6 & 1 ? 'Vertical' : 'Horizontal'
  const battery = (flags6 & 2) !== 0
  const system = ['NES / Famicom', 'Vs. System', 'PlayChoice-10', 'Extended'][flags7 & 3]
  const tv = nes2 ? ['NTSC', 'PAL', 'Multi-region', 'Dendy'][bytes[12] & 3] : bytes[9] & 1 ? 'PAL' : 'NTSC'

  const headerChildren = [
    field('Magic', 0, 4, 'NES\\x1A', 'iNES signature', 'magic'),
    field('PRG ROM size', 4, 1, formatBytes(prgSize), nes2 ? 'LSB of the PRG ROM size' : '16 KB units', 'size'),
    field('CHR ROM size', 5, 1, chrSize ? formatBytes(chrSize) : '0 (uses CHR RAM)', nes2 ? 'LSB of the CHR ROM size' : '8 KB units', 'size'),
    field('Flags 6', 6, 1, [mirroring + ' mirroring', battery ? 'battery' : null, trainer ? 'trainer' : null, `mapper low nibble ${flags6 >> 4}`].filter(Boolean).join(', '), 'Mirroring, battery, trainer, mapper bits 0-3', 'flags'),
    field('Flags 7', 7, 1, `${system}, ${nes2 ? 'NES 2.0' : 'iNES'}, mapper high nibble ${flags7 >> 4}`, 'Console type, format, mapper bits 4-7', 'flags'),
    field(nes2 ? 'Mapper MSB / submapper' : 'PRG RAM size', 8, 1, nes2 ? `submapper ${submapper}` : bytes[8] ? formatBytes(bytes[8] * 8192) : '8 KB (assumed)', nes2 ? 'Mapper bits 8-11 and submapper' : '8 KB units', 'flags'),
    field(nes2 ? 'ROM size MSBs' : 'TV system', 9, 1, nes2 ? `0x${bytes[9].toString(16)}` : tv, nes2 ? 'High bits of the PRG and CHR sizes' : 'Rarely used', 'flags'),
    field('Rest of header', 10, 6, undefined, nes2 ? 'RAM sizes, timing, console and expansion device' : 'Unused, should be zero', nes2 ? 'flags' : 'padding')
  ]
  const fields = [field('Header', 0, 16, nes2 ? 'NES 2.0' : 'iNES', '16-byte cartridge header', 'header', headerChildren)]
  regions.push({ name: 'Header', offset: 0, length: 16, kind: 'header' })
  let pos = 16
  const add = (name, length, description, kind) => {
    if (length <= 0 || pos >= bytes.length) return
    const available = Math.min(length, bytes.length - pos)
    fields.push(field(name, pos, available, formatBytes(length), description, 'data'))
    regions.push({ name, offset: pos, length: available, kind })
    if (available < length) warnings.push(`${name} is truncated: ${formatNumber(available)} of ${formatNumber(length)} bytes present`)
    pos += length
  }
  add('Trainer', trainer ? 512 : 0, 'Code copied to $7000 before start', 'code')
  add('PRG ROM', prgSize, 'Program code and data for the CPU', 'code')
  add('CHR ROM', chrSize, 'Pattern tables (graphics) for the PPU', 'data')
  if (pos < bytes.length) {
    const rest = bytes.length - pos
    const title = rest <= 128 ? new TextDecoder('latin1').decode(bytes.subarray(pos)).replace(/[\0\xFF]+$/, '').trim() : ''
    fields.push(field(title ? 'Title' : 'Extra data', pos, rest, title || formatBytes(rest), title ? 'Optional title block' : 'After the ROM data (PlayChoice data, or a bad dump)', 'data'))
    if (!title) warnings.push(`${formatNumber(rest)} bytes after the ROM data`)
  }

  summary.push(item('Header Format', nes2 ? 'NES 2.0' : 'iNES'))
  summary.push(item('Mapper', `${mapper}${MAPPERS[mapper] ? ` (${MAPPERS[mapper]})` : ''}${submapper ? `, submapper ${submapper}` : ''}`))
  summary.push(item('PRG ROM', formatBytes(prgSize)))
  summary.push(item('CHR ROM', chrSize ? formatBytes(chrSize) : 'None (CHR RAM)'))
  summary.push(item('Mirroring', mirroring))
  summary.push(item('Battery-backed RAM', battery ? 'Yes' : 'No'))
  if (trainer) summary.push(item('Trainer', 'Yes (512 bytes)'))
  summary.push(item('Console', system))
  summary.push(item('TV System', tv))
  return { formatName: 'NES ROM (iNES)', summary, fields, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'nes',
  name: 'NES ROM (iNES)',
  category: 'executable',
  detect: bytes => bytes.length >= 16 && bytes[0] === 0x4E && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1A,
  parse: fitted(parseNES)
}
