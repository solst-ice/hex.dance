import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectFileType, parseJavaClass, basicMetadata } from './detectFileType.js'
import {
  buildZip, buildPNG, buildJPEG, buildGIF, buildPDF, SIMPLE_PDF,
  buildJavaClass, buildFatMachO, toArrayBuffer
} from './__fixtures__/fileFormats.js'

test('detects supported formats by their magic bytes', () => {
  assert.equal(detectFileType(buildPNG()), 'png')
  assert.equal(detectFileType(buildJPEG()), 'jpeg')
  assert.equal(detectFileType(buildGIF()), 'gif')
  assert.equal(detectFileType(buildPDF(SIMPLE_PDF)), 'pdf')
  assert.equal(detectFileType(buildZip([{ name: 'a', data: 'a' }])), 'zip')
  assert.equal(detectFileType(buildZip([])), 'zip')
  assert.equal(detectFileType(toArrayBuffer([0x7F, 0x45, 0x4C, 0x46, 2, 1, 1, 0])), 'elf')
  assert.equal(detectFileType(toArrayBuffer([0x4D, 0x5A, 0x90, 0x00])), 'pe')
  assert.equal(detectFileType(toArrayBuffer([0xCF, 0xFA, 0xED, 0xFE, 7, 0, 0, 1])), 'macho')
  assert.equal(detectFileType(toArrayBuffer([0xFE, 0xED, 0xFA, 0xCE])), 'macho')
  assert.equal(detectFileType(toArrayBuffer([0xBE, 0xBA, 0xFE, 0xCA, 2, 0, 0, 0])), 'macho')
  assert.equal(detectFileType(new TextEncoder().encode('just some text').buffer), 'unknown')
})

test('tells Java class files apart from universal Mach-O binaries', () => {
  assert.equal(detectFileType(buildFatMachO(1)), 'macho')
  assert.equal(detectFileType(buildFatMachO(2)), 'macho')
  assert.equal(detectFileType(buildJavaClass({ major: 45, minor: 3 })), 'java-class')
  assert.equal(detectFileType(buildJavaClass({ major: 52 })), 'java-class')
  assert.equal(detectFileType(buildJavaClass({ major: 65, minor: 0xFFFF })), 'java-class')
  assert.equal(detectFileType(toArrayBuffer([0xCA, 0xFE, 0xBA, 0xBE, 0])), 'unknown')
})

test('describes Java class files', () => {
  assert.deepEqual([...parseJavaClass(buildJavaClass({ major: 52 }))], [
    'Format: Java class file',
    'Class File Version: 52.0',
    'Java Release: Java 8'
  ])
  assert.ok([...parseJavaClass(buildJavaClass({ major: 46 }))].includes('Java Release: Java 1.2'))
  assert.ok([...parseJavaClass(buildJavaClass({ major: 65, minor: 0xFFFF }))]
    .includes('Java Release: Java 21 (preview features)'))
})

test('treats empty and tiny files as unknown without throwing', () => {
  for (const bytes of [[], [0x4D], [0xFF, 0xD8 ^ 1], [0x50, 0x4B, 0x03], [0xCA, 0xFE, 0xBA]]) {
    assert.equal(detectFileType(toArrayBuffer(bytes)), 'unknown')
  }
})

test('builds basic metadata for files of any length', () => {
  assert.deepEqual([...basicMetadata(toArrayBuffer([]), '')], [
    'File Size: 0 Bytes',
    'File Type: application/octet-stream'
  ])
  assert.deepEqual([...basicMetadata(toArrayBuffer([0x41, 0x0A]), 'text/plain')], [
    'File Size: 2 Bytes',
    'File Type: text/plain',
    'First Bytes: 0x410A'
  ])
  assert.ok([...basicMetadata(toArrayBuffer([1, 2, 3, 4, 5]))].includes('First Bytes: 0x01020304'))
})
