import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  toHex, toHexList, toCArray, toPythonBytes, toEscapedString, toBase64, rangeFileName, formatSize
} from './copyAs.js'

const deadbeef = Uint8Array.from([0xde, 0xad, 0xbe, 0xef])

test('hex and 0x list', () => {
  assert.equal(toHex(deadbeef), 'de ad be ef')
  assert.equal(toHexList(deadbeef), '0xde, 0xad, 0xbe, 0xef')
  assert.equal(toHex(new Uint8Array(0)), '')
})

test('C array wraps every 12 bytes', () => {
  assert.equal(toCArray(deadbeef), 'unsigned char data[4] = {\n  0xde, 0xad, 0xbe, 0xef\n};')
  const lines = toCArray(new Uint8Array(13)).split('\n')
  assert.equal(lines.length, 4)
  assert.equal(lines[1].split(',').filter(s => s.trim()).length, 12)
  assert.equal(lines[2], '  0x00')
})

test('Python bytes literal', () => {
  const bytes = Uint8Array.from([0x41, 0x27, 0x5c, 0x0a, 0x00, 0xff, 0x09, 0x0d, 0x22])
  assert.equal(toPythonBytes(bytes), "b'A\\'\\\\\\n\\x00\\xff\\t\\r\"'")
})

test('escaped string is valid JavaScript and round-trips', () => {
  const bytes = Uint8Array.from([0x48, 0x69, 0x00, 0x31, 0x00, 0x22, 0x5c, 0x0a, 0x7f, 0xc3])
  const text = toEscapedString(bytes)
  assert.equal(text, '"Hi\\x001\\0\\"\\\\\\n\\x7f\\xc3"')
  const parsed = JSON.parse(JSON.stringify(eval(text)))
  assert.deepEqual(Array.from(parsed, c => c.charCodeAt(0)), Array.from(bytes))
})

test('Base64 matches the platform encoder', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n) & 0xff)
    assert.equal(toBase64(bytes), btoa(String.fromCharCode(...bytes)))
  }
})

test('file names and sizes', () => {
  assert.equal(rangeFileName('hello_elf', 0x40, 0x80), 'hello_elf.0x40-0x7f.bin')
  assert.equal(rangeFileName('a/b:c', 0, 1), 'a_b_c.0x0-0x0.bin')
  assert.equal(formatSize(1), '1 byte')
  assert.equal(formatSize(1024 * 1024), '1.0 MiB')
})
