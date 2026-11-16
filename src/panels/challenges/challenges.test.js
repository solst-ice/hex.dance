import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import {
  CHALLENGES, challengeById, checkEndian, checkFlag, checkHidden, checkKind, checkPatch, checkPixel,
  checkResize, checkSignature, normaliseFlag, runCheck
} from './challenges.js'
import { ascii, crc32Masked, parseHexBytes, parseOffset, sha256Hex, u32be } from './bytes.js'
import { crc32 } from '../../lib/crc32.js'

const fileUrl = (name) => new URL(`../../../public/challenges/${name}`, import.meta.url)
const load = (name) => new Uint8Array(readFileSync(fileUrl(name)))

/** Copy of a challenge file with `hex` written at each offset. */
function patched(name, edits) {
  const bytes = load(name)
  for (const [offset, hex] of edits) bytes.set(parseHexBytes(hex), offset)
  return bytes
}

const EMPTY = new Uint8Array(0)
const truncated = (name) => load(name).subarray(0, 20)

// ---------------------------------------------------------------------------

test('bytes helpers', () => {
  assert.equal(crc32(new Uint8Array(ascii('123456789'))), 0xcbf43926)
  const data = load('squashed.png')
  const zeroed = Uint8Array.from(data)
  zeroed.fill(0, 16, 20)
  zeroed.fill(0, 29, 33)
  assert.equal(crc32Masked(data, [[29, 33], [16, 20], [18, 19]]), crc32(zeroed))
  assert.equal(crc32Masked(data, [[-4, 2], [data.length - 1, data.length + 9]]), crc32(Uint8Array.from(data).fill(0, 0, 2).fill(0, data.length - 1)))
  assert.equal(crc32Masked(EMPTY, [[0, 4]]), 0)
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Hex('a'.repeat(200)).length, 64)
  assert.deepEqual([...parseHexBytes('89 50 4e 47')], [0x89, 0x50, 0x4e, 0x47])
  assert.deepEqual([...parseHexBytes('0x49,0x48')], [0x49, 0x48])
  assert.equal(parseHexBytes('abc'), null)
  assert.equal(parseHexBytes('zz'), null)
  assert.equal(parseHexBytes(''), null)
  assert.deepEqual(parseOffset('0x184'), { value: 388, hexLooking: true })
  assert.deepEqual(parseOffset('388'), { value: 388, hexLooking: false })
  assert.deepEqual(parseOffset('184h'), { value: 388, hexLooking: true })
  assert.equal(parseOffset('nope'), null)
  assert.equal(u32be(new Uint8Array(3), 0), null)
})

test('challenge files exist, are small, and targets fit inside them', () => {
  const ids = new Set()
  for (const challenge of CHALLENGES) {
    assert.ok(!ids.has(challenge.id), `duplicate id ${challenge.id}`)
    ids.add(challenge.id)
    const size = statSync(fileUrl(challenge.file)).size
    assert.ok(size > 0 && size < 20 * 1024, `${challenge.file} is ${size} bytes`)
    for (const target of challenge.where) assert.ok(target.offset + target.length <= size, `${challenge.id}: ${target.label}`)
    assert.ok(challenge.hints.length >= 2)
    assert.ok(challenge.brief.length >= 1 && challenge.learned.length >= 1)
    for (const text of [...challenge.brief, ...challenge.hints, ...challenge.learned, challenge.goal]) {
      assert.equal(text.split('`').length % 2, 1, `unbalanced backticks in ${challenge.id}: ${text}`)
    }
  }
  assert.equal(challengeById('patch').file, 'door')
  assert.equal(challengeById('nope'), null)
})

test('no checker throws on hostile input', () => {
  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32
  const answers = [undefined, null, '', '   ', 'flag{}', '0x', '-1', '99999999999999999999', 'zip', {}, 42]
  const inputs = [null, undefined, EMPTY, new Uint8Array(1)]
  for (const challenge of CHALLENGES) {
    const size = load(challenge.file).length
    inputs.push(new Uint8Array(size).map(() => Math.floor(random() * 256)))
    inputs.push(new Uint8Array(size).fill(0xff))
  }
  for (const challenge of CHALLENGES) {
    for (const bytes of inputs) {
      for (const answer of answers) {
        const result = runCheck(challenge, bytes, answer)
        assert.equal(typeof result.solved, 'boolean')
        assert.equal(typeof result.message, 'string')
        if (challenge.id !== 'flag' && challenge.id !== 'extension' && challenge.id !== 'hidden') assert.equal(result.solved, false)
      }
    }
  }
})

test('runCheck turns a throwing checker into a safe result', () => {
  const result = runCheck({ check: () => { throw new Error('boom') } }, EMPTY)
  assert.equal(result.solved, false)
})

test('1. broken signature', () => {
  const start = checkSignature(load('broken.png'))
  assert.equal(start.solved, false)
  assert.equal(start.progress, 0.5)

  assert.equal(checkSignature(patched('broken.png', [[0, '89504E47']])).solved, true)

  const partial = checkSignature(patched('broken.png', [[0, '89504e']]))
  assert.equal(partial.solved, false)
  assert.match(partial.message, /7 of 8/)

  const lowercase = checkSignature(patched('broken.png', [[0, '89706e67']]))
  assert.equal(lowercase.solved, false)

  const elsewhere = checkSignature(patched('broken.png', [[0, '89504E47'], [100, '00']]))
  assert.equal(elsewhere.solved, false)
  assert.match(elsewhere.message, /other bytes/)

  const brokeTail = checkSignature(patched('broken.png', [[0, '89504E47'], [7, '0d']]))
  assert.equal(brokeTail.solved, false)

  assert.equal(checkSignature(truncated('broken.png')).solved, false)
  assert.equal(checkSignature(EMPTY).solved, false)
})

test('2. find the flag', () => {
  const text = new TextDecoder('latin1').decode(load('flag.bin'))
  assert.equal((text.match(/flag\{/g) || []).length, 2)
  const real = /flag\{hex_[a-z_]+\}/.exec(text)
  assert.ok(real)
  assert.equal(real.index, challengeById('flag').where[0].offset)
  assert.equal(real[0].length, challengeById('flag').where[0].length)

  assert.equal(checkFlag(load('flag.bin'), real[0]).solved, true)
  assert.equal(checkFlag(null, real[0]).solved, true)
  assert.equal(checkFlag(load('flag.bin'), `  ${real[0].toUpperCase()} `).solved, true)
  assert.equal(checkFlag(load('flag.bin'), real[0].slice(5, -1)).solved, true)
  assert.equal(checkFlag(load('flag.bin'), `"${real[0]}"`).solved, true)
  assert.equal(normaliseFlag('FLAG{Abc}'), 'abc')

  const decoy = checkFlag(load('flag.bin'), 'flag{test_flag_please_ignore}')
  assert.equal(decoy.solved, false)
  assert.match(decoy.message, /test value/)

  assert.equal(checkFlag(load('flag.bin'), real[0].slice(0, -2) + '}').solved, false)
  assert.equal(checkFlag(load('flag.bin'), 'flag{').solved, false)
  assert.equal(checkFlag(EMPTY, '').solved, false)
  assert.equal(checkFlag(EMPTY, undefined).solved, false)
})

test('2. the flag is not in the panel source in clear text', () => {
  const source = readFileSync(new URL('./challenges.js', import.meta.url), 'utf8')
  const real = /flag\{(hex_[a-z_]+)\}/.exec(new TextDecoder('latin1').decode(load('flag.bin')))[1]
  assert.ok(!source.includes(real))
})

test('3. wrong extension', () => {
  const bytes = load('notes.txt')
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  assert.equal(checkKind(bytes, 'zip').solved, true)
  for (const wrong of ['text', 'png', 'pdf', 'elf', 'gzip', 'other']) {
    const result = checkKind(bytes, wrong)
    assert.equal(result.solved, false, wrong)
    assert.ok(result.message.length > 0)
  }
  assert.equal(checkKind(bytes, '').solved, false)
  assert.equal(checkKind(EMPTY, undefined).solved, false)
})

test('4. resize the image', () => {
  const bytes = load('squashed.png')
  assert.match(new TextDecoder('latin1').decode(bytes), /Original size: 260 x 24/)
  assert.equal(u32be(bytes, 16), 200)
  assert.equal(u32be(bytes, 29), crc32(bytes, 12, 29), 'the damaged file is self-consistent')

  const start = checkResize(bytes)
  assert.equal(start.solved, false)
  assert.equal(start.progress, 0)

  const widthOnly = checkResize(patched('squashed.png', [[16, '00000104']]))
  assert.equal(widthOnly.solved, false)
  assert.equal(widthOnly.progress, 0.5)
  assert.match(widthOnly.message, /CRC/)

  const fixed = patched('squashed.png', [[16, '00000104']])
  const crc = crc32(fixed, 12, 29)
  fixed.set([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], 29)
  assert.equal(checkResize(fixed).solved, true)

  const littleEndian = checkResize(patched('squashed.png', [[16, '04010000']]))
  assert.equal(littleEndian.solved, false)
  assert.match(littleEndian.message, /big-endian/)

  // a CRC that is valid for a different change does not count
  const otherHeight = patched('squashed.png', [[16, '00000104'], [23, '19']])
  const crc2 = crc32(otherHeight, 12, 29)
  otherHeight.set([crc2 >>> 24, (crc2 >>> 16) & 0xff, (crc2 >>> 8) & 0xff, crc2 & 0xff], 29)
  assert.equal(checkResize(otherHeight).solved, false)

  const crcOnly = patched('squashed.png', [[29, '00000000']])
  assert.equal(checkResize(crcOnly).solved, false)

  assert.equal(checkResize(truncated('squashed.png')).solved, false)
  assert.equal(checkResize(EMPTY).solved, false)
})

test('5. endianness', () => {
  const start = checkEndian(load('game.sav'))
  assert.equal(start.solved, false)
  assert.match(start.message, /1,337/)

  assert.equal(checkEndian(patched('game.sav', [[6, '40420F00']])).solved, true)

  const bigEndian = checkEndian(patched('game.sav', [[6, '000F4240']]))
  assert.equal(bigEndian.solved, false)
  assert.match(bigEndian.message, /big-endian/)

  assert.equal(checkEndian(patched('game.sav', [[6, '41420F00']])).solved, false)
  assert.equal(checkEndian(patched('game.sav', [[6, '40420F00'], [4, '0900']])).solved, false)
  assert.equal(checkEndian(patched('game.sav', [[6, '40420F00'], [0, '00']])).solved, false)
  assert.equal(checkEndian(load('game.sav').subarray(0, 9)).solved, false)
  assert.equal(checkEndian(EMPTY).solved, false)
})

test('6. hidden extra', () => {
  const bytes = load('holiday.png')
  const iend = challengeById('hidden').where[0]
  assert.deepEqual([...bytes.subarray(iend.offset + 4, iend.offset + 8)], ascii('IEND'))
  const zipAt = iend.offset + iend.length
  assert.deepEqual([...bytes.subarray(zipAt, zipAt + 4)], [0x50, 0x4b, 0x03, 0x04])

  for (const answer of [String(zipAt), `0x${zipAt.toString(16)}`, `0X${zipAt.toString(16).toUpperCase()}`, `${zipAt.toString(16)}h`, ` ${zipAt} `]) {
    assert.equal(checkHidden(bytes, answer).solved, true, answer)
  }
  const bareHex = checkHidden(bytes, zipAt.toString(16))
  assert.equal(bareHex.solved, false)
  assert.match(bareHex.message, /0x/)

  assert.match(checkHidden(bytes, String(iend.offset)).message, /inside the IEND/)
  assert.equal(checkHidden(bytes, String(zipAt + 1)).solved, false)
  assert.equal(checkHidden(bytes, String(zipAt - 1)).solved, false)
  assert.equal(checkHidden(bytes, 'PK').solved, false)
  assert.equal(checkHidden(bytes, '').solved, false)
  assert.equal(checkHidden(EMPTY, undefined).solved, false)
})

test('7. patch the program', () => {
  const bytes = load('door')
  assert.deepEqual([...bytes.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46])
  assert.deepEqual([...bytes.subarray(0x62b, 0x632)], [0x3d, 0x0d, 0xf0, 0x0d, 0x60, 0x75, 0x10])

  const start = checkPatch(bytes)
  assert.equal(start.solved, false)

  const accepted = {
    'jne -> je': [[0x630, '74']],
    'nop nop': [[0x630, '9090']],
    'two-byte nop': [[0x630, '6690']],
    'jne +0': [[0x631, '00']],
    'je +0': [[0x630, '7400']],
    'jmp +0': [[0x630, 'eb00']],
    'constant = key': [[0x62c, 'efbeadde']],
    'key = constant': [[0x1010, '0df00d60']],
    'both zero': [[0x62c, '00000000'], [0x1010, '00000000']]
  }
  for (const [label, edits] of Object.entries(accepted)) {
    const result = checkPatch(patched('door', edits))
    assert.equal(result.solved, true, `${label}: ${result.message}`)
  }
  assert.match(checkPatch(patched('door', [[0x630, '74']])).message, /1 byte changed/)
  assert.match(checkPatch(patched('door', [[0x630, '9090']])).message, /2 bytes changed/)

  const rejected = {
    'jmp to denied': [[0x630, 'eb10']],
    'key written big-endian': [[0x1010, '600df00d']],
    'je with matching values': [[0x630, '74'], [0x1010, '0df00d60']],
    'unknown opcode': [[0x630, '7f']],
    'longer jump': [[0x631, '11']],
    'message text': [[0x76f + 7, ascii('granted').map(c => c.toString(16)).join('')]],
    'cmp opcode': [[0x62b, '90']],
    'elsewhere': [[0x630, '74'], [0x100, 'ff']]
  }
  for (const [label, edits] of Object.entries(rejected)) {
    assert.equal(checkPatch(patched('door', edits)).solved, false, label)
  }
  assert.match(checkPatch(patched('door', [[0x76f + 7, '00']])).message, /message text/)

  assert.equal(checkPatch(truncated('door')).solved, false)
  assert.equal(checkPatch(EMPTY).solved, false)
})

test('8. paint a pixel', () => {
  const bytes = load('smiley.bmp')
  assert.deepEqual([...bytes.subarray(0, 2)], ascii('BM'))
  const topLeft = challengeById('pixel').where[0].offset
  assert.equal(topLeft, bytes[10] + 7 * 24)

  assert.equal(checkPixel(bytes).solved, false)
  assert.equal(checkPixel(patched('smiley.bmp', [[topLeft, '0000FF']])).solved, true)
  assert.equal(checkPixel(patched('smiley.bmp', [[topLeft, '1020C8']])).solved, true)

  const blue = checkPixel(patched('smiley.bmp', [[topLeft, 'FF0000']]))
  assert.equal(blue.solved, false)
  assert.match(blue.message, /blue, green, red/)

  const bottom = checkPixel(patched('smiley.bmp', [[54, '0000FF']]))
  assert.equal(bottom.solved, false)
  assert.match(bottom.message, /bottom/)

  assert.equal(checkPixel(patched('smiley.bmp', [[topLeft, '0000FF'], [topLeft + 3, '0000FF']])).solved, false)
  assert.equal(checkPixel(patched('smiley.bmp', [[topLeft, '00FFFF']])).solved, false)
  assert.equal(checkPixel(truncated('smiley.bmp')).solved, false)
  assert.equal(checkPixel(EMPTY).solved, false)
})
