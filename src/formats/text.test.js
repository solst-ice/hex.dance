import { test } from 'node:test'
import assert from 'node:assert/strict'
import text, { sniffEncoding } from './text.js'
import { buildText, buildUtf16, noise, bytesOf } from './__fixtures__/moreFormats.js'

const summary = bytes => Object.fromEntries(text.parse(bytes, {}).summary.map(entry => [entry.label, entry.value]))

test('text: reports encoding, lines, endings and the longest line', () => {
  const facts = summary(buildText('one\ntwo two\nthree\n'))
  assert.equal(facts.Encoding, 'ASCII')
  assert.equal(facts.Lines, '3')
  assert.equal(facts['Line Endings'], 'LF (Unix)')
  assert.equal(facts['Longest Line'], '7 characters (line 2)')
  assert.equal(facts['Final Newline'], 'Yes')
  assert.equal(facts['Byte Order Mark'], 'No')
})

test('text: counts characters, not bytes, in UTF-8', () => {
  const facts = summary(buildText('héllo wörld ☃\nx'))
  assert.equal(facts.Encoding, 'UTF-8')
  assert.equal(facts['Longest Line'], '13 characters (line 1)')
  assert.equal(facts.Lines, '2')
  assert.equal(facts['Final Newline'], 'No')
})

test('text: recognises byte order marks and UTF-16', () => {
  assert.equal(sniffEncoding(buildText('hello there', { bom: true })), 'utf-8')
  assert.equal(sniffEncoding(buildUtf16('hello there', true)), 'utf-16le')
  assert.equal(sniffEncoding(buildUtf16('hello there', false)), 'utf-16be')
  const result = text.parse(buildUtf16('ab\r\ncd\r\n', true), {})
  const facts = Object.fromEntries(result.summary.map(entry => [entry.label, entry.value]))
  assert.equal(facts.Encoding, 'UTF-16 little-endian')
  assert.equal(facts['Line Endings'], 'CRLF (Windows)')
  assert.equal(facts.Lines, '2')
  assert.deepEqual(result.fields[0], { name: 'Byte order mark', offset: 0, length: 2, value: 'UTF-16LE', description: 'Marks the encoding and byte order', kind: 'magic' })
  assert.deepEqual(result.fields.slice(1).map(f => [f.name, f.offset, f.length]), [['Line 1', 2, 8], ['Line 2', 10, 8]])
})

test('text: mixed line endings are listed', () => {
  const facts = text.parse(buildText('a\r\nb\nc\rd'), {}).summary.find(entry => entry.label === 'Line Endings')
  assert.equal(facts.value, 'Mixed')
  assert.deepEqual(facts.details, ['LF: 1', 'CRLF: 1', 'CR: 1'])
})

test('text: does not claim binary data or tiny files', () => {
  assert.equal(sniffEncoding(bytesOf('abc', 0, 'def')), null)
  assert.equal(sniffEncoding(noise(1000)), null)
  assert.equal(sniffEncoding(buildText('A\n')), null)
  assert.equal(sniffEncoding(bytesOf('hello', 1, 2, 3, 4, ' world')), null)
  // Legacy 8-bit text: valid Latin-1 that is not UTF-8
  assert.equal(sniffEncoding(bytesOf('Caf', 0xE9, ' cr', 0xE8, 'me br', 0xFB, 'l', 0xE9, 'e. '.repeat(20))), '8-bit')
})

test('text: recognises common text formats', () => {
  const content = bytes => summary(bytes).Content
  assert.equal(content(buildText('{"a": 1, "b": [true, null]}')), 'JSON')
  assert.equal(content(buildText('#!/usr/bin/env python3\nprint(1)\n')), 'Script')
  assert.equal(content(buildText('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'SVG image')
  assert.equal(content(buildText('<!DOCTYPE html>\n<html></html>')), 'HTML document')
  assert.equal(content(buildText('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')), 'PEM certificate')
  assert.equal(content(buildText('-----BEGIN PRIVATE KEY-----\nMIIB\n')), 'PEM private key')
  assert.equal(content(buildText('just words here\n')), undefined)
})

test('text: caps line fields and accounts for the rest', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  const bytes = buildText(lines)
  const { fields } = text.parse(bytes, {})
  assert.equal(fields.length, 201)
  const more = fields[200]
  assert.match(more.name, /^… 300 more lines not shown$/)
  assert.equal(more.offset + more.length, bytes.length)
  assert.equal(more.offset, fields[199].offset + fields[199].length)
})

test('text: warns about invalid UTF-8 and NUL bytes past the sample', () => {
  const bytes = bytesOf('x'.repeat(70000), 0xC3, 'y', 0, 'z')
  const result = text.parse(bytes, {})
  assert.ok(result.warnings.some(w => /invalid UTF-8 sequence/.test(w)))
  assert.ok(result.warnings.some(w => /NUL byte/.test(w)))
})
