// The signature table for the prefilter. Each family lists the byte strings
// that can mark its start (`at` is where the key sits relative to the start
// of the embedded file) and, where the app has a parser, the id of its
// format module. Whether a match is real is decided by the family's
// validator in validate/.

/**
 * @typedef {Object} SignatureKey
 * @property {string} bytes   latin-1 string
 * @property {number} [at]    offset of the key from the start of the file it marks
 *
 * @typedef {Object} Signature
 * @property {string} id
 * @property {string} name     display name
 * @property {string} ext      file name extension for extracted bytes
 * @property {SignatureKey[]} keys
 * @property {boolean} [marker]  only records positions (used to resolve other families' extents)
 */

/** @type {Signature[]} */
export const SIGNATURES = [
  // Formats the app parses
  { id: 'png', name: 'PNG image', ext: 'png', keys: [{ bytes: '\x89PNG\r\n\x1a\n' }] },
  { id: 'jpeg', name: 'JPEG image', ext: 'jpg', keys: [{ bytes: '\xFF\xD8\xFF' }] },
  { id: 'gif', name: 'GIF image', ext: 'gif', keys: [{ bytes: 'GIF87a' }, { bytes: 'GIF89a' }] },
  { id: 'pe', name: 'Windows PE executable', ext: 'exe', keys: [{ bytes: 'MZ' }] },
  { id: 'cafebabe', name: 'Java class or Mach-O universal binary', ext: 'bin', keys: [{ bytes: '\xCA\xFE\xBA\xBE' }] },
  { id: 'macho', name: 'Mach-O binary', ext: 'macho', keys: [{ bytes: '\xFE\xED\xFA\xCE' }, { bytes: '\xFE\xED\xFA\xCF' }, { bytes: '\xCE\xFA\xED\xFE' }, { bytes: '\xCF\xFA\xED\xFE' }] },
  { id: 'zip', name: 'ZIP archive', ext: 'zip', keys: [{ bytes: 'PK\x03\x04' }] },
  { id: 'zip-end', name: 'ZIP end record', ext: 'zip', keys: [{ bytes: 'PK\x05\x06' }] },
  { id: 'elf', name: 'ELF executable', ext: 'elf', keys: [{ bytes: '\x7FELF' }] },
  { id: 'pdf', name: 'PDF document', ext: 'pdf', keys: [{ bytes: '%PDF-' }] },
  { id: 'pdf-eof', name: 'PDF end marker', ext: '', marker: true, keys: [{ bytes: '%%EOF' }] },
  { id: 'gzip', name: 'gzip data', ext: 'gz', keys: [{ bytes: '\x1F\x8B\x08' }] },
  { id: 'xz', name: 'xz data', ext: 'xz', keys: [{ bytes: '\xFD7zXZ\x00' }] },
  { id: 'bzip2', name: 'bzip2 data', ext: 'bz2', keys: [{ bytes: 'BZh' }] },
  { id: 'zstd', name: 'Zstandard data', ext: 'zst', keys: [{ bytes: '\x28\xB5\x2F\xFD' }] },
  { id: '7z', name: '7z archive', ext: '7z', keys: [{ bytes: '7z\xBC\xAF\x27\x1C' }] },
  { id: 'rar', name: 'RAR archive', ext: 'rar', keys: [{ bytes: 'Rar!\x1A\x07' }] },
  { id: 'wasm', name: 'WebAssembly module', ext: 'wasm', keys: [{ bytes: '\x00asm' }] },
  { id: 'sqlite', name: 'SQLite database', ext: 'sqlite', keys: [{ bytes: 'SQLite format 3\x00' }] },
  { id: 'flac', name: 'FLAC audio', ext: 'flac', keys: [{ bytes: 'fLaC' }] },
  { id: 'ogg', name: 'Ogg stream', ext: 'ogg', keys: [{ bytes: 'OggS\x00' }] },
  { id: 'riff', name: 'RIFF container', ext: 'riff', keys: [{ bytes: 'RIFF' }] },
  { id: 'tiff', name: 'TIFF image', ext: 'tif', keys: [{ bytes: 'II*\x00' }, { bytes: 'MM\x00*' }] },
  { id: 'isobmff', name: 'ISO media file', ext: 'mp4', keys: [{ bytes: 'ftyp', at: 4 }] },
  { id: 'bplist', name: 'Binary property list', ext: 'plist', keys: [{ bytes: 'bplist0' }] },
  { id: 'pcap', name: 'Packet capture', ext: 'pcap', keys: [{ bytes: '\xD4\xC3\xB2\xA1' }, { bytes: '\xA1\xB2\xC3\xD4' }, { bytes: '\x4D\x3C\xB2\xA1' }, { bytes: '\xA1\xB2\x3C\x4D' }] },
  { id: 'pcapng', name: 'Packet capture (pcapng)', ext: 'pcapng', keys: [{ bytes: '\x0A\x0D\x0D\x0A' }] },
  { id: 'nes', name: 'NES ROM', ext: 'nes', keys: [{ bytes: 'NES\x1A' }] },
  { id: 'font', name: 'Font', ext: 'ttf', keys: [{ bytes: '\x00\x01\x00\x00' }, { bytes: 'OTTO' }, { bytes: 'true' }, { bytes: 'wOFF' }, { bytes: 'wOF2' }] },
  { id: 'bmp', name: 'BMP image', ext: 'bmp', keys: [{ bytes: 'BM' }] },
  { id: 'ico', name: 'Windows icon', ext: 'ico', keys: [{ bytes: '\x00\x00\x01\x00' }, { bytes: '\x00\x00\x02\x00' }] },
  { id: 'gameboy', name: 'Game Boy ROM', ext: 'gb', keys: [{ bytes: '\xCE\xED\x66\x66\xCC\x0D\x00\x0B', at: 0x104 }] },
  { id: 'iso9660', name: 'ISO 9660 disc image', ext: 'iso', keys: [{ bytes: '\x01CD001\x01', at: 0x8000 }] },
  { id: 'tar', name: 'tar archive', ext: 'tar', keys: [{ bytes: 'ustar', at: 257 }] },
  { id: 'mp3', name: 'MP3 audio', ext: 'mp3', keys: [{ bytes: 'ID3' }] },
  { id: 'bootsector', name: 'Boot sector', ext: 'img', keys: [{ bytes: '\x55\xAA', at: 510 }] },
  { id: 'der', name: 'DER certificate or key', ext: 'der', keys: [{ bytes: '\x30\x82' }] },
  // Common formats the app does not parse
  { id: 'zlib', name: 'zlib stream', ext: 'zlib', keys: [{ bytes: '\x78\x01' }, { bytes: '\x78\x5E' }, { bytes: '\x78\x9C' }, { bytes: '\x78\xDA' }] },
  { id: 'lzma', name: 'LZMA data', ext: 'lzma', keys: [{ bytes: '\x5D\x00\x00' }] },
  { id: 'lz4', name: 'LZ4 frame', ext: 'lz4', keys: [{ bytes: '\x04\x22\x4D\x18' }] },
  { id: 'cab', name: 'Microsoft cabinet', ext: 'cab', keys: [{ bytes: 'MSCF\x00\x00\x00\x00' }] },
  { id: 'ar', name: 'ar archive', ext: 'a', keys: [{ bytes: '!<arch>\n' }] },
  { id: 'cpio', name: 'cpio archive', ext: 'cpio', keys: [{ bytes: '070701' }, { bytes: '070702' }, { bytes: '070707' }] },
  { id: 'squashfs', name: 'SquashFS image', ext: 'squashfs', keys: [{ bytes: 'hsqs' }, { bytes: 'sqsh' }] },
  { id: 'cramfs', name: 'cramfs image', ext: 'cramfs', keys: [{ bytes: '\x45\x3D\xCD\x28' }] },
  { id: 'ext', name: 'ext2/3/4 file system', ext: 'img', keys: [{ bytes: '\x53\xEF', at: 0x438 }] },
  { id: 'uimage', name: 'U-Boot image', ext: 'uimg', keys: [{ bytes: '\x27\x05\x19\x56' }] },
  { id: 'dtb', name: 'Device tree blob', ext: 'dtb', keys: [{ bytes: '\xD0\x0D\xFE\xED' }] },
  { id: 'androidboot', name: 'Android boot image', ext: 'img', keys: [{ bytes: 'ANDROID!' }] },
  { id: 'dex', name: 'Android DEX', ext: 'dex', keys: [{ bytes: 'dex\n0' }] },
  { id: 'ole', name: 'OLE compound file', ext: 'ole', keys: [{ bytes: '\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1' }] },
  { id: 'pem', name: 'PEM block', ext: 'pem', keys: [{ bytes: '-----BEGIN ' }] }
]

export const SIGNATURE_BY_ID = new Map(SIGNATURES.map(s => [s.id, s]))

/** Longest distance a key reaches past its match position, for the scan's lookahead. */
export const MAX_KEY_LENGTH = Math.max(...SIGNATURES.flatMap(s => s.keys.map(k => k.bytes.length)))
