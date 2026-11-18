// Small files built to make a parser produce far more than their size
// suggests. They are built here rather than committed as binaries.

import { buildZip } from './fileFormats.js'

/**
 * A PE32 of about 350 KB whose import descriptors all share one table of
 * 65,535 entries, every one pointing at the same name. Read naively that is
 * 4,096 × 65,535 imports of `nameLength` characters each.
 * @param {{ nameLength?: number, descriptors?: number, dllName?: Uint8Array | string }} [options]
 */
export function buildPEImportBomb({ nameLength = 24, descriptors = 4096, dllName = 'KERNEL32.dll' } = {}) {
  const SIZE = 0x59000
  const bytes = new Uint8Array(SIZE)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x4D
  bytes[1] = 0x5A
  view.setUint32(0x3C, 0x40, true)
  view.setUint32(0x40, 0x00004550, true)
  const coff = 0x44
  view.setUint16(coff, 0x14C, true) // i386
  view.setUint16(coff + 2, 1, true) // one section
  view.setUint16(coff + 16, 0xE0, true)
  view.setUint16(coff + 18, 0x0102, true)
  const opt = coff + 20
  view.setUint16(opt, 0x10B, true) // PE32
  view.setUint32(opt + 16, 0x1000, true)
  view.setUint32(opt + 28, 0x400000, true)
  view.setUint32(opt + 32, 0x1000, true)
  view.setUint32(opt + 36, 0x200, true)
  view.setUint32(opt + 56, SIZE, true)
  view.setUint32(opt + 60, 0x1000, true)
  view.setUint16(opt + 68, 3, true)
  view.setUint32(opt + 92, 16, true)
  view.setUint32(opt + 96 + 8, 0x1000, true) // import directory
  view.setUint32(opt + 96 + 12, (descriptors + 1) * 20, true)
  const section = opt + 0xE0
  bytes.set(new TextEncoder().encode('.data'), section)
  view.setUint32(section + 8, SIZE - 0x1000, true)
  view.setUint32(section + 12, 0x1000, true)
  view.setUint32(section + 16, SIZE - 0x1000, true)
  view.setUint32(section + 20, 0x1000, true)
  view.setUint32(section + 36, 0xC0000040, true)
  // Section RVAs equal file offsets, so the offsets below double as RVAs
  const THUNKS = 0x16000
  const HINT = 0x57000
  const DLL = 0x58000
  for (let i = 0; i < descriptors; i++) {
    const at = 0x1000 + i * 20
    view.setUint32(at, THUNKS, true)
    view.setUint32(at + 12, DLL, true)
    view.setUint32(at + 16, THUNKS, true)
  }
  for (let i = 0; i < 65535; i++) view.setUint32(THUNKS + i * 4, HINT, true)
  for (let i = 0; i < Math.min(nameLength, DLL - HINT - 3); i++) bytes[HINT + 2 + i] = 0x41 + (i % 26)
  bytes.set(typeof dllName === 'string' ? new TextEncoder().encode(dllName) : dllName, DLL)
  return bytes
}

/**
 * A ZIP whose entry names are paths of 32,760 one-letter folders
 * ('b0/a/a/…/f'), about 65 KB each.
 * @param {number} [entries]
 */
export function buildDeepZip(entries = 1) {
  const list = Array.from({ length: entries }, (_, i) => ({
    name: String.fromCharCode(98 + (i % 24)) + i + '/' + 'a/'.repeat(32760) + 'f',
    data: ''
  }))
  return new Uint8Array(buildZip(list))
}
