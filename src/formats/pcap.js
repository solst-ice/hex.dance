import { ByteReader, capFields, field, fitted, formatDate, formatDuration, formatNumber, plural, printable, utf8 } from './reader.js'
import { formatBytes, item } from './shared.js'

const MAX_PACKETS = 1000000
const MAX_RECORD_FIELDS = 64
const MAX_BLOCKS = 2000000

export const LINK_TYPES = {
  0: 'BSD loopback', 1: 'Ethernet', 6: 'IEEE 802.5 Token Ring', 8: 'SLIP', 9: 'PPP', 10: 'FDDI', 12: 'Raw IP (OpenBSD)', 14: 'Raw IP', 50: 'PPP in HDLC framing', 51: 'PPPoE',
  101: 'Raw IP', 104: 'Cisco HDLC', 105: 'IEEE 802.11 Wi-Fi', 108: 'OpenBSD loopback', 113: 'Linux cooked capture (SLL)', 117: 'OpenBSD pflog',
  119: '802.11 with Prism header', 127: '802.11 with radiotap header', 147: 'User 0', 187: 'Bluetooth HCI H4', 189: 'USB (Linux)', 192: 'PPI', 195: 'IEEE 802.15.4',
  201: 'Bluetooth HCI H4 with direction', 220: 'USB (Linux, memory-mapped)', 228: 'Raw IPv4', 229: 'Raw IPv6', 239: 'Netlink', 249: 'USBPcap', 252: 'Wireshark upper PDU',
  263: 'Bluetooth LE link layer', 276: 'Linux cooked capture v2 (SLL2)', 279: 'Ethernet MPLS', 288: 'Ethernet with NFLOG'
}

function linkName(type) {
  return `${LINK_TYPES[type] || 'Unknown'} (${type})`
}

const PCAP_MAGICS = { 0xA1B2C3D4: 'microseconds', 0xA1B23C4D: 'nanoseconds' }

function pcapVariant(bytes) {
  if (bytes.length < 4) return null
  const be = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  if (PCAP_MAGICS[be]) return { little: false, resolution: PCAP_MAGICS[be] }
  const le = ((bytes[3] << 24) | (bytes[2] << 16) | (bytes[1] << 8) | bytes[0]) >>> 0
  if (PCAP_MAGICS[le]) return { little: true, resolution: PCAP_MAGICS[le] }
  return null
}

function parsePcap(bytes) {
  const variant = pcapVariant(bytes)
  const r = new ByteReader(bytes, variant.little)
  const warnings = []
  const regions = []
  const summary = []
  const nano = variant.resolution === 'nanoseconds'
  const network = r.u32(20)
  const snaplen = r.u32(16)
  const fields = [field('Global header', 0, Math.min(24, bytes.length), undefined, 'pcap file header', 'header', [
    field('Magic', 0, 4, `${variant.little ? 'little' : 'big'}-endian, ${variant.resolution}`, 'Byte order and timestamp resolution', 'magic'),
    field('Version', 4, 4, `${r.u16(4)}.${r.u16(6)}`, 'File format version', 'magic'),
    field('Time zone offset', 8, 4, r.i32(8), 'Seconds from UTC (always 0 in practice)'),
    field('Timestamp accuracy', 12, 4, r.u32(12), 'Unused, 0'),
    field('Snapshot length', 16, 4, formatNumber(snaplen), 'Maximum bytes captured per packet', 'size'),
    field('Link type', 20, 4, linkName(network & 0xFFFF), 'Data link layer of every packet', 'flags')
  ])]
  if (bytes.length < 24) {
    warnings.push('File is truncated inside the global header')
    return { summary, fields, warnings }
  }
  regions.push({ name: 'Global header', offset: 0, length: 24, kind: 'header' })

  let pos = 24
  let packets = 0
  let first = null
  let last = null
  let captured = 0
  let original = 0
  let truncatedPackets = 0
  const records = []
  let hidden = 0
  while (pos + 16 <= bytes.length && packets < MAX_PACKETS) {
    const seconds = r.u32(pos)
    const fraction = r.u32(pos + 4)
    const included = r.u32(pos + 8)
    const length = r.u32(pos + 12)
    if (included > Math.max(snaplen, 262144) * 4) {
      warnings.push(`Implausible captured length ${formatNumber(included)} at offset ${pos}; stopping`)
      break
    }
    const time = seconds + fraction / (nano ? 1e9 : 1e6)
    if (first === null) first = time
    last = time
    packets++
    captured += included
    original += length
    if (included < length) truncatedPackets++
    const end = Math.min(pos + 16 + included, bytes.length)
    if (records.length < MAX_RECORD_FIELDS) {
      records.push(field(`Packet ${packets}`, pos, end - pos, `${formatNumber(included)} bytes${included < length ? ` of ${formatNumber(length)}` : ''}`, 'Record header and packet data', 'header', [
        field('Timestamp', pos, 8, formatDate(new Date(time * 1000)), `Seconds and ${nano ? 'nanoseconds' : 'microseconds'}`),
        field('Captured length', pos + 8, 4, formatNumber(included), 'Bytes saved in the file', 'size'),
        field('Original length', pos + 12, 4, formatNumber(length), 'Bytes on the wire', 'size'),
        ...(end > pos + 16 ? [field('Packet data', pos + 16, end - pos - 16, undefined, linkName(network & 0xFFFF), 'data')] : [])
      ]))
    } else {
      hidden++
    }
    if (pos + 16 + included > bytes.length) {
      warnings.push('The last packet is truncated')
      pos = bytes.length
      break
    }
    pos += 16 + included
  }
  fields.push(...capFields(records, MAX_RECORD_FIELDS, 'more packets', hidden, pos))
  if (pos > 24) regions.push({ name: 'Packets', offset: 24, length: pos - 24, kind: 'data' })
  if (packets >= MAX_PACKETS && pos < bytes.length) warnings.push(`Counted the first ${formatNumber(MAX_PACKETS)} packets only`)
  else if (pos < bytes.length) warnings.push(`${plural(bytes.length - pos, 'byte')} too short for a packet record at the end`)

  summary.push(item('Format', `pcap ${r.u16(4)}.${r.u16(6)} (${variant.little ? 'little' : 'big'}-endian)`))
  summary.push(item('Link Type', linkName(network & 0xFFFF)))
  summary.push(item('Timestamp Resolution', nano ? 'Nanoseconds' : 'Microseconds'))
  summary.push(item('Snapshot Length', `${formatNumber(snaplen)} bytes`))
  addCaptureSummary(summary, { packets, capped: packets >= MAX_PACKETS, first, last, captured, original, truncatedPackets })
  return { formatName: 'pcap Packet Capture', summary, fields, regions, warnings }
}

function addCaptureSummary(summary, { packets, capped, first, last, captured, original, truncatedPackets }) {
  summary.push(item('Packets', capped ? `${formatNumber(packets)}+` : formatNumber(packets)))
  if (first !== null) {
    summary.push(item('First Packet', formatDate(new Date(first * 1000))))
    summary.push(item('Last Packet', formatDate(new Date(last * 1000))))
    summary.push(item('Capture Duration', formatDuration(Math.max(0, last - first))))
  }
  summary.push(item('Captured Data', `${formatBytes(captured)} (${formatBytes(original)} on the wire)`))
  if (truncatedPackets) summary.push(item('Truncated Packets', `${formatNumber(truncatedPackets)} (cut at the snapshot length)`))
}

const BLOCK_NAMES = { 0x0A0D0D0A: 'Section header', 1: 'Interface description', 2: 'Packet (obsolete)', 3: 'Simple packet', 4: 'Name resolution', 5: 'Interface statistics', 6: 'Enhanced packet', 0x0BAD: 'Custom', 0x40000BAD: 'Custom', 10: 'Decryption secrets', 9: 'systemd journal export' }

function readOptions(r, start, end, names) {
  const out = {}
  let pos = start
  let guard = 0
  while (pos + 4 <= end && guard++ < 64) {
    const code = r.u16(pos)
    const length = r.u16(pos + 2)
    if (code === 0) break
    if (names[code] && pos + 4 + length <= end) out[names[code]] = { pos: pos + 4, length }
    pos += 4 + Math.ceil(length / 4) * 4
  }
  return out
}

function parsePcapng(bytes) {
  let little = bytes[8] === 0x4D
  let r = new ByteReader(bytes, little)
  const warnings = []
  const regions = []
  const summary = []
  const blockFields = []
  const interfaces = []
  const sections = []
  let pos = 0
  let blocks = 0
  let packets = 0
  let first = null
  let last = null
  let captured = 0
  let original = 0
  let truncatedPackets = 0
  let hidden = 0
  const counts = {}
  while (pos + 12 <= bytes.length && blocks < MAX_BLOCKS) {
    let type = r.u32(pos)
    if (type === 0x0A0D0D0A) {
      little = bytes[pos + 8] === 0x4D
      r = new ByteReader(bytes, little)
      interfaces.length = 0
      type = 0x0A0D0D0A
    }
    const length = r.u32(pos + 4)
    if (length < 12 || length % 4 !== 0) {
      warnings.push(`Invalid block length ${length} at offset ${pos}`)
      break
    }
    const end = pos + length
    const truncated = end > bytes.length
    const bodyEnd = Math.min(end - 4, bytes.length)
    blocks++
    counts[type] = (counts[type] || 0) + 1
    const name = BLOCK_NAMES[type] || `Block type 0x${type.toString(16)}`
    const children = [field('Block type', pos, 4, name, 'pcapng block type', 'magic'), field('Block length', pos + 4, 4, formatNumber(length), 'Including header and trailer', 'size')]
    let value
    if (type === 0x0A0D0D0A && pos + 24 <= bytes.length) {
      const options = readOptions(r, pos + 24, bodyEnd, { 2: 'hardware', 3: 'os', 4: 'application' })
      const text = key => (options[key] ? printable(utf8(bytes, options[key].pos, options[key].length), 120) : null)
      const section = { version: `${r.u16(pos + 12)}.${r.u16(pos + 14)}`, little, hardware: text('hardware'), os: text('os'), application: text('application') }
      sections.push(section)
      value = `version ${section.version}, ${little ? 'little' : 'big'}-endian`
      children.push(field('Byte-order magic', pos + 8, 4, little ? '4D 3C 2B 1A (little-endian)' : '1A 2B 3C 4D (big-endian)', 'Byte order of this section', 'magic'),
        field('Version', pos + 12, 4, section.version, 'Format version'), field('Section length', pos + 16, 8, r.u32(pos + 16) === 0xFFFFFFFF ? 'unspecified' : formatNumber(r.u64(pos + 16)), 'Bytes in this section', 'size'))
    } else if (type === 1 && pos + 16 <= bytes.length) {
      const options = readOptions(r, pos + 16, bodyEnd, { 2: 'name', 3: 'description', 9: 'tsresol' })
      let resolution = 1e-6
      if (options.tsresol) {
        const v = bytes[options.tsresol.pos]
        resolution = v & 0x80 ? 2 ** -(v & 0x7F) : 10 ** -(v & 0x7F)
      }
      const link = r.u16(pos + 8)
      const name = options.name ? printable(utf8(bytes, options.name.pos, options.name.length), 80) : null
      interfaces.push({ link, resolution, name })
      value = `${linkName(link)}${name ? `, ${name}` : ''}`
      children.push(field('Link type', pos + 8, 2, linkName(link), 'Data link layer', 'flags'), field('Snapshot length', pos + 12, 4, formatNumber(r.u32(pos + 12)), 'Maximum bytes per packet', 'size'))
    } else if ((type === 6 || type === 2) && pos + 28 <= bytes.length) {
      const iface = interfaces[type === 6 ? r.u32(pos + 8) : r.u16(pos + 8)] || { resolution: 1e-6 }
      const stamp = r.u32(pos + 12) * 0x100000000 + r.u32(pos + 16)
      const time = stamp * iface.resolution
      const included = r.u32(pos + 20)
      const lengthOnWire = r.u32(pos + 24)
      packets++
      captured += included
      original += lengthOnWire
      if (included < lengthOnWire) truncatedPackets++
      if (first === null) first = time
      last = time
      value = `${formatNumber(included)} bytes, ${formatDate(new Date(time * 1000))}`
      children.push(field('Interface ID', pos + 8, 4, r.u32(pos + 8), 'Index of the interface description block'),
        field('Timestamp', pos + 12, 8, formatDate(new Date(time * 1000)), 'High and low 32 bits, in the interface resolution'),
        field('Captured length', pos + 20, 4, formatNumber(included), 'Bytes saved', 'size'), field('Original length', pos + 24, 4, formatNumber(lengthOnWire), 'Bytes on the wire', 'size'))
      if (pos + 28 + included <= bodyEnd) children.push(field('Packet data', pos + 28, included, undefined, 'Captured bytes', 'data'))
    } else if (type === 3 && pos + 12 <= bytes.length) {
      packets++
      const lengthOnWire = r.u32(pos + 8)
      original += lengthOnWire
      captured += Math.min(lengthOnWire, length - 16)
    }
    if (!truncated) children.push(field('Block length (trailer)', end - 4, 4, formatNumber(r.u32(end - 4)), 'Repeats the length so the file can be read backwards', 'size'))
    if (!truncated && r.u32(end - 4) !== length) warnings.push(`Block at offset ${pos} has mismatched lengths`)
    if (blockFields.length < MAX_RECORD_FIELDS) blockFields.push(field(name, pos, Math.min(end, bytes.length) - pos, value, `pcapng block (type 0x${type.toString(16)})`, 'header', children))
    else hidden++
    if (truncated) {
      warnings.push(`Block at offset ${pos} is truncated`)
      pos = bytes.length
      break
    }
    pos = end
  }
  if (blocks >= MAX_BLOCKS && pos < bytes.length) warnings.push(`Stopped after ${formatNumber(MAX_BLOCKS)} blocks`)
  else if (pos < bytes.length) warnings.push(`${plural(bytes.length - pos, 'byte')} too short for a block at the end`)
  const fields = capFields(blockFields, MAX_RECORD_FIELDS, 'more blocks', hidden, pos)
  regions.push({ name: 'Blocks', offset: 0, length: Math.min(pos, bytes.length), kind: 'data' })

  const section = sections[0] || {}
  summary.push(item('Format', `pcapng ${section.version || ''} (${section.little === false ? 'big' : 'little'}-endian)`.replace('  ', ' ')))
  if (sections.length > 1) summary.push(item('Sections', formatNumber(sections.length)))
  if (section.application) summary.push(item('Captured With', section.application))
  if (section.os) summary.push(item('Operating System', section.os))
  if (section.hardware) summary.push(item('Hardware', section.hardware))
  interfaces.slice(0, 16).forEach((iface, index) => summary.push(item(`Interface ${index}`, `${linkName(iface.link)}${iface.name ? `, ${iface.name}` : ''}`, null, 'Interfaces')))
  addCaptureSummary(summary, { packets, capped: false, first, last, captured, original, truncatedPackets })
  const other = Object.entries(counts).filter(([type]) => ![0x0A0D0D0A, 1, 6, 3, 2].includes(Number(type)))
  if (other.length) summary.push(item('Other Blocks', other.map(([type, count]) => `${BLOCK_NAMES[type] || `0x${Number(type).toString(16)}`}: ${count}`).join(', ')))
  return { formatName: 'pcapng Packet Capture', summary, fields, regions, warnings }
}

function isPcap(bytes) {
  const variant = bytes.length >= 24 ? pcapVariant(bytes) : null
  if (!variant) return false
  const major = variant.little ? bytes[4] | (bytes[5] << 8) : (bytes[4] << 8) | bytes[5]
  return major === 2
}

function isPcapng(bytes) {
  return bytes.length >= 12 && bytes[0] === 0x0A && bytes[1] === 0x0D && bytes[2] === 0x0D && bytes[3] === 0x0A &&
    ((bytes[8] === 0x4D && bytes[9] === 0x3C && bytes[10] === 0x2B && bytes[11] === 0x1A) || (bytes[8] === 0x1A && bytes[9] === 0x2B && bytes[10] === 0x3C && bytes[11] === 0x4D))
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'pcap',
  name: 'Packet Capture',
  category: 'data',
  detect: bytes => isPcapng(bytes) || isPcap(bytes),
  parse: fitted(bytes => (isPcapng(bytes) ? parsePcapng(bytes) : parsePcap(bytes)))
}
