import { field, fitted, formatNumber, latin1, printable } from './reader.js'
import { formatBytes, hexBytes, item } from './shared.js'

// The boot ROM refuses to start a cartridge unless these bytes are present
const LOGO = [
  0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00, 0x0D,
  0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E, 0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD, 0xD9, 0x99,
  0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC, 0xDD, 0xDC, 0x99, 0x9F, 0xBB, 0xB9, 0x33, 0x3E
]

const CARTRIDGES = {
  0x00: 'ROM only', 0x01: 'MBC1', 0x02: 'MBC1 + RAM', 0x03: 'MBC1 + RAM + battery', 0x05: 'MBC2', 0x06: 'MBC2 + battery', 0x08: 'ROM + RAM',
  0x09: 'ROM + RAM + battery', 0x0B: 'MMM01', 0x0C: 'MMM01 + RAM', 0x0D: 'MMM01 + RAM + battery', 0x0F: 'MBC3 + timer + battery',
  0x10: 'MBC3 + timer + RAM + battery', 0x11: 'MBC3', 0x12: 'MBC3 + RAM', 0x13: 'MBC3 + RAM + battery', 0x19: 'MBC5', 0x1A: 'MBC5 + RAM',
  0x1B: 'MBC5 + RAM + battery', 0x1C: 'MBC5 + rumble', 0x1D: 'MBC5 + rumble + RAM', 0x1E: 'MBC5 + rumble + RAM + battery', 0x20: 'MBC6',
  0x22: 'MBC7 + sensor + rumble + RAM + battery', 0xFC: 'Pocket Camera', 0xFD: 'Bandai TAMA5', 0xFE: 'HuC3', 0xFF: 'HuC1 + RAM + battery'
}
const RAM_SIZES = { 0: 'None', 1: '2 KB (unofficial)', 2: '8 KB', 3: '32 KB (4 banks)', 4: '128 KB (16 banks)', 5: '64 KB (8 banks)' }
const LICENSEES = { 0x01: 'Nintendo', 0x08: 'Capcom', 0x13: 'Electronic Arts', 0x18: 'Hudson Soft', 0x34: 'Konami', 0x41: 'Ubisoft', 0x52: 'Activision', 0xA4: 'Konami', 0xAF: 'Namco', 0xC3: 'Squaresoft' }
const NEW_LICENSEES = { '01': 'Nintendo', '08': 'Capcom', '13': 'Electronic Arts', '18': 'Hudson Soft', '34': 'Konami', '41': 'Ubisoft', '52': 'Activision', '69': 'Electronic Arts', A4: 'Konami' }

function headerChecksum(bytes) {
  let x = 0
  for (let i = 0x134; i <= 0x14C; i++) x = (x - bytes[i] - 1) & 0xFF
  return x
}

function globalChecksum(bytes) {
  let sum = 0
  for (let i = 0; i < bytes.length; i++) if (i !== 0x14E && i !== 0x14F) sum = (sum + bytes[i]) & 0xFFFF
  return sum
}

function parseGameBoy(bytes) {
  const warnings = []
  const summary = []
  const cgb = bytes[0x143]
  const cgbMode = cgb === 0xC0 ? 'Game Boy Color only' : cgb === 0x80 ? 'Game Boy Color enhanced (also runs on Game Boy)' : 'Game Boy'
  const newStyle = cgb === 0x80 || cgb === 0xC0
  const titleLength = newStyle ? 11 : 16
  const title = printable(latin1(bytes, 0x134, titleLength).replace(/\0[\s\S]*$/, '').trim(), 40)
  const type = bytes[0x147]
  const romCode = bytes[0x148]
  const romSize = romCode <= 8 ? 32768 << romCode : null
  const ramCode = bytes[0x149]
  const oldLicensee = bytes[0x14B]
  const newLicensee = latin1(bytes, 0x144, 2)
  const licensee = oldLicensee === 0x33 ? NEW_LICENSEES[newLicensee] || `code "${printable(newLicensee)}"` : LICENSEES[oldLicensee] || `code 0x${oldLicensee.toString(16).toUpperCase().padStart(2, '0')}`
  const storedHeader = bytes[0x14D]
  const computedHeader = headerChecksum(bytes)
  const storedGlobal = (bytes[0x14E] << 8) | bytes[0x14F]
  const computedGlobal = globalChecksum(bytes)
  const logoOk = LOGO.every((byte, i) => bytes[0x104 + i] === byte)

  const children = [
    field('Entry point', 0x100, 4, hexBytes(bytes, 0x100, 4), 'Usually NOP; JP to the start of the program', 'header'),
    field('Nintendo logo', 0x104, 48, logoOk ? 'valid' : 'altered', 'Checked by the boot ROM before starting the cartridge', 'magic'),
    field('Title', 0x134, titleLength, title, 'Upper-case ASCII game title', 'string')
  ]
  if (newStyle) children.push(field('Manufacturer code', 0x13F, 4, printable(latin1(bytes, 0x13F, 4)), 'Four-letter code on newer cartridges', 'string'))
  if (newStyle) children.push(field('CGB flag', 0x143, 1, `0x${cgb.toString(16).toUpperCase().padStart(2, '0')} (${cgbMode})`, 'Game Boy Color support', 'flags'))
  children.push(
    field('New licensee code', 0x144, 2, printable(newLicensee), 'Publisher, used when the old code is 0x33', 'string'),
    field('SGB flag', 0x146, 1, bytes[0x146] === 3 ? 'Super Game Boy functions' : 'none', 'Super Game Boy support', 'flags'),
    field('Cartridge type', 0x147, 1, CARTRIDGES[type] || `unknown (0x${type.toString(16)})`, 'Memory bank controller and extras', 'flags'),
    field('ROM size', 0x148, 1, romSize ? formatBytes(romSize) : `unknown code ${romCode}`, '32 KB shifted left by this value', 'size'),
    field('RAM size', 0x149, 1, RAM_SIZES[ramCode] || `unknown code ${ramCode}`, 'Cartridge RAM', 'size'),
    field('Destination', 0x14A, 1, bytes[0x14A] === 0 ? 'Japan' : 'Overseas', 'Sales region', 'flags'),
    field('Old licensee code', 0x14B, 1, `0x${oldLicensee.toString(16).toUpperCase().padStart(2, '0')}`, '0x33 means the new code is used'),
    field('Version', 0x14C, 1, bytes[0x14C], 'Mask ROM version'),
    field('Header checksum', 0x14D, 1, `0x${storedHeader.toString(16).toUpperCase().padStart(2, '0')} (${storedHeader === computedHeader ? 'valid' : `expected 0x${computedHeader.toString(16).toUpperCase()}`})`, 'Over 0x134-0x14C; the boot ROM checks it', 'checksum'),
    field('Global checksum', 0x14E, 2, `0x${storedGlobal.toString(16).toUpperCase().padStart(4, '0')} (${storedGlobal === computedGlobal ? 'valid' : `computed 0x${computedGlobal.toString(16).toUpperCase().padStart(4, '0')}`})`, 'Sum of all other bytes; not checked by hardware', 'checksum')
  )
  const fields = [
    field('Restart and interrupt vectors', 0, 0x100, undefined, 'RST targets and interrupt handlers', 'code'),
    field('Cartridge header', 0x100, 0x50, title || 'untitled', 'Read by the boot ROM', 'header', children)
  ]
  if (bytes.length > 0x150) fields.push(field('Program', 0x150, bytes.length - 0x150, formatBytes(bytes.length - 0x150), 'Code and data in ROM banks', 'code'))
  const regions = [
    { name: 'Vectors', offset: 0, length: 0x100, kind: 'code' },
    { name: 'Cartridge header', offset: 0x100, length: 0x50, kind: 'header' },
    { name: 'Program', offset: 0x150, length: Math.max(0, bytes.length - 0x150), kind: 'code' }
  ]

  if (!logoOk) warnings.push('The Nintendo logo differs from the one the boot ROM expects')
  if (storedHeader !== computedHeader) warnings.push('Header checksum does not match; real hardware will not start this cartridge')
  if (romSize && romSize !== bytes.length) warnings.push(`Header declares ${formatBytes(romSize)} of ROM but the file is ${formatBytes(bytes.length)}`)

  summary.push(item('Title', title || '(none)'))
  summary.push(item('Platform', cgbMode))
  summary.push(item('Cartridge', CARTRIDGES[type] || `Unknown (0x${type.toString(16)})`))
  summary.push(item('ROM Size', romSize ? formatBytes(romSize) : `Unknown code ${romCode}`))
  summary.push(item('RAM Size', RAM_SIZES[ramCode] || `Unknown code ${ramCode}`))
  summary.push(item('Super Game Boy', bytes[0x146] === 3 ? 'Supported' : 'No'))
  summary.push(item('Region', bytes[0x14A] === 0 ? 'Japan' : 'Overseas'))
  summary.push(item('Licensee', licensee))
  summary.push(item('Version', formatNumber(bytes[0x14C])))
  summary.push(item('Header Checksum', storedHeader === computedHeader ? 'Valid' : 'Invalid'))
  summary.push(item('Global Checksum', storedGlobal === computedGlobal ? 'Valid' : 'Mismatch'))
  return { formatName: cgb === 0xC0 ? 'Game Boy Color ROM' : 'Game Boy ROM', summary, fields, regions, warnings }
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'gameboy',
  name: 'Game Boy ROM',
  category: 'executable',
  detect: bytes => bytes.length >= 0x150 && LOGO.every((byte, i) => bytes[0x104 + i] === byte),
  parse: fitted(parseGameBoy)
}
