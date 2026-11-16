import png from './png.js'
import jpeg from './jpeg.js'
import gif from './gif.js'
import pe from './pe.js'
import javaClass from './javaClass.js'
import macho from './macho.js'
import zip from './zip.js'
import elf from './elf.js'
import pdf from './pdf.js'
import gzip from './gzip.js'
import xz from './xz.js'
import bzip2 from './bzip2.js'
import zstd from './zstd.js'
import sevenZip from './sevenZip.js'
import rar from './rar.js'
import wasm from './wasm.js'
import sqlite from './sqlite.js'
import flac from './flac.js'
import ogg from './ogg.js'
import webp from './webp.js'
import wav from './wav.js'
import avi from './avi.js'
import riff from './riff.js'
import tiff from './tiff.js'
import heif from './heif.js'
import isobmff from './isobmff.js'
import bplist from './bplist.js'
import pcap from './pcap.js'
import nes from './nes.js'
import font from './font.js'
import bmp from './bmp.js'
import ico from './ico.js'
import gameboy from './gameboy.js'
import iso9660 from './iso9660.js'
import tar from './tar.js'
import mp3 from './mp3.js'
import partition from './partition.js'
import der from './der.js'
import text from './text.js'

/**
 * Format modules in detection order; the first whose `detect` matches wins.
 *
 * - Formats with a strong signature at offset 0 come first. Java class files
 *   must come before Mach-O: both start with 0xCAFEBABE. FLAC comes before
 *   MP3 because some taggers put an ID3 tag in front of FLAC streams. The
 *   specific RIFF and ISO media forms come before their generic walkers.
 * - Then formats whose signature is weak or not at offset 0 and is backed by
 *   a structural check: ICO (first directory entry), Game Boy (logo at
 *   0x104), ISO 9660 (sector 16, before MBR so hybrid images stay ISOs), tar
 *   (header checksum), MP3 without a tag (consecutive frame headers), MBR
 *   (sane partition entries) and DER (a SEQUENCE spanning the whole file).
 * - Plain text is last: it only claims what nothing else recognised.
 * @type {import('../analysis/types.js').FormatModule[]}
 */
export const FORMATS = [
  png, jpeg, gif, pe, javaClass, macho, zip, elf, pdf,
  gzip, xz, bzip2, zstd, sevenZip, rar, wasm, sqlite, flac, ogg, webp, wav, avi, riff, tiff, heif, isobmff, bplist, pcap, nes, font, bmp,
  ico, gameboy, iso9660, tar, mp3, partition, der,
  text
]

/**
 * @param {Uint8Array} bytes
 * @returns {import('../analysis/types.js').FormatModule | null}
 */
export function detectFormat(bytes) {
  return FORMATS.find(format => format.detect(bytes)) || null
}
