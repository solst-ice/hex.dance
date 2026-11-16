// Explainers for each file format: what it is, where it came from, how a
// reader walks it and what trips people up. Plain data, no markup.

/**
 * @typedef {Object} FormatCard
 * @property {string} title
 * @property {string} tagline        one sentence: what the format is
 * @property {string} [origin]       who made it and when
 * @property {string} walkTitle      heading for `walk`
 * @property {string[]} walk         how a reader walks the file, in order
 * @property {string} gotchasTitle
 * @property {string[]} gotchas
 * @property {{ title: string, text: string }} [story]
 * @property {{ label: string, url: string }} [spec]
 */

const CAFEBABE_STORY = {
  title: 'CAFEBABE, twice',
  text: 'James Gosling has said that the Java team used to eat at a place they nicknamed Cafe Dead, so CAFEDEAD became the magic of an object format and CAFEBABE the magic of class files. Mach-O universal ("fat") binaries, which date back to NeXT, start with the same four bytes. A reader has to look at the next four: in a class file they hold the version, with a major version of 45 or more; in a fat binary they hold the number of architectures, which is small. hex.dance makes exactly this check.'
}

/** @type {Record<string, FormatCard>} */
export const FORMAT_CARDS = {
  png: {
    title: 'PNG',
    tagline: 'A lossless image format: an 8-byte signature followed by a sequence of self-describing chunks.',
    origin: 'Designed in 1995 by an open group of developers as a patent-free replacement for GIF, after Unisys began enforcing its patent on GIF\'s LZW compression. PNG became a W3C Recommendation in 1996 and later the international standard ISO/IEC 15948.',
    walkTitle: 'How a reader walks it',
    walk: [
      'Check the 8-byte signature.',
      'Read chunks one after another: a 4-byte big-endian length, a 4-byte type, the data, then a CRC-32 of the type and data.',
      'IHDR always comes first and gives the width, height, bit depth and colour type.',
      'Join the data of all IDAT chunks into one zlib stream, inflate it and undo the filter at the start of each scanline.',
      'Stop at IEND.'
    ],
    gotchasTitle: 'Gotchas',
    gotchas: [
      'The length counts only the data, not the type or the CRC.',
      'The case of each letter in a chunk type is a flag: a lower-case first letter means ancillary (a decoder may skip it), a lower-case second letter means private, and a lower-case fourth letter means safe to copy when an editor changes the image.',
      'IDAT data can be split between chunks at any byte; chunks do not line up with scanlines.',
      'Decoders ignore anything after IEND, which is one way data gets appended to images.',
      'Animated PNG (APNG) adds acTL, fcTL and fdAT chunks; decoders that do not know them show the default image.'
    ],
    spec: { label: 'W3C PNG specification', url: 'https://www.w3.org/TR/png/' }
  },

  jpeg: {
    title: 'JPEG',
    tagline: 'A lossy photo format: a stream of marker segments around entropy-coded image data.',
    origin: 'The compression method comes from the Joint Photographic Experts Group and was approved as ITU-T Recommendation T.81 in 1992, also published as ISO/IEC 10918-1. The file layout most images use on top of it is JFIF, written by Eric Hamilton at C-Cube Microsystems, or Exif, the camera industry\'s format.',
    walkTitle: 'How a reader walks it',
    walk: [
      'Expect FF D8, the start-of-image marker.',
      'Read markers: an FF byte and a code. Most are followed by a 2-byte big-endian length that counts itself but not the marker.',
      'Collect the quantization (DQT) and Huffman (DHT) tables, then the frame header (SOFn) with the size and colour components.',
      'After SOS, read entropy-coded data up to the next marker that is not a stuffed FF 00 or a restart marker (FF D0 to FF D7).',
      'Progressive files repeat SOS with more data; FF D9 ends the image.'
    ],
    gotchasTitle: 'Gotchas',
    gotchas: [
      'C4 (DHT), C8 and CC (DAC) sit among the SOF codes but are not frame headers.',
      'An Exif thumbnail is a complete JPEG with its own FF D8 and FF D9, so the first FF D9 in a file is not necessarily the end of the image.',
      'Any number of FF fill bytes may come before a marker.',
      'Metadata lives in APPn segments, told apart by an identifier string such as "JFIF", "Exif" or "ICC_PROFILE".',
      'Decoders ignore bytes after FF D9; phones and editors sometimes store extra images or video there.'
    ],
    spec: { label: 'ITU-T T.81 (JPEG)', url: 'https://www.w3.org/Graphics/JPEG/itu-t81.pdf' }
  },

  gif: {
    title: 'GIF',
    tagline: 'A palette-based image format with LZW compression and simple animation.',
    origin: 'Introduced by CompuServe in 1987 as GIF87a. GIF89a, from 1989, added extensions for transparency, frame delays and comments. Unisys\'s patent on LZW made GIF controversial in the 1990s; it expired in 2003 in the United States and in 2004 elsewhere.',
    walkTitle: 'How a reader walks it',
    walk: [
      'A 6-byte header: "GIF87a" or "GIF89a".',
      'The logical screen descriptor: canvas size, and whether a global colour table follows.',
      'Then blocks, each starting with an introducer byte: 0x2C for an image, 0x21 for an extension, 0x3B for the trailer that ends the file.',
      'Image and extension data is split into sub-blocks of at most 255 bytes, each preceded by its length; a zero length ends the run.'
    ],
    gotchasTitle: 'Gotchas',
    gotchas: [
      'Integers are little-endian, unlike PNG and JPEG.',
      'A colour table has 2^(N+1) entries, where N is the 3-bit size field.',
      'Looping is not part of GIF89a itself: it comes from the NETSCAPE2.0 application extension.',
      'Frame delays are in hundredths of a second, and browsers raise very short delays to a longer minimum.'
    ],
    spec: { label: 'GIF89a specification', url: 'https://www.w3.org/Graphics/GIF/spec-gif89a.txt' }
  },

  zip: {
    title: 'ZIP',
    tagline: 'An archive that stores each file separately, with a central directory at the end that lists them all.',
    origin: 'Created by Phil Katz of PKWARE in 1989 for PKZIP. PKWARE still publishes the specification as APPNOTE.TXT, and the "PK" in every signature is his initials.',
    walkTitle: 'How a reader walks it',
    walk: [
      'A ZIP is read from the end: search backwards for the end of central directory record (PK 05 06).',
      'It gives the number of entries and the offset of the central directory.',
      'Each central directory entry gives a file\'s name, sizes, CRC and the offset of its local header.',
      'Jump to each local header (PK 03 04), skip its name and extra field, and read the compressed data that follows.',
      'Archives over 4 GB or with more than 65,535 entries use ZIP64 records, found through a locator just before the end record.'
    ],
    gotchasTitle: 'Gotchas',
    gotchas: [
      'The end record ends with a comment of up to 65,535 bytes, so it is not at a fixed distance from the end of the file.',
      'With flag bit 3 set, the local header holds zero sizes and the real values follow the data in a data descriptor.',
      'The central directory is authoritative. Local headers may disagree with it, and bytes that no entry points to can hide between entries.',
      'Because readers start from the end, data can be put in front of an archive, as in self-extracting archives.',
      'File names are code page 437 unless flag bit 11 marks them as UTF-8. Timestamps are MS-DOS local time with 2-second resolution and no time zone.',
      'Many formats are ZIP archives inside: DOCX, XLSX and PPTX, JAR and WAR, APK, IPA, EPUB, OpenDocument, Python wheels, NuGet packages and browser extensions.'
    ],
    spec: { label: 'PKWARE APPNOTE.TXT', url: 'https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT' }
  },

  pdf: {
    title: 'PDF',
    tagline: 'A page-description format: numbered objects plus a cross-reference table that says where each one starts.',
    origin: 'Created by Adobe; PDF 1.0 was released in 1993. It became an open standard as ISO 32000-1 (PDF 1.7) in 2008, and PDF 2.0 followed as ISO 32000-2 in 2017.',
    walkTitle: 'How a reader walks it',
    walk: [
      'Check the %PDF-x.y header.',
      'Like a ZIP, a PDF is read from the end: startxref, just before %%EOF, gives the byte offset of the cross-reference section.',
      'The cross-reference table gives the byte offset of every object. The trailer after it names the document catalog (/Root).',
      'From the catalog, follow references such as "2 0 R" to the page tree and to each page\'s content stream.',
      'Incremental updates append new objects, another cross-reference section and a trailer whose /Prev points to the previous one.'
    ],
    gotchasTitle: 'Gotchas',
    gotchas: [
      'Each entry of a classic cross-reference table is exactly 20 bytes, and offsets must be exact: editing a PDF as text breaks them.',
      'Since PDF 1.5 the cross-reference can be a compressed stream, and objects can sit inside object streams, so many objects are not visible as text.',
      'A comment of bytes above 127 on the second line tells transfer tools to treat the file as binary.',
      'A stream\'s /Length can be an indirect reference, so a reader may need the cross-reference table just to find where a stream ends.'
    ],
    spec: { label: 'ISO 32000-1 (PDF 1.7), from Adobe', url: 'https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf' }
  },

  'java-class': {
    title: 'Java class file',
    tagline: 'The compiled form of one Java class or interface: bytecode and metadata for the Java Virtual Machine.',
    origin: 'Defined by Sun Microsystems for the first Java release in 1996. The format is specified in chapter 4 of the Java Virtual Machine Specification, now maintained by Oracle.',
    walkTitle: 'How a reader walks it',
    walk: [
      'The magic 0xCAFEBABE, then the minor and major version. Every number is big-endian.',
      'The constant pool: constant_pool_count − 1 entries for names, type descriptors, strings and numbers, each starting with a tag byte.',
      'Access flags, then this class, its superclass and its interfaces, all as indexes into the constant pool.',
      'Fields and methods, each with access flags, a name, a type descriptor and attributes; a method\'s bytecode is in its Code attribute.',
      'Class attributes such as SourceFile end the file.'
    ],
    gotchasTitle: 'Gotchas',
    gotchas: [
      'Constant pool indexes start at 1, and Long and Double constants take two slots, so the index after one is skipped.',
      'Strings are "modified UTF-8": the NUL character takes two bytes and characters outside the Basic Multilingual Plane are stored as surrogate pairs.',
      'From Java 5 on, the major version is the Java release plus 44: Java 8 is 52, Java 21 is 65.',
      'A minor version of 65535 marks a class compiled with preview features.'
    ],
    story: CAFEBABE_STORY,
    spec: { label: 'JVM Specification, chapter 4', url: 'https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html' }
  },

  elf: {
    title: 'ELF',
    tagline: 'The Executable and Linkable Format: executables, object files and shared libraries on Linux, the BSDs and many other systems.',
    origin: 'Introduced with Unix System V Release 4 as part of the System V ABI, and later published in the Tool Interface Standard. Linux moved to ELF from the older a.out format in the mid-1990s.',
    walkTitle: 'How a reader walks it',
    walk: [
      'The ELF header at offset 0: 7F "ELF", 32- or 64-bit class, byte order, then the file type, machine and entry point.',
      'e_phoff points to the program headers: the segments the loader maps into memory, which is what runs.',
      'e_shoff points to the section headers: .text, .data, .symtab and so on, which is what linkers and debuggers use. e_shstrndx says which section holds their names.',
      'Symbols are found through sections such as .symtab with .strtab, and .dynsym with .dynstr.'
    ],
    gotchasTitle: 'Gotchas',
    gotchas: [
      'Sections are optional at run time: stripping removes the symbol table, and a program can run with no section headers at all.',
      'Every multi-byte field follows the byte order given in the header, so one parser must handle little- and big-endian files.',
      'Segments and sections are two views of the same bytes, so they overlap.'
    ],
    spec: { label: 'System V ABI: ELF', url: 'https://refspecs.linuxfoundation.org/elf/gabi4+/contents.html' }
  },

  pe: {
    title: 'PE (Portable Executable)',
    tagline: 'The Windows format for programs (.exe), libraries (.dll) and drivers.',
    origin: 'Microsoft introduced it with Windows NT 3.1 in 1993, building on the Unix COFF format. Every PE file still begins with a small MS-DOS program; its "MZ" signature is usually explained as the initials of MS-DOS developer Mark Zbikowski.',
    walkTitle: 'How a reader walks it',
    walk: [
      'Offset 0: the DOS header, starting with "MZ". Its field e_lfanew, at offset 0x3C, gives the position of the PE header.',
      'In between sits the DOS stub, a tiny program that prints "This program cannot be run in DOS mode."',
      'At e_lfanew: the signature "PE" followed by two zero bytes, then the COFF file header with the machine type, number of sections and flags.',
      'The optional header, required for executables: PE32 (0x10B) or PE32+ (0x20B), entry point, image base, and data directories for exports, imports, resources, relocations and more.',
      'Then the section table, which maps each section\'s position in the file to its address in memory.'
    ],
    gotchasTitle: 'Gotchas',
    gotchas: [
      'Data directories hold RVAs, addresses relative to where the image is loaded, not file offsets: convert them through the section table.',
      'Sections are aligned differently in memory and on disk.',
      'The certificate table (Authenticode signature) is the exception: its directory entry holds a file offset.',
      '.NET assemblies are PE files too; their metadata is reached through the CLR runtime header directory.'
    ],
    spec: { label: 'Microsoft PE format', url: 'https://learn.microsoft.com/en-us/windows/win32/debug/pe-format' }
  },

  macho: {
    title: 'Mach-O',
    tagline: 'The executable and library format of macOS, iOS and Apple\'s other systems.',
    origin: 'It comes from the Mach kernel developed at Carnegie Mellon University, by way of NeXTSTEP, which Apple acquired in 1997 and turned into Mac OS X.',
    walkTitle: 'How a reader walks it',
    walk: [
      'The magic: FEEDFACE for 32-bit or FEEDFACF for 64-bit files. On Intel and ARM it is stored little-endian, so the file starts CE FA ED FE or CF FA ED FE.',
      'The header gives the CPU type, the file type, and the number and total size of the load commands.',
      'Load commands follow: segments with their sections (LC_SEGMENT_64), the symbol table (LC_SYMTAB), linked libraries (LC_LOAD_DYLIB), the entry point (LC_MAIN), the code signature and more.',
      'A universal ("fat") binary starts with CAFEBABE and a list of architectures, each pointing to a complete Mach-O file inside it.'
    ],
    gotchasTitle: 'Gotchas',
    gotchas: [
      'The fat header is always big-endian; the Mach-O files inside use their own CPU\'s byte order.',
      'Each load command starts with its type and size, so a reader can skip commands it does not know.',
      'CAFEBABE is also the magic of Java class files; see the story below.'
    ],
    story: CAFEBABE_STORY,
    spec: { label: 'mach-o/loader.h', url: 'https://github.com/apple-oss-distributions/xnu/blob/main/EXTERNAL_HEADERS/mach-o/loader.h' }
  }
}

const HEX_DUMP_WALK = [
  'Each row starts with the offset of its first byte, in hexadecimal.',
  'Each byte appears as two hex digits, 00 to FF; the column on the right shows the same bytes as text, with a dot for bytes that are not printable.',
  'Numbers wider than a byte are stored either little-endian, lowest byte first as on x86 and ARM, or big-endian, as in network protocols and many file formats: 01 00 00 00 is 1 read little-endian and 16,777,216 read big-endian.',
  'Readable text such as names, version strings and paths often tells you what wrote the file.'
]

/** @type {FormatCard} */
export const GENERIC_CARD = {
  title: 'Reading an unknown file',
  tagline: 'hex.dance did not recognise this format, but the bytes can still tell you a lot.',
  origin: 'Most binary formats start with a few fixed bytes, a "magic number", that identify them: 89 50 4E 47 for PNG, 50 4B 03 04 ("PK") for ZIP, 7F 45 4C 46 for ELF, 25 50 44 46 ("%PDF") for PDF. Compare the first bytes of this file with a list of known signatures.',
  walkTitle: 'How to read a hex dump',
  walk: HEX_DUMP_WALK,
  gotchasTitle: 'Patterns to look for',
  gotchas: [
    'Long runs of 00 are usually padding or alignment.',
    'Bytes that look random all the way through are probably compressed or encrypted.',
    'Fixed-size records line up as columns when the row width is a multiple of the record size.',
    'Plain text has no magic number; a UTF-8 text file may start with the byte-order mark EF BB BF.'
  ],
  spec: { label: 'List of file signatures (Wikipedia)', url: 'https://en.wikipedia.org/wiki/List_of_file_signatures' }
}
