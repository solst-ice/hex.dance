import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrefilter, prefilterRange } from './prefilter.js'
import { SIGNATURES } from './signatures.js'
import { fromLatin1 } from './bytes.js'
import { concat, noise } from './testFixtures.js'

const SIGS = [
  { id: 'png', keys: [{ bytes: '\x89PNG\r\n\x1a\n' }] },
  { id: 'mz', keys: [{ bytes: 'MZ' }] },
  { id: 'tar', keys: [{ bytes: 'ustar', at: 257 }] },
  { id: 'two', keys: [{ bytes: 'AB' }, { bytes: 'ABC' }] }
]

function matchesOneShot(data, prefilter) {
  const out = []
  prefilter.scan(data, 0, 0, data.length, (id, start, key) => out.push(`${id}@${start}/${key}`))
  return out
}

async function matchesChunked(data, prefilter, chunkSize) {
  const out = []
  await prefilterRange((s, e) => data.subarray(s, e), data.length, {
    prefilter,
    chunkSize,
    onMatch: (id, start, key) => out.push(`${id}@${start}/${key}`)
  })
  return out
}

test('finds keys at every offset, with the start shifted by `at`', () => {
  const p = createPrefilter(SIGS)
  const data = new Uint8Array(1200)
  data.set(fromLatin1('\x89PNG\r\n\x1a\n'), 3)
  data.set(fromLatin1('MZ'), 40)
  data.set(fromLatin1('ustar'), 300)
  data.set(fromLatin1('ustar'), 100)
  assert.deepEqual(matchesOneShot(data, p), ['png@3/3', 'mz@40/40', 'tar@43/300'])
})

test('a key whose start would be before the file is ignored', () => {
  const p = createPrefilter(SIGS)
  const data = fromLatin1('xxustarxx')
  assert.deepEqual(matchesOneShot(data, p), [])
})

test('overlapping keys with a shared prefix are all reported', () => {
  const p = createPrefilter(SIGS)
  assert.deepEqual(matchesOneShot(fromLatin1('ABCAB'), p), ['two@0/0', 'two@0/0', 'two@3/3'])
})

test('a key cut off by the end of the file is not reported; a 2-byte key in the last two bytes is', () => {
  const p = createPrefilter(SIGS)
  assert.deepEqual(matchesOneShot(fromLatin1('xx\x89PNG\r\n\x1a'), p), [])
  assert.deepEqual(matchesOneShot(fromLatin1('xxxMZ'), p), ['mz@3/3'])
})

test('chunked scanning finds keys straddling chunk boundaries exactly once', async () => {
  const p = createPrefilter(SIGS)
  const data = concat(noise(97, 4), fromLatin1('\x89PNG\r\n\x1a\n'), noise(13, 5), fromLatin1('MZ'), noise(300, 6), fromLatin1('ustar'), fromLatin1('MZ'))
  const expected = matchesOneShot(data, p)
  assert.ok(expected.length >= 3)
  for (const size of [1, 2, 3, 5, 7, 8, 64, 100, 101, 4096]) {
    assert.deepEqual(await matchesChunked(data, p, size), expected, `chunk size ${size}`)
  }
})

test('the real table: every key is found at a chunk boundary', async () => {
  const p = createPrefilter(SIGNATURES)
  for (const signature of SIGNATURES) {
    for (const key of signature.keys) {
      const bytes = fromLatin1(key.bytes)
      const at = key.at || 0
      for (const split of [1, bytes.length - 1]) {
        const offset = at + 4096 - split
        const data = new Uint8Array(offset + bytes.length + 8).fill(0xEE)
        data.set(bytes, offset)
        const found = await matchesChunked(data, p, 4096)
        assert.ok(found.includes(`${signature.id}@${offset - at}/${offset}`), `${signature.id} split at ${split}: ${found}`)
        assert.equal(found.filter(m => m === `${signature.id}@${offset - at}/${offset}`).length, 1)
      }
    }
  }
})

test('every signature has a validator, at least two key bytes and a unique id', async () => {
  const { VALIDATORS } = await import('./validate/index.js')
  const ids = new Set()
  for (const s of SIGNATURES) {
    assert.ok(!ids.has(s.id), s.id)
    ids.add(s.id)
    assert.ok(s.marker || VALIDATORS[s.id], `no validator for ${s.id}`)
    for (const k of s.keys) assert.ok(k.bytes.length >= 2, s.id)
  }
})
