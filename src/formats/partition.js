import { ByteReader, capFields, field, fitted, formatNumber, guid, hex32, plural, printable, utf16 } from './reader.js'
import { crc32 } from '../lib/crc32.js'
import { formatBytes, item } from './shared.js'
import { pointAt } from './pointers.js'

const MAX_GPT_ENTRIES = 256

const MBR_TYPES = {
  0x00: 'Empty', 0x01: 'FAT12', 0x04: 'FAT16 (<32 MB)', 0x05: 'Extended (CHS)', 0x06: 'FAT16', 0x07: 'NTFS / exFAT / HPFS', 0x0B: 'FAT32 (CHS)',
  0x0C: 'FAT32 (LBA)', 0x0E: 'FAT16 (LBA)', 0x0F: 'Extended (LBA)', 0x11: 'Hidden FAT12', 0x12: 'Diagnostics / recovery', 0x17: 'Hidden NTFS',
  0x1B: 'Hidden FAT32', 0x1C: 'Hidden FAT32 (LBA)', 0x27: 'Windows recovery', 0x39: 'Plan 9', 0x42: 'Windows dynamic disk', 0x63: 'Unix System V',
  0x7F: 'Reserved (experimental)', 0x82: 'Linux swap', 0x83: 'Linux', 0x85: 'Linux extended', 0x8E: 'Linux LVM', 0xA5: 'FreeBSD', 0xA6: 'OpenBSD',
  0xA8: 'Apple UFS', 0xA9: 'NetBSD', 0xAB: 'Apple boot', 0xAF: 'Apple HFS / HFS+', 0xBE: 'Solaris boot', 0xBF: 'Solaris', 0xDA: 'Non-filesystem data',
  0xEE: 'GPT protective', 0xEF: 'EFI system', 0xFB: 'VMware VMFS', 0xFC: 'VMware swap', 0xFD: 'Linux RAID'
}

const GPT_TYPES = {
  'C12A7328-F81F-11D2-BA4B-00A0C93EC93B': 'EFI system partition', '21686148-6449-6E6F-744E-656564454649': 'BIOS boot partition',
  'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7': 'Microsoft basic data', 'E3C9E316-0B5C-4DB8-817D-F92DF00215AE': 'Microsoft reserved',
  'DE94BBA4-06D1-4D40-A16A-BFD50179D6AC': 'Windows recovery', '0FC63DAF-8483-4772-8E79-3D69D8477DE4': 'Linux filesystem',
  '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F': 'Linux swap', 'E6D6D379-F507-44C2-A23C-238F2A3DF928': 'Linux LVM', 'A19D880F-05FC-4D3B-A006-743F0F84911E': 'Linux RAID',
  '4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709': 'Linux root (x86-64)', 'B921B045-1DF0-41C3-AF44-4C6F280D3FAE': 'Linux root (ARM64)', '933AC7E1-2EB4-4F13-B844-0E14E2AEF915': 'Linux /home',
  'BC13C2FF-59E6-4262-A352-B275FD6F7172': 'Linux extended boot', '48465300-0000-11AA-AA11-00306543ECAC': 'Apple HFS+', '7C3457EF-0000-11AA-AA11-00306543ECAC': 'Apple APFS',
  '426F6F74-0000-11AA-AA11-00306543ECAC': 'Apple boot', '516E7CB4-6ECF-11D6-8FF8-00022D09712B': 'FreeBSD data', '83BD6B9D-7F41-11DC-BE0B-001560B84F0F': 'FreeBSD boot',
  '516E7CB5-6ECF-11D6-8FF8-00022D09712B': 'FreeBSD swap', '516E7CB6-6ECF-11D6-8FF8-00022D09712B': 'FreeBSD UFS', '516E7CBA-6ECF-11D6-8FF8-00022D09712B': 'FreeBSD ZFS',
  '6A898CC3-1DD2-11B2-99A6-080020736631': 'ZFS (Solaris / Apple)', 'CA7D7CCB-63ED-4C53-861C-1742536059CC': 'LUKS encrypted', '3B8F8425-20E0-4F3B-907F-1A25A76F98E8': 'Linux /srv'
}

function chs(bytes, offset) {
  const head = bytes[offset]
  const sector = bytes[offset + 1] & 0x3F
  const cylinder = ((bytes[offset + 1] & 0xC0) << 2) | bytes[offset + 2]
  return `${cylinder}/${head}/${sector}`
}

function readMBR(r) {
  const entries = []
  for (let i = 0; i < 4; i++) {
    const at = 446 + i * 16
    entries.push({ index: i + 1, at, status: r.u8(at), type: r.u8(at + 4), start: r.u32(at + 8), sectors: r.u32(at + 12) })
  }
  return entries
}

function gptAt(r, offset) {
  return r.has(offset, 92) && r.ascii(offset, 8) === 'EFI PART'
}

function parsePartitions(bytes) {
  const r = new ByteReader(bytes, true)
  const warnings = []
  const summary = []
  const regions = []
  const fields = []
  const mbr = readMBR(r)
  const sectorSize = gptAt(r, 512) ? 512 : gptAt(r, 4096) ? 4096 : 512
  const isGpt = gptAt(r, sectorSize)
  const protective = mbr.some(entry => entry.type === 0xEE)

  const mbrChildren = [field('Boot code', 0, 440, undefined, 'Code run by the BIOS; often zero on GPT disks', 'code'),
    field('Disk signature', 440, 4, hex32(r.u32(440)), 'Identifies the disk to the operating system'),
    field('Reserved', 444, 2, undefined, 'Usually zero, 0x5A5A if copy-protected', 'padding')]
  mbr.forEach(entry => {
    const used = entry.type !== 0
    mbrChildren.push(field(`Partition ${entry.index}`, entry.at, 16, used ? `${MBR_TYPES[entry.type] || `type 0x${entry.type.toString(16)}`}, ${formatBytes(entry.sectors * 512)}` : 'unused', 'Partition table entry', 'header', [
      field('Status', entry.at, 1, entry.status === 0x80 ? 'active (bootable)' : entry.status === 0 ? 'inactive' : `invalid (0x${entry.status.toString(16)})`, '0x80 marks the boot partition', 'flags'),
      field('First sector (CHS)', entry.at + 1, 3, chs(bytes, entry.at + 1), 'Legacy cylinder/head/sector address'),
      field('Type', entry.at + 4, 1, `0x${entry.type.toString(16).toUpperCase().padStart(2, '0')} (${MBR_TYPES[entry.type] || 'unknown'})`, 'Partition type', 'flags'),
      field('Last sector (CHS)', entry.at + 5, 3, chs(bytes, entry.at + 5), 'Legacy cylinder/head/sector address'),
      pointAt(field('First sector (LBA)', entry.at + 8, 4, formatNumber(entry.start), `Byte offset ${formatNumber(entry.start * 512)}`, 'offset'), used && entry.sectors ? entry.start * 512 : null, bytes.length),
      field('Sector count', entry.at + 12, 4, formatNumber(entry.sectors), formatBytes(entry.sectors * 512), 'size')
    ]))
  })
  mbrChildren.push(field('Boot signature', 510, 2, '55 AA', 'Marks a valid boot sector', 'magic'))
  fields.push(field(protective && isGpt ? 'Protective MBR' : 'Master boot record', 0, 512, undefined, 'Sector 0', 'header', mbrChildren))
  regions.push({ name: 'MBR', offset: 0, length: 512, kind: 'header' })

  let formatName = 'MBR Partition Table'
  if (isGpt) {
    formatName = 'GPT Partition Table'
    const h = sectorSize
    const headerSize = r.u32(h + 12)
    const storedCrc = r.u32(h + 16)
    let headerCrcOk = null
    if (headerSize >= 92 && headerSize <= sectorSize && r.has(h, headerSize)) {
      const copy = bytes.slice(h, h + headerSize)
      copy.fill(0, 16, 20)
      headerCrcOk = crc32(copy) === storedCrc
    }
    const entriesLba = r.u64(h + 72)
    const count = r.u32(h + 80)
    const entrySize = r.u32(h + 84)
    const entriesCrc = r.u32(h + 88)
    const diskGuid = guid(bytes, h + 56)
    const entriesStart = entriesLba * sectorSize
    fields.push(field('GPT header', h, Math.min(sectorSize, bytes.length - h), `${formatNumber(count)} entries`, 'Primary GUID partition table header (LBA 1)', 'header', [
      field('Signature', h, 8, 'EFI PART', 'GPT signature', 'magic'),
      field('Revision', h + 8, 4, `${r.u16(h + 10)}.${r.u16(h + 8)}`, 'Header format revision'),
      field('Header size', h + 12, 4, headerSize, 'Bytes covered by the header CRC', 'size'),
      field('Header CRC32', h + 16, 4, `${hex32(storedCrc)}${headerCrcOk === null ? '' : headerCrcOk ? ' (valid)' : ' (mismatch)'}`, 'With this field zeroed', 'checksum'),
      pointAt(field('Current LBA', h + 24, 8, formatNumber(r.u64(h + 24)), 'Where this header is', 'offset'), r.u64(h + 24) * sectorSize, bytes.length),
      pointAt(field('Backup LBA', h + 32, 8, formatNumber(r.u64(h + 32)), 'Where the backup header is (last sector)', 'offset'), r.u64(h + 32) * sectorSize, bytes.length),
      field('First usable LBA', h + 40, 8, formatNumber(r.u64(h + 40)), 'Start of the space for partitions', 'offset'),
      field('Last usable LBA', h + 48, 8, formatNumber(r.u64(h + 48)), 'End of the space for partitions', 'offset'),
      field('Disk GUID', h + 56, 16, diskGuid, 'Unique disk identifier'),
      pointAt(field('Partition entries LBA', h + 72, 8, formatNumber(entriesLba), 'Start of the entry array', 'offset'), entriesStart, bytes.length),
      field('Entry count', h + 80, 4, formatNumber(count), 'Slots in the entry array', 'count'),
      field('Entry size', h + 84, 4, entrySize, 'Bytes per entry (usually 128)', 'size'),
      field('Entries CRC32', h + 88, 4, hex32(entriesCrc), 'Of the whole entry array', 'checksum')
    ]))
    regions.push({ name: 'GPT header', offset: h, length: Math.min(sectorSize, bytes.length - h), kind: 'header' })
    if (headerCrcOk === false) warnings.push('GPT header CRC32 does not match')

    const partitions = []
    const entryFields = []
    if (entrySize >= 128 && entrySize <= 4096 && count > 0 && count <= 65536) {
      const arrayLength = count * entrySize
      if (r.has(entriesStart, arrayLength)) {
        if (crc32(bytes, entriesStart, entriesStart + arrayLength) !== entriesCrc) warnings.push('GPT partition entries CRC32 does not match')
      } else {
        warnings.push('The partition entry array lies past the end of the file')
      }
      for (let i = 0; i < Math.min(count, MAX_GPT_ENTRIES); i++) {
        const at = entriesStart + i * entrySize
        if (!r.has(at, 128)) break
        const typeGuid = guid(bytes, at)
        if (/^[0-]+$/.test(typeGuid)) continue
        const first = r.u64(at + 32)
        const last = r.u64(at + 40)
        const name = printable(utf16(bytes, at + 56, 72, true).replace(/\0[\s\S]*$/, ''), 72)
        const type = GPT_TYPES[typeGuid] || typeGuid
        const size = (last - first + 1) * sectorSize
        partitions.push({ index: i + 1, type, name, first, last, size })
        entryFields.push(field(`Partition ${i + 1}`, at, entrySize, `${type}${name ? ` "${name}"` : ''}`, 'GPT partition entry', 'header', [
          field('Type GUID', at, 16, `${typeGuid}${GPT_TYPES[typeGuid] ? ` (${GPT_TYPES[typeGuid]})` : ''}`, 'Partition type'),
          field('Unique GUID', at + 16, 16, guid(bytes, at + 16), 'Identifies this partition'),
          pointAt(field('First LBA', at + 32, 8, formatNumber(first), `Byte offset ${formatNumber(first * sectorSize)}`, 'offset'), first * sectorSize, bytes.length),
          field('Last LBA', at + 40, 8, formatNumber(last), 'Inclusive', 'offset'),
          field('Attributes', at + 48, 8, `0x${r.u64big(at + 48).toString(16)}`, 'Bit 0 required, bit 2 legacy BIOS bootable', 'flags'),
          field('Name', at + 56, 72, name, 'UTF-16LE partition name', 'string')
        ]))
      }
      if (entryFields.length) {
        fields.push(field('Partition entries', entriesStart, Math.min(count * entrySize, bytes.length - entriesStart), plural(partitions.length, 'partition'), `${formatNumber(count)} slots of ${entrySize} bytes`, 'table', capFields(entryFields, 128, 'more partitions')))
        regions.push({ name: 'Partition entries', offset: entriesStart, length: Math.min(count * entrySize, bytes.length - entriesStart), kind: 'table' })
      }
    }
    summary.push(item('Scheme', 'GUID Partition Table (GPT)'))
    summary.push(item('Sector Size', `${sectorSize} bytes`))
    summary.push(item('Disk GUID', diskGuid))
    summary.push(item('Partitions', formatNumber(partitions.length)))
    partitions.slice(0, 128).forEach(p => summary.push(item(`Partition ${p.index}`, `${p.type}${p.name ? ` "${p.name}"` : ''}, ${formatBytes(p.size)}`, [`LBA ${formatNumber(p.first)}–${formatNumber(p.last)}`], 'Partitions')))
    if (!protective) warnings.push('The MBR has no GPT protective entry (hybrid or damaged)')
    if (headerCrcOk === false) summary.push(item('Header CRC', 'Mismatch'))
  } else {
    const used = mbr.filter(entry => entry.type !== 0)
    summary.push(item('Scheme', 'Master Boot Record (MBR)'))
    summary.push(item('Disk Signature', hex32(r.u32(440))))
    summary.push(item('Partitions', formatNumber(used.length)))
    used.forEach(entry => summary.push(item(`Partition ${entry.index}`, `${MBR_TYPES[entry.type] || `Type 0x${entry.type.toString(16)}`}${entry.status === 0x80 ? ', active' : ''}, ${formatBytes(entry.sectors * 512)}`, [`Sectors ${formatNumber(entry.start)}–${formatNumber(entry.start + entry.sectors - 1)}`], 'Partitions')))
    if (protective) warnings.push('The MBR has a GPT protective entry but no GPT header was found')
    if (bytes.subarray(0, 440).some(byte => byte !== 0)) summary.push(item('Boot Code', 'Present'))
  }
  const end = mbr.reduce((max, entry) => Math.max(max, (entry.start + entry.sectors) * 512), 0)
  if (!isGpt && end > bytes.length) summary.push(item('Image', `Partial (partitions extend to ${formatBytes(end)})`))
  return { formatName, summary, fields, regions, warnings }
}

// The 55 AA signature alone also marks FAT boot sectors, so the partition
// table must look sane: valid status bytes and at least one real entry.
export function looksLikeMBR(bytes) {
  if (bytes.length < 512 || bytes[510] !== 0x55 || bytes[511] !== 0xAA) return false
  const r = new ByteReader(bytes, true)
  if (gptAt(r, 512) || gptAt(r, 4096)) return true
  let used = 0
  for (const entry of readMBR(r)) {
    if (entry.status !== 0 && entry.status !== 0x80) return false
    if (entry.type === 0) continue
    if (entry.start === 0 || entry.sectors === 0) return false
    used++
  }
  return used > 0
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'partition',
  name: 'Disk Image',
  category: 'disk',
  detect: looksLikeMBR,
  parse: fitted(parsePartitions)
}
