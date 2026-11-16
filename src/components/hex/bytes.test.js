import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HEX, CHAR, CLASS_NAME, byteClass, describeByte, formatOffset, hexText, asciiText, downloadName
} from './bytes.js'

test('byte classes', () => {
  assert.equal(byteClass(0x00), 'zero')
  assert.equal(byteClass(0x41), 'print')
  assert.equal(byteClass(0x7e), 'print')
  assert.equal(byteClass(0x20), 'ctrl')
  assert.equal(byteClass(0x0a), 'ctrl')
  assert.equal(byteClass(0x7f), 'ctrl')
  assert.equal(byteClass(0x80), 'high')
  assert.equal(byteClass(0xfe), 'high')
  assert.equal(byteClass(0xff), 'ff')
  assert.equal(CLASS_NAME[0], 'b-zero')
})

test('tables', () => {
  assert.equal(HEX[0], '00')
  assert.equal(HEX[0xab], 'ab')
  assert.equal(CHAR[0x41], 'A')
  assert.equal(CHAR[0x20], ' ')
  assert.equal(CHAR[0], '·')
  assert.equal(CHAR[0x90], '.')
})

test('describeByte', () => {
  assert.deepEqual(describeByte(0x41), { hex: '0x41', dec: '65', bin: '0b01000001', char: "'A'" })
  assert.equal(describeByte(0x0a).char, 'LF')
  assert.equal(describeByte(0x01).char, '^A')
  assert.equal(describeByte(0xff).char, '—')
})

test('formatting and copy text', () => {
  assert.equal(formatOffset(0x1f), '0000001f')
  assert.equal(formatOffset(2 ** 31 - 1), '7fffffff')
  const bytes = new Uint8Array([0x48, 0x69, 0x00, 0x0a, 0xff])
  assert.equal(hexText(bytes, 0, 5), '48 69 00 0a ff')
  assert.equal(hexText(bytes, 2, 2), '')
  assert.equal(asciiText(bytes, 0, 5), 'Hi.\n.')
  const big = new Uint8Array(20000).fill(0x61)
  assert.equal(asciiText(big, 0, big.length), 'a'.repeat(20000))
})

test('downloadName adds -hexdance before the extension', () => {
  assert.equal(downloadName('photo.png'), 'photo-hexdance.png')
  assert.equal(downloadName('a.tar.gz'), 'a.tar-hexdance.gz')
  assert.equal(downloadName('Makefile'), 'Makefile-hexdance')
  assert.equal(downloadName('.bashrc'), '.bashrc-hexdance')
  assert.equal(downloadName(''), 'file-hexdance')
})
