import png from './png.js'
import jpeg from './jpeg.js'
import gif from './gif.js'
import pe from './pe.js'
import javaClass from './javaClass.js'
import macho from './macho.js'
import zip from './zip.js'
import elf from './elf.js'
import pdf from './pdf.js'

/**
 * Format modules in detection order; the first whose `detect` matches wins.
 * Java class files must come before Mach-O: both start with 0xCAFEBABE.
 * @type {import('../analysis/types.js').FormatModule[]}
 */
export const FORMATS = [png, jpeg, gif, pe, javaClass, macho, zip, elf, pdf]

/**
 * @param {Uint8Array} bytes
 * @returns {import('../analysis/types.js').FormatModule | null}
 */
export function detectFormat(bytes) {
  return FORMATS.find(format => format.detect(bytes)) || null
}
