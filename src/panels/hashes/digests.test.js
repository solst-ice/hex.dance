import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ALGORITHMS, Crc32, Md5, Sha1, Sha256, Sha512, hashAll } from './digests.js'

const text = (s) => new TextEncoder().encode(s)

test('known vectors', () => {
  const vectors = [
    ['', {
      md5: 'd41d8cd98f00b204e9800998ecf8427e',
      sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sha512: 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
      crc32: '00000000'
    }],
    ['abc', {
      md5: '900150983cd24fb0d6963f7d28e17f72',
      sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      sha512: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
      crc32: '352441c2'
    }],
    ['The quick brown fox jumps over the lazy dog', {
      md5: '9e107d9d372bb6826bd81d3542a419d6',
      sha1: '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12',
      crc32: '414fa339'
    }],
    ['123456789', { crc32: 'cbf43926' }]
  ]
  for (const [input, expected] of vectors) {
    const actual = hashAll(text(input))
    for (const [id, value] of Object.entries(expected)) assert.equal(actual[id], value, `${id}(${JSON.stringify(input)})`)
  }
})

test('matches node:crypto around block and padding boundaries', () => {
  const data = new Uint8Array(1200)
  for (let i = 0; i < data.length; i++) data[i] = (i * 151 + 7) & 0xff
  const lengths = [1, 55, 56, 57, 63, 64, 65, 111, 112, 113, 127, 128, 129, 255, 256, 1000, 1200]
  for (const length of lengths) {
    const slice = data.subarray(0, length)
    const ours = hashAll(slice)
    for (const id of ['md5', 'sha1', 'sha256', 'sha512']) {
      assert.equal(ours[id], createHash(id).update(slice).digest('hex'), `${id} of ${length} bytes`)
    }
  }
})

test('incremental updates in uneven pieces equal one-shot hashing', () => {
  const data = new Uint8Array(70000)
  let seed = 12345
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    data[i] = seed >>> 24
  }
  const whole = hashAll(data)
  for (const { id, create } of ALGORITHMS) {
    const hasher = create()
    let pos = 0
    let step = 1
    while (pos < data.length) {
      const end = Math.min(data.length, pos + step)
      hasher.update(data, pos, end)
      pos = end
      step = (step * 7 + 3) % 4099
    }
    assert.equal(hasher.digest(), whole[id], id)
  }
  assert.equal(whole.sha512, createHash('sha512').update(data).digest('hex'))
})

test('CRC-32 matches the bitwise definition', () => {
  const data = new Uint8Array(333)
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) ^ (i >> 3)
  let c = 0xffffffff
  for (const b of data) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  assert.equal(new Crc32().update(data).value(), (c ^ 0xffffffff) >>> 0)
})

test('classes are exported for direct use', () => {
  for (const Hasher of [Md5, Sha1, Sha256, Sha512]) assert.equal(typeof new Hasher().digest(), 'string')
})
