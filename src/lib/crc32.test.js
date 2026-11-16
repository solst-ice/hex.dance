import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { Crc32, crc32, oggCrc32 } from './crc32.js'

const ascii = text => new Uint8Array([...text].map(c => c.charCodeAt(0)))

function noise(length, seed = 7) {
  const out = new Uint8Array(length)
  let x = seed
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

test('crc32 matches the check value and zlib', () => {
  assert.equal(crc32(ascii('123456789')), 0xcbf43926)
  assert.equal(crc32(new Uint8Array(0)), 0)
  for (const length of [1, 7, 8, 9, 63, 1000, 65537]) {
    const data = noise(length, length)
    assert.equal(crc32(data), zlib.crc32(data), `length ${length}`)
  }
})

test('crc32 takes a range, clips it, continues a previous value and accepts plain arrays', () => {
  const data = noise(5000)
  assert.equal(crc32(data, 100, 900), zlib.crc32(data.subarray(100, 900)))
  assert.equal(crc32(data, 4000, 99999), zlib.crc32(data.subarray(4000)))
  assert.equal(crc32(data, -5, 10), zlib.crc32(data.subarray(0, 10)))
  assert.equal(crc32(data, 10, 5), 0)
  assert.equal(crc32(null), 0)
  assert.equal(crc32(data, 1234, 5000, crc32(data, 0, 1234)), zlib.crc32(data))
  assert.equal(crc32(Array.from(data.subarray(0, 77))), zlib.crc32(data.subarray(0, 77)))
})

test('Crc32 hashes data that arrives in pieces', () => {
  const data = noise(100000)
  const crc = new Crc32()
  for (let at = 0; at < data.length; at += 4093) crc.update(data, at, Math.min(data.length, at + 4093))
  assert.equal(crc.value(), zlib.crc32(data))
  assert.equal(crc.digest(), zlib.crc32(data).toString(16).padStart(8, '0'))
  assert.equal(new Crc32().digest(), '00000000')
  assert.equal(new Crc32().update(ascii('123456789')).value(), 0xcbf43926)
})

test('oggCrc32 is the non-reflected CRC that Ogg pages use', () => {
  // Bitwise reference: polynomial 0x04C11DB7, MSB first, initial 0, no final xor
  const reference = bytes => {
    let c = 0
    for (const b of bytes) {
      c ^= b << 24
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
    }
    return c >>> 0
  }
  assert.equal(oggCrc32(ascii('123456789')), 0x89a1897f)
  const data = noise(3000)
  assert.equal(oggCrc32(data), reference(data))
  assert.equal(oggCrc32(data, 500, 1500), reference(data.subarray(500, 1500)))
  assert.equal(oggCrc32(data, 1000, 3000, oggCrc32(data, 0, 1000)), reference(data))
  assert.notEqual(oggCrc32(data), crc32(data))
})
