import {
  ascii, bytesEqual, crc32Masked, formatHexBytes, parseOffset, sha256Hex, u32be, u32le
} from './bytes.js'
import { crc32 } from '../../lib/crc32.js'

/**
 * @typedef {Object} CheckResult
 * @property {boolean} solved
 * @property {number} [progress]   0..1
 * @property {string} message
 *
 * @typedef {Object} Target
 * @property {string} label
 * @property {number} offset
 * @property {number} length
 *
 * @typedef {Object} Challenge
 * @property {string} id
 * @property {string} title
 * @property {'easy'|'medium'|'hard'} difficulty
 * @property {string} teaches
 * @property {string} file          served from public/challenges/
 * @property {string} fileName      name given to the File in the app
 * @property {string} type          MIME type of that File
 * @property {string[]} brief
 * @property {string} goal
 * @property {string[]} hints
 * @property {Target[]} where
 * @property {boolean} [whereAfterHints]   only offer "show me where" once every hint is out
 * @property {{ kind: 'text'|'offset'|'choice', label: string, options?: Array<{id: string, label: string}> }} [answer]
 * @property {string[]} [tools]
 * @property {(bytes: Uint8Array|null, answer?: string) => CheckResult} check
 * @property {string[]} learned
 * @property {{ label: string, href: string }} [spec]
 *
 * Text may mark code with `backticks`.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_SPEC = { label: 'PNG specification (W3C)', href: 'https://www.w3.org/TR/png-3/' }
const CHANGED_ELSEWHERE = 'Some other bytes changed as well. Undo those (or press Reset) and try again.'
const NOT_THE_FILE = 'This no longer looks like the challenge file. Press Reset to start over.'

/** Shared guard: the hex view edits in place, so the length should never change, but check anyway. */
function sameLength(bytes, length) {
  return Boolean(bytes) && bytes.length === length
}

const pct = (n) => Math.max(0, Math.min(1, n))

// ---------------------------------------------------------------------------

const SIGNATURE_LENGTH = 2606
const SIGNATURE_REST_CRC = 0xea76f531

export function checkSignature(bytes) {
  if (!sameLength(bytes, SIGNATURE_LENGTH)) return { solved: false, progress: 0, message: NOT_THE_FILE }
  let correct = 0
  for (let i = 0; i < 8; i++) if (bytes[i] === PNG_SIGNATURE[i]) correct++
  const restIntact = crc32Masked(bytes, [[0, 8]]) === SIGNATURE_REST_CRC
  if (correct === 8 && restIntact) return { solved: true, progress: 1, message: 'All 8 signature bytes are correct. It is a PNG again.' }
  if (!restIntact) return { solved: false, progress: pct(correct / 8), message: CHANGED_ELSEWHERE }
  return { solved: false, progress: pct(correct / 8), message: `${correct} of 8 signature bytes are correct.` }
}

// ---------------------------------------------------------------------------

const FLAG_HASH = 'c9bd6fb9c485d25cf63cc221d7dcf54fe8e37a6acdb1d4ec9c6789422253ed60'
const DECOY_HASH = '416c76db89c6b5960331469e533bbb0b22efb91009ef1e79b7e3cc6d00ccafa0'

/** Accepts `flag{inner}` or just `inner`, ignoring case, quotes and surrounding spaces. */
export function normaliseFlag(answer) {
  const s = String(answer ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim().toLowerCase()
  const wrapped = /^flag\{(.*)\}$/.exec(s)
  return wrapped ? wrapped[1] : s
}

export function checkFlag(bytes, answer) {
  const inner = normaliseFlag(answer)
  if (!inner) return { solved: false, message: 'Type the flag you found, then press Check.' }
  const hash = sha256Hex(inner)
  if (hash === FLAG_HASH) return { solved: true, progress: 1, message: 'That is the flag.' }
  if (hash === DECOY_HASH) return { solved: false, message: 'That one is the leftover test value. The real flag is elsewhere in the file.' }
  return { solved: false, message: 'Not quite. Copy the text between the braces exactly as it appears.' }
}

// ---------------------------------------------------------------------------

const KIND_OPTIONS = [
  { id: 'text', label: 'Plain text' },
  { id: 'png', label: 'PNG image' },
  { id: 'zip', label: 'ZIP archive' },
  { id: 'pdf', label: 'PDF document' },
  { id: 'elf', label: 'Linux program (ELF)' },
  { id: 'gzip', label: 'Gzip-compressed data' }
]

const KIND_FEEDBACK = {
  text: 'A text file is readable from its first byte. These start with `50 4B 03 04`: "PK" and then two bytes that are not text.',
  png: 'A PNG starts with `89 50 4E 47`. Compare that with the first bytes here.',
  pdf: 'A PDF starts with `%PDF` (`25 50 44 46`). Compare that with the first bytes here.',
  elf: 'An ELF program starts with `7F 45 4C 46` (`.ELF`). Compare that with the first bytes here.',
  gzip: 'Gzip data starts with `1F 8B`. Compare that with the first bytes here.'
}

export function checkKind(bytes, answer) {
  if (!answer) return { solved: false, message: 'Pick an answer.' }
  if (answer === 'zip') return { solved: true, progress: 1, message: 'Yes: `50 4B 03 04` is the start of a ZIP archive.' }
  return { solved: false, message: KIND_FEEDBACK[answer] || 'Pick one of the answers.' }
}

// ---------------------------------------------------------------------------

const RESIZE_LENGTH = 246
const RESIZE_REST_CRC = 0x192c1c85
const RESIZE_WIDTH = 260

export function checkResize(bytes) {
  if (!sameLength(bytes, RESIZE_LENGTH)) return { solved: false, progress: 0, message: NOT_THE_FILE }
  const width = u32be(bytes, 16)
  const stored = u32be(bytes, 29)
  const crcOk = stored === crc32(bytes, 12, 29)
  const widthOk = width === RESIZE_WIDTH
  const restIntact = crc32Masked(bytes, [[16, 20], [29, 33]]) === RESIZE_REST_CRC
  const progress = (widthOk ? 0.5 : 0) + (widthOk && crcOk ? 0.5 : 0)
  if (!restIntact) return { solved: false, progress, message: CHANGED_ELSEWHERE }
  if (!widthOk) {
    if (width === 0x04010000) {
      return { solved: false, progress, message: 'The width now reads as 67,174,656. PNG stores numbers big-endian: the most significant byte comes first.' }
    }
    return { solved: false, progress, message: `The width in IHDR reads as ${width.toLocaleString('en-US')} pixels.` }
  }
  if (!crcOk) {
    return { solved: false, progress, message: 'The width is 260 now, but the IHDR CRC no longer matches the chunk. Work out the new CRC with the helper below and write it in.' }
  }
  return { solved: true, progress: 1, message: 'Width 260 and a valid CRC: the image decodes at its real size.' }
}

// ---------------------------------------------------------------------------

const SAVE_LENGTH = 16
const SAVE_REST_CRC = 0x7583b745
const SAVE_TARGET = 1000000

export function checkEndian(bytes) {
  if (!sameLength(bytes, SAVE_LENGTH)) return { solved: false, progress: 0, message: NOT_THE_FILE }
  const score = u32le(bytes, 6)
  const restIntact = crc32Masked(bytes, [[6, 10]]) === SAVE_REST_CRC
  if (!restIntact) return { solved: false, message: CHANGED_ELSEWHERE }
  if (score === SAVE_TARGET) return { solved: true, progress: 1, message: 'The score reads as 1,000,000.' }
  if (u32be(bytes, 6) === SAVE_TARGET) {
    return { solved: false, message: `The score reads as ${score.toLocaleString('en-US')}. The bytes are right, but in big-endian order; this format is little-endian.` }
  }
  return { solved: false, message: `The score reads as ${score.toLocaleString('en-US')}.` }
}

// ---------------------------------------------------------------------------

const HIDDEN_OFFSET = 388
const IEND_START = 376

export function checkHidden(bytes, answer) {
  if (!String(answer ?? '').trim()) return { solved: false, message: 'Type the offset, then press Check.' }
  const parsed = parseOffset(answer)
  if (!parsed) return { solved: false, message: 'Type a number: decimal like 100, or hex like 0x64.' }
  if (parsed.value === HIDDEN_OFFSET) return { solved: true, progress: 1, message: `Yes: the hidden ZIP starts at offset ${HIDDEN_OFFSET} (0x184).` }
  if (!parsed.hexLooking && parseInt(String(answer).trim(), 16) === HIDDEN_OFFSET) {
    return { solved: false, message: 'Offsets in the hex view are hexadecimal. Write a hex number with 0x in front.' }
  }
  if (parsed.value >= IEND_START && parsed.value < HIDDEN_OFFSET) {
    return { solved: false, message: 'That is inside the IEND chunk. The hidden file starts right after IEND ends, after its 4-byte CRC.' }
  }
  return { solved: false, message: 'Not there. Find where the image ends, then look at the very next byte.' }
}

// ---------------------------------------------------------------------------

const DOOR_LENGTH = 6288
const DOOR_REST_CRC = 0x0356e87e
const DOOR_IMM = 0x62c   // the 32-bit constant inside `cmp eax, 0x600DF00D`
const DOOR_JCC = 0x630   // `jne +0x10`
const DOOR_KEY = 0x1010  // the stored key, 0xDEADBEEF
const DOOR_ORIGINAL = [
  [DOOR_IMM, [0x0d, 0xf0, 0x0d, 0x60]],
  [DOOR_JCC, [0x75, 0x10]],
  [DOOR_KEY, [0xef, 0xbe, 0xad, 0xde]]
]
const DOOR_DENIED_TEXT = 0x76f

/**
 * What the patched branch does: 'granted', 'denied', 'compare' (unchanged
 * jne), 'inverse' (je), or null for something unexpected.
 */
function doorBranch(op, rel) {
  if ((op === 0x90 && rel === 0x90) || (op === 0x66 && rel === 0x90)) return 'granted'
  if ((op === 0x75 || op === 0x74 || op === 0xeb) && rel === 0x00) return 'granted'
  if (op === 0x75 && rel === 0x10) return 'compare'
  if (op === 0x74 && rel === 0x10) return 'inverse'
  if (op === 0xeb && rel === 0x10) return 'denied'
  return null
}

export function checkPatch(bytes) {
  if (!sameLength(bytes, DOOR_LENGTH)) return { solved: false, progress: 0, message: NOT_THE_FILE }
  let changed = 0
  for (const [offset, original] of DOOR_ORIGINAL) {
    original.forEach((value, i) => { if (bytes[offset + i] !== value) changed++ })
  }
  const restIntact = crc32Masked(bytes, [[DOOR_IMM, DOOR_JCC + 2], [DOOR_KEY, DOOR_KEY + 4]]) === DOOR_REST_CRC
  if (!restIntact) {
    if (!bytesEqual(bytes, DOOR_DENIED_TEXT, ascii('access denied'))) {
      return { solved: false, message: 'Changing the message text changes what the program says, not what it decides. Put the text back and change the decision instead.' }
    }
    return { solved: false, message: CHANGED_ELSEWHERE }
  }
  if (changed === 0) return { solved: false, message: 'Nothing patched yet. The program still prints "access denied".' }

  const keysMatch = u32le(bytes, DOOR_IMM) === u32le(bytes, DOOR_KEY)
  const branch = doorBranch(bytes[DOOR_JCC], bytes[DOOR_JCC + 1])
  let outcome = null
  if (branch === 'granted' || branch === 'denied') outcome = branch
  else if (branch === 'compare') outcome = keysMatch ? 'granted' : 'denied'
  else if (branch === 'inverse') outcome = keysMatch ? 'denied' : 'granted'

  const count = `${changed} ${changed === 1 ? 'byte' : 'bytes'} changed`
  if (outcome === 'granted') {
    const tip = changed > 1 ? ' It works. The smallest patch changes a single byte; can you find it?' : ' The smallest possible patch.'
    return { solved: true, progress: 1, message: `The program now prints "access granted" (${count}).${tip}` }
  }
  if (branch === null) {
    return { solved: false, message: `The two bytes at 0x630 are now ${formatHexBytes([bytes[DOOR_JCC], bytes[DOOR_JCC + 1]])}, which is not one of the patches this check understands. Try a one-byte change to the jump.` }
  }
  if (branch === 'denied') return { solved: false, message: 'EB is an unconditional jump: now the program always jumps, straight to "access denied".' }
  return { solved: false, message: `The program would still print "access denied" (${count}).` }
}

// ---------------------------------------------------------------------------

const BMP_LENGTH = 246
const BMP_REST_CRC = 0x90572a88
const BMP_TOP_LEFT = 54 + 7 * 24
const BMP_BOTTOM_LEFT = 54

const isRed = (b, g, r) => r >= 0xc0 && g <= 0x50 && b <= 0x50
const isBlue = (b, g, r) => b >= 0xc0 && g <= 0x50 && r <= 0x50

export function checkPixel(bytes) {
  if (!sameLength(bytes, BMP_LENGTH)) return { solved: false, progress: 0, message: NOT_THE_FILE }
  const at = (offset) => [bytes[offset], bytes[offset + 1], bytes[offset + 2]]
  const restIntact = crc32Masked(bytes, [[BMP_TOP_LEFT, BMP_TOP_LEFT + 3]]) === BMP_REST_CRC
  const topLeft = at(BMP_TOP_LEFT)
  if (!restIntact) {
    if (isRed(...at(BMP_BOTTOM_LEFT)) || isBlue(...at(BMP_BOTTOM_LEFT))) {
      return { solved: false, message: 'You painted the bottom-left pixel. This BMP stores its rows from the bottom up, so the first row in the file is the bottom of the picture.' }
    }
    return { solved: false, message: CHANGED_ELSEWHERE }
  }
  if (isRed(...topLeft)) return { solved: true, progress: 1, message: 'The top-left pixel is red.' }
  if (isBlue(...topLeft)) return { solved: false, message: 'Right pixel, but it is blue. BMP stores each pixel as blue, green, red.' }
  return { solved: false, message: `The top-left pixel is stored as ${formatHexBytes(topLeft)} (blue, green, red). Make it red.` }
}

// ---------------------------------------------------------------------------

/** @type {Challenge[]} */
export const CHALLENGES = [
  {
    id: 'signature',
    title: 'Broken signature',
    difficulty: 'easy',
    teaches: 'Magic numbers',
    file: 'broken.png',
    fileName: 'broken.png',
    type: 'image/png',
    brief: [
      'This picture will not open. Every PNG file begins with the same 8 bytes, called its signature, and the first four of them got damaged.',
      'How to edit: press EDIT above the hex view, click the byte you want to change, and type two hex digits (0–9, A–F) for each byte. Typing moves on to the next byte. UNDO and REVERT ALL are there if you slip. Edits stay on this device.'
    ],
    goal: 'Restore the 8-byte PNG signature at the start of the file.',
    hints: [
      'The last four signature bytes survived: `0D 0A 1A 0A`. Only bytes 0 to 3 need fixing.',
      'Bytes 1 to 3 should spell PNG in capital letters. In ASCII that is `50 4E 47`; the damaged file has lowercase `70 6E 67`.',
      'The first byte is `89`. The full signature is `89 50 4E 47 0D 0A 1A 0A`.'
    ],
    where: [{ label: 'Signature', offset: 0, length: 8 }],
    check: checkSignature,
    learned: [
      'Most formats start with a fixed pattern of bytes, often called a magic number, so programs can recognise a file without trusting its name.',
      'The PNG signature is designed to catch damage: `89` has its high bit set, to detect channels that strip it; `PNG` names the format; `0D 0A` (CR LF) and the final `0A` (LF) reveal line-ending conversion; `1A` stops the file from scrolling past when it is printed as text on DOS.'
    ],
    spec: PNG_SPEC
  },
  {
    id: 'flag',
    title: 'Find the flag',
    difficulty: 'easy',
    teaches: 'Reading the text column',
    file: 'flag.bin',
    fileName: 'flag.bin',
    type: 'application/octet-stream',
    brief: [
      'This file is mostly noise, but somewhere inside it is a message that looks like `flag{...}`. The text column on the right of the hex view shows each byte as a character, so readable text stands out among the dots.',
      'Careful: there are two flag-shaped strings, and one is a leftover test value.'
    ],
    goal: 'Find the real flag and type it below.',
    hints: [
      'Scroll through the text column and look for readable words. If your version of the app has a Strings or Search tab, it can list them for you.',
      'The leftover test value sits near the start of the file and says so. The real flag is in the second half of the file.',
      'The real flag is at offset 0x459. "Show me where" now selects it.'
    ],
    where: [{ label: 'Flag', offset: 1113, length: 24 }],
    whereAfterHints: true,
    answer: { kind: 'text', label: 'Flag' },
    check: checkFlag,
    learned: [
      'Any byte from 0x20 to 0x7E is a printable ASCII character, so text inside a binary file shows up plainly in the text column. That is often the quickest way to get your bearings in an unknown file.',
      'Real files are full of readable strings: error messages, file paths, version numbers, and sometimes things that were never meant to be shipped.'
    ]
  },
  {
    id: 'extension',
    title: 'Wrong extension',
    difficulty: 'easy',
    teaches: 'Names lie, bytes do not',
    file: 'notes.txt',
    fileName: 'notes.txt',
    type: 'text/plain',
    brief: [
      'This file is called notes.txt, but a name is only a label anyone can change. What a file really is shows in its first few bytes.'
    ],
    goal: 'Look at the first four bytes and say what kind of file this really is.',
    hints: [
      'Look at the first four bytes in the hex column: `50 4B 03 04`. Only the first two are printable letters.',
      '`50 4B` is "PK", the initials of Phil Katz, who created the format.'
    ],
    where: [{ label: 'First bytes', offset: 0, length: 4 }],
    answer: { kind: 'choice', label: 'This file is a…', options: KIND_OPTIONS },
    check: checkKind,
    learned: [
      'Extensions are hints for people and for the operating system; the bytes decide what a file really is. Tools like `file` on Linux and this app look at the content.',
      '`50 4B 03 04` starts a ZIP "local file header". Many formats are ZIP archives underneath: .docx, .xlsx, .jar, .apk and .epub all start with these bytes.'
    ]
  },
  {
    id: 'resize',
    title: 'Resize the image',
    difficulty: 'medium',
    teaches: 'Big-endian numbers, chunks, checksums',
    file: 'squashed.png',
    fileName: 'squashed.png',
    type: 'image/png',
    brief: [
      'Someone changed the width in this PNG and then recomputed its checksum, so the file looks consistent, but the picture data no longer lines up: it shows skewed or not at all. A note inside the file still says the original size.',
      'A PNG is a list of chunks. Each chunk has a 4-byte length, a 4-byte type such as `IHDR`, its data, and a 4-byte CRC: a checksum over the type and the data. The first chunk, IHDR, starts with the width and the height, 4 bytes each, most significant byte first (big-endian).'
    ],
    goal: 'Set the width back to the original value and fix the IHDR CRC.',
    hints: [
      'The note is in a `tEXt` chunk right after IHDR. Read it in the text column.',
      'The width is at offset 0x10 (bytes 16 to 19). 260 in hex is 0x104, so as four big-endian bytes it is `00 00 01 04`.',
      'The CRC covers the IHDR type and data: bytes 12 to 28 (0x0C to 0x1C), 17 bytes. Select them by dragging in the hex view, press "CRC of selection" below, and type the result into bytes 29 to 32 (0x1D to 0x20).'
    ],
    where: [
      { label: 'Width', offset: 16, length: 4 },
      { label: 'CRC', offset: 29, length: 4 }
    ],
    tools: ['crc'],
    check: checkResize,
    learned: [
      'Big-endian means the most significant byte comes first, the way we write numbers: 260 is `00 00 01 04`. PNG, and network protocols in general, use this order.',
      'Every PNG chunk carries a CRC-32 of its type and data. A reader that finds a mismatch knows the chunk is damaged, so changing a value means updating its CRC too. A CRC catches accidents, not tampering: anyone can recompute it, as you just did.'
    ],
    spec: PNG_SPEC
  },
  {
    id: 'endian',
    title: 'Endianness',
    difficulty: 'medium',
    teaches: 'Byte order',
    file: 'game.sav',
    fileName: 'game.sav',
    type: 'application/octet-stream',
    brief: [
      'This is a save file from a tiny made-up game. Its layout: bytes 0 to 3 are the magic `HXSV`; bytes 4 and 5 are the lives, a 16-bit number; bytes 6 to 9 are the score, a 32-bit number; the rest is the player name.',
      'Both numbers are little-endian: the least significant byte comes first. Most PCs and phones store numbers in memory this way. Right now there are 3 lives (`03 00`) and the score is 1,337 (`39 05 00 00`).'
    ],
    goal: 'Change the score to exactly 1,000,000.',
    hints: [
      'First turn 1,000,000 into hex. It is 0x000F4240.',
      'Split that into bytes: `00 0F 42 40`. Little-endian writes them from the least significant end.',
      'Type `40 42 0F 00` at offset 6.'
    ],
    where: [{ label: 'Score', offset: 6, length: 4 }],
    check: checkEndian,
    learned: [
      'The same four bytes mean different numbers depending on byte order: `40 42 0F 00` is 1,000,000 read little-endian but 1,078,071,040 read big-endian. A format has to say which order it uses.',
      'Little-endian is the native order of x86 and of most ARM systems, so it is common in file formats designed around them. Big-endian is common in network protocols and in older formats such as PNG and Java class files.'
    ]
  },
  {
    id: 'hidden',
    title: 'Hidden extra',
    difficulty: 'medium',
    teaches: 'End markers and appended data',
    file: 'holiday.png',
    fileName: 'holiday.png',
    type: 'image/png',
    brief: [
      'This holiday picture opens fine, but the file is bigger than the picture needs. Something was stuck on after the end of the image.',
      'A PNG ends with an `IEND` chunk. Image viewers stop reading there, so anything after it is invisible to them, but it is still in the file.'
    ],
    goal: 'Find the offset where the hidden file starts and type it below.',
    hints: [
      'Look for the letters IEND in the text column, near the end of the image data.',
      'IEND is a chunk with no data: 4-byte length `00 00 00 00`, type `49 45 4E 44`, and a 4-byte CRC `AE 42 60 82`. The image ends after that CRC.',
      'The hidden file starts with `50 4B 03 04`. You can type the offset in decimal or in hex with 0x in front.'
    ],
    where: [{ label: 'IEND chunk', offset: IEND_START, length: 12 }],
    answer: { kind: 'offset', label: 'Offset' },
    check: checkHidden,
    learned: [
      'Many formats have a clear end marker, and readers ignore whatever follows it. That makes appended data an easy hiding place, and a common trick in puzzles and in malware.',
      'This file is both a PNG and a ZIP: image viewers read it from the front, while ZIP tools find the archive from its directory at the end of the file. Rename it to .zip and it opens as an archive.'
    ],
    spec: PNG_SPEC
  },
  {
    id: 'patch',
    title: 'Patch the program',
    difficulty: 'hard',
    teaches: 'Machine code and conditional jumps',
    file: 'door',
    fileName: 'door',
    type: 'application/octet-stream',
    brief: [
      'This is a small 64-bit Linux program. It reads a 4-byte key stored in its own data, compares it with a constant, and prints "access denied" unless they match. They never do.',
      'Patch the program so that it prints "access granted", changing as few bytes as possible. You do not need to run it: the check looks at the patched bytes.'
    ],
    goal: 'Make the check always pass. One byte is enough.',
    hints: [
      'Press "Show me where: Comparison". `3D 0D F0 0D 60` is `cmp eax, 0x600DF00D` (the constant is stored little-endian), and the next two bytes, `75 10`, are `jne +0x10`: "if not equal, jump 0x10 bytes ahead", to the code that prints "access denied".',
      'In x86 machine code, `75` is jne (jump if not equal) and `74` is je (jump if equal). Changing that one byte turns the test around.',
      'Another way: make the two values equal. The stored key is at file offset 0x1010 (the program sees it at address 0x2010): `EF BE AD DE`, which is 0xDEADBEEF little-endian.'
    ],
    where: [
      { label: 'Comparison', offset: 0x62b, length: 7 },
      { label: 'Stored key', offset: DOOR_KEY, length: 4 }
    ],
    check: checkPatch,
    learned: [
      'The original code is `cmp eax, 0x600DF00D` followed by `jne +0x10`. When the key differs from the constant, the jump skips the "access granted" code and lands on "access denied".',
      'Patches that work: change `75` to `74` (je jumps to "denied" only when the key matches, which it never does); replace `75 10` with `90 90` (two NOPs, "no operation", so execution always falls through to "granted"); change the jump distance to `00` so both paths lead to the next instruction; or make the compared constant and the stored key equal. Each of these was applied to this file and run on x86-64 Linux to confirm it prints "access granted".',
      'This is how simple software protections are broken and why real ones do not rely on a single comparison in code the user controls.'
    ]
  },
  {
    id: 'pixel',
    title: 'Paint a pixel',
    difficulty: 'medium',
    teaches: 'Pixel layout in a bitmap',
    file: 'smiley.bmp',
    fileName: 'smiley.bmp',
    type: 'image/bmp',
    brief: [
      'This 8 by 8 smiley is a BMP file: a 54-byte header followed by raw pixels, 3 bytes per pixel. Every row of 8 pixels takes 24 bytes (rows are padded to a multiple of 4 bytes, and 24 needs no padding).',
      'BMP has two surprises: each pixel is stored as blue, green, red, and the rows usually run from the bottom of the picture to the top.'
    ],
    goal: 'Paint the top-left pixel red, leaving every other pixel as it is.',
    hints: [
      'The pixels start at offset 54 (0x36); the header says so in bytes 10 to 13.',
      'The first row in the file is the bottom row of the picture, so the top row is the last one: 54 + 7 × 24 = 222 (0xDE).',
      'Red is blue 00, green 00, red FF: type `00 00 FF` at offset 0xDE.'
    ],
    where: [{ label: 'Top-left pixel', offset: BMP_TOP_LEFT, length: 3 }],
    check: checkPixel,
    learned: [
      'An uncompressed bitmap is just numbers in a grid. Once you know where the pixels start, how wide a row is and in which order the rows and colour channels go, you can find any pixel with a little arithmetic.',
      'BMP stores rows bottom-up when the height in its header is positive and top-down when it is negative. Many image formats store rows top-down and colours as red, green, blue, so always check the specification.'
    ]
  }
]

export function challengeById(id) {
  return CHALLENGES.find(challenge => challenge.id === id) || null
}

/** Runs a checker without ever letting it throw into the page. */
export function runCheck(challenge, bytes, answer) {
  try {
    const result = challenge.check(bytes, answer)
    if (result && typeof result.solved === 'boolean') return result
  } catch {
    // fall through
  }
  return { solved: false, message: NOT_THE_FILE }
}
