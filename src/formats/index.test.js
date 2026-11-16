import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectFormat } from './index.js'
import { analyzeBytes } from '../analysis/analyze.js'
import {
  buildZip, buildPNG, buildJPEG, buildGIF, buildPDF, SIMPLE_PDF,
  buildJavaClass, buildFatMachO, toArrayBuffer
} from './__fixtures__/fileFormats.js'

const detect = buffer => detectFormat(new Uint8Array(buffer))?.id ?? 'unknown'

test('detects supported formats by their magic bytes', () => {
  assert.equal(detect(buildPNG()), 'png')
  assert.equal(detect(buildJPEG()), 'jpeg')
  assert.equal(detect(buildGIF()), 'gif')
  assert.equal(detect(buildPDF(SIMPLE_PDF)), 'pdf')
  assert.equal(detect(buildZip([{ name: 'a', data: 'a' }])), 'zip')
  assert.equal(detect(buildZip([])), 'zip')
  assert.equal(detect(toArrayBuffer([0x7F, 0x45, 0x4C, 0x46, 2, 1, 1, 0])), 'elf')
  assert.equal(detect(toArrayBuffer([0x4D, 0x5A, 0x90, 0x00])), 'pe')
  assert.equal(detect(toArrayBuffer([0xCF, 0xFA, 0xED, 0xFE, 7, 0, 0, 1])), 'macho')
  assert.equal(detect(toArrayBuffer([0xFE, 0xED, 0xFA, 0xCE])), 'macho')
  assert.equal(detect(toArrayBuffer([0xBE, 0xBA, 0xFE, 0xCA, 2, 0, 0, 0])), 'macho')
  assert.equal(detect(new TextEncoder().encode('just some text').buffer), 'text')
})

test('detects formats in views that do not start at the beginning of their buffer', () => {
  const backing = new Uint8Array(16)
  backing.set([0x7F, 0x45, 0x4C, 0x46], 8)
  assert.equal(detectFormat(backing.subarray(8))?.id, 'elf')
})

test('tells Java class files apart from universal Mach-O binaries', () => {
  assert.equal(detect(buildFatMachO(1)), 'macho')
  assert.equal(detect(buildFatMachO(2)), 'macho')
  assert.equal(detect(buildJavaClass({ major: 45, minor: 3 })), 'java-class')
  assert.equal(detect(buildJavaClass({ major: 52 })), 'java-class')
  assert.equal(detect(buildJavaClass({ major: 65, minor: 0xFFFF })), 'java-class')
  assert.equal(detect(toArrayBuffer([0xCA, 0xFE, 0xBA, 0xBE, 0])), 'unknown')
})

test('describes Java class files', () => {
  const lines = buffer => analyzeBytes(new Uint8Array(buffer)).summary.map(entry => `${entry.label}: ${entry.value}`)
  assert.deepEqual(lines(buildJavaClass({ major: 52 })), [
    'Format: Java class file',
    'Class File Version: 52.0',
    'Java Release: Java 8'
  ])
  assert.ok(lines(buildJavaClass({ major: 46 })).includes('Java Release: Java 1.2'))
  assert.ok(lines(buildJavaClass({ major: 65, minor: 0xFFFF })).includes('Java Release: Java 21 (preview features)'))
})

test('treats empty and tiny files as unknown without throwing', () => {
  for (const bytes of [[], [0x4D], [0xFF, 0xD8 ^ 1], [0x50, 0x4B, 0x03], [0xCA, 0xFE, 0xBA]]) {
    assert.equal(detect(toArrayBuffer(bytes)), 'unknown')
  }
})
