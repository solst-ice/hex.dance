import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { inflateCheck, buildTable } from './inflate.js'
import { adler32 } from './bytes.js'
import { crc32 } from '../../lib/crc32.js'
import { concat, noise } from './testFixtures.js'

const text = new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(400))
const inputs = [new Uint8Array(0), text, noise(70000, 3), concat(text, noise(5000, 4), text)]

test('decodes stored, fixed and dynamic blocks to the right end and checksum', () => {
  for (const data of inputs) {
    for (const level of [0, 1, 6, 9]) {
      for (const strategy of [0, 4]) {
        const raw = deflateRawSync(data, { level, strategy })
        const padded = concat(raw, noise(10, 9))
        const result = inflateCheck(padded, 0, { checksum: 'crc', inputFinal: true })
        assert.equal(result.status, 'ok', `level ${level} strategy ${strategy}: ${result.reason}`)
        assert.equal(result.end, raw.length)
        assert.equal(result.outSize, data.length)
        assert.equal(result.check, crc32(data))
      }
    }
  }
})

test('the Adler-32 matches a zlib trailer', () => {
  const z = deflateSync(text)
  const result = inflateCheck(z, 2, { checksum: 'adler', inputFinal: true })
  assert.equal(result.status, 'ok')
  assert.equal(result.check, adler32(text))
  assert.equal(result.end, z.length - 4)
})

test('asks for more input when the window ends mid-stream, and errors at the end of the file', () => {
  const raw = deflateRawSync(noise(50000, 7), { level: 0 })
  assert.equal(inflateCheck(raw.subarray(0, 1000), 0).status, 'more')
  const final = inflateCheck(raw.subarray(0, 1000), 0, { inputFinal: true })
  assert.equal(final.status, 'error')
  assert.equal(final.reason, 'unexpected end of data')
})

test('random bytes fail quickly', () => {
  let ok = 0
  for (let seed = 1; seed <= 500; seed++) {
    const result = inflateCheck(noise(4096, seed), 0, { checksum: 'adler', inputFinal: true })
    if (result.status === 'ok') ok++
    assert.ok(result.outSize < 4096 * 8)
  }
  assert.ok(ok < 25, `${ok} random streams decoded`)
})

test('rejects over-subscribed Huffman codes and allows a single one-bit code', () => {
  assert.throws(() => buildTable(Uint8Array.from([1, 1, 1]), 3))
  assert.throws(() => buildTable(Uint8Array.from([2, 2, 2]), 3))
  assert.equal(buildTable(Uint8Array.from([1, 0]), 2).max, 1)
})
