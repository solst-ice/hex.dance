import { png, jpeg, gif, bmp, ico, tiff } from './images.js'
import { pe, cafebabe, macho, elf, wasm, dex } from './executables.js'
import { zip, zipEnd, gzip, zlib, xz, bzip2, zstd, sevenZip, rar, lzma, lz4, cab, ar, cpio, tar } from './archives.js'
import { flac, ogg, riff, isobmff, mp3, nes, gameboy, font, pcap, pcapng, bplist } from './media.js'
import { sqlite, iso9660, bootsector, ext, squashfs, cramfs, uimage, dtb, androidboot, ole, pem, der, pdf } from './system.js'

/**
 * Validator per signature id (see signatures.js).
 * @type {Record<string, (ctx: import('./common.js').CheckContext) => Promise<import('./common.js').Check|null>>}
 */
export const VALIDATORS = {
  png, jpeg, gif, pe, cafebabe, macho, zip, 'zip-end': zipEnd, elf, pdf, gzip, xz, bzip2, zstd, '7z': sevenZip, rar,
  wasm, sqlite, flac, ogg, riff, tiff, isobmff, bplist, pcap, pcapng, nes, font, bmp, ico, gameboy, iso9660, tar, mp3,
  bootsector, der, zlib, lzma, lz4, cab, ar, cpio, squashfs, cramfs, ext, uimage, dtb, androidboot, dex, ole, pem
}
