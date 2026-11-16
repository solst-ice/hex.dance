import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readInt, readFloat, formatFloat, formatBits, describeAscii, readUtf8, formatCodePoint,
  readLeb128, formatUnixSeconds, describeTime64, readDosDateTime, readGuid, readColor, inspect
} from './decode.js'

const b = (...values) => Uint8Array.from(values)

test('integers in both byte orders', () => {
  const bytes = b(0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08)
  assert.deepEqual(readInt(bytes, 0, 1, true), { unsigned: 1, signed: 1 })
  assert.deepEqual(readInt(bytes, 0, 2, true), { unsigned: 0x0201, signed: 0x0201 })
  assert.deepEqual(readInt(bytes, 0, 2, false), { unsigned: 0x0102, signed: 0x0102 })
  assert.deepEqual(readInt(bytes, 0, 4, true), { unsigned: 0x04030201, signed: 0x04030201 })
  assert.deepEqual(readInt(bytes, 0, 4, false), { unsigned: 0x01020304, signed: 0x01020304 })
  assert.deepEqual(readInt(bytes, 0, 8, true), { unsigned: 0x0807060504030201n, signed: 0x0807060504030201n })
  assert.deepEqual(readInt(bytes, 0, 8, false), { unsigned: 0x0102030405060708n, signed: 0x0102030405060708n })
})

test('signed values and 64-bit extremes are exact', () => {
  assert.deepEqual(readInt(b(0xff), 0, 1, true), { unsigned: 255, signed: -1 })
  assert.deepEqual(readInt(b(0x80), 0, 1, true), { unsigned: 128, signed: -128 })
  assert.deepEqual(readInt(b(0x00, 0x80), 0, 2, true), { unsigned: 32768, signed: -32768 })
  assert.deepEqual(readInt(b(0xff, 0xff, 0xff, 0xff), 0, 4, true), { unsigned: 4294967295, signed: -1 })
  const ones = new Uint8Array(8).fill(0xff)
  assert.deepEqual(readInt(ones, 0, 8, true), { unsigned: 18446744073709551615n, signed: -1n })
  const minLe = b(0, 0, 0, 0, 0, 0, 0, 0x80)
  assert.deepEqual(readInt(minLe, 0, 8, true), { unsigned: 9223372036854775808n, signed: -9223372036854775808n })
  const maxBe = b(0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)
  assert.deepEqual(readInt(maxBe, 0, 8, false), { unsigned: 9223372036854775807n, signed: 9223372036854775807n })
  // 2^53 + 1 is not representable as a Number; BigInt keeps it
  const big = b(0x01, 0, 0, 0, 0, 0, 0x20, 0)
  assert.equal(readInt(big, 0, 8, true).unsigned, 9007199254740993n)
})

test('reads at the last bytes of the file, null past the end', () => {
  const bytes = b(0xaa, 0xbb, 0xcc, 0xdd)
  assert.deepEqual(readInt(bytes, 3, 1, true), { unsigned: 0xdd, signed: -35 })
  assert.equal(readInt(bytes, 3, 2, true), null)
  assert.deepEqual(readInt(bytes, 2, 2, false), { unsigned: 0xccdd, signed: 0xccdd - 0x10000 })
  assert.deepEqual(readInt(bytes, 0, 4, false).unsigned, 0xaabbccdd)
  assert.equal(readInt(bytes, 1, 4, true), null)
  assert.equal(readInt(bytes, 0, 8, true), null)
  assert.equal(readInt(bytes, 4, 1, true), null)
  assert.equal(readInt(new Uint8Array(0), 0, 1, true), null)
  assert.equal(readFloat(bytes, 1, 4, true), null)
})

test('works on a view with a byte offset', () => {
  const backing = b(0, 0, 0x34, 0x12)
  const view = backing.subarray(2)
  assert.equal(readInt(view, 0, 2, true).unsigned, 0x1234)
})

test('floats', () => {
  assert.equal(readFloat(b(0x00, 0x00, 0x80, 0x3f), 0, 4, true), 1)
  assert.equal(readFloat(b(0x3f, 0x80, 0x00, 0x00), 0, 4, false), 1)
  assert.equal(readFloat(b(0, 0, 0, 0, 0, 0, 0xf0, 0x3f), 0, 8, true), 1)
  const third = readFloat(b(0xab, 0xaa, 0xaa, 0x3e), 0, 4, true)
  assert.equal(formatFloat(third, 4), '0.33333334')
  assert.equal(formatFloat(0.1, 8), '0.1')
  const tenth32 = readFloat(b(0xcd, 0xcc, 0xcc, 0x3d), 0, 4, true)
  assert.equal(formatFloat(tenth32, 4), '0.1')
  assert.equal(formatFloat(NaN, 4), 'NaN')
  assert.equal(formatFloat(Infinity, 8), '+Infinity')
  assert.equal(formatFloat(-Infinity, 4), '-Infinity')
  assert.equal(formatFloat(-0, 8), '-0')
  const maxF32 = readFloat(b(0xff, 0xff, 0x7f, 0x7f), 0, 4, true)
  assert.equal(formatFloat(maxF32, 4), '3.4028235e+38')
  const minSub = readFloat(b(1, 0, 0, 0), 0, 4, true)
  assert.equal(formatFloat(minSub, 4), '1e-45')
})

test('bits and ASCII', () => {
  assert.equal(formatBits(0x41), '0100 0001')
  assert.equal(formatBits(0), '0000 0000')
  assert.equal(describeAscii(0x41), "'A'")
  assert.equal(describeAscii(0), 'NUL')
  assert.equal(describeAscii(0x0a), 'LF')
  assert.equal(describeAscii(0x20), 'space')
  assert.equal(describeAscii(0x7f), 'DEL')
  assert.equal(describeAscii(0xe9), 'not ASCII')
})

test('UTF-8 code points', () => {
  assert.deepEqual(readUtf8(b(0x41), 0), { codePoint: 0x41, length: 1 })
  assert.deepEqual(readUtf8(b(0xc3, 0xa9), 0), { codePoint: 0xe9, length: 2 })
  assert.deepEqual(readUtf8(b(0xe2, 0x82, 0xac), 0), { codePoint: 0x20ac, length: 3 })
  assert.deepEqual(readUtf8(b(0xf0, 0x9f, 0x98, 0x80), 0), { codePoint: 0x1f600, length: 4 })
  assert.deepEqual(readUtf8(b(0xf4, 0x8f, 0xbf, 0xbf), 0), { codePoint: 0x10ffff, length: 4 })
  assert.equal(readUtf8(b(0x80), 0).error, 'continuation')
  assert.equal(readUtf8(b(0xc0, 0x80), 0).error, 'bad lead byte')
  assert.equal(readUtf8(b(0xe0, 0x80, 0x80), 0).error, 'overlong')
  assert.equal(readUtf8(b(0xed, 0xa0, 0x80), 0).error, 'surrogate')
  assert.equal(readUtf8(b(0xf4, 0x90, 0x80, 0x80), 0).error, '> U+10FFFF')
  assert.equal(readUtf8(b(0xf5, 0x80), 0).error, 'bad lead byte')
  assert.equal(readUtf8(b(0xe2, 0x41, 0x41), 0).error, 'truncated')
  // A sequence cut off by the end of the file is unavailable, not invalid
  assert.equal(readUtf8(b(0x41, 0xe2, 0x82), 1), null)
  assert.equal(readUtf8(b(0x41), 1), null)
  assert.equal(formatCodePoint(0x20ac), 'U+20AC €')
  assert.equal(formatCodePoint(0x0a), 'U+000A')
})

test('LEB128', () => {
  assert.deepEqual(readLeb128(b(0xe5, 0x8e, 0x26), 0, false), { value: 624485n, length: 3 })
  assert.deepEqual(readLeb128(b(0xc0, 0xbb, 0x78), 0, true), { value: -123456n, length: 3 })
  assert.deepEqual(readLeb128(b(0x02), 0, true), { value: 2n, length: 1 })
  assert.deepEqual(readLeb128(b(0x7e), 0, true), { value: -2n, length: 1 })
  assert.deepEqual(readLeb128(b(0x7f), 0, false), { value: 127n, length: 1 })
  assert.deepEqual(readLeb128(b(0x80, 0x7f), 0, true), { value: -128n, length: 2 })
  const maxU64 = b(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01)
  assert.deepEqual(readLeb128(maxU64, 0, false), { value: 18446744073709551615n, length: 10 })
  const minI64 = b(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f)
  assert.deepEqual(readLeb128(minI64, 0, true), { value: -9223372036854775808n, length: 10 })
  assert.equal(readLeb128(b(0x80, 0x80), 0, false), null)
  assert.equal(readLeb128(b(0x05), 1, false), null)
  assert.equal(readLeb128(new Uint8Array(11).fill(0x80), 0, false).error, 'longer than 10 bytes')
})

test('Unix and 64-bit times', () => {
  assert.equal(formatUnixSeconds(0), null)
  assert.equal(formatUnixSeconds(1700000000), '2023-11-14 22:13:20 UTC')
  assert.equal(formatUnixSeconds(4294967295), null)
  assert.deepEqual(describeTime64(1700000000n), { text: '2023-11-14 22:13:20 UTC', unit: 's' })
  assert.deepEqual(describeTime64(1700000000123n), { text: '2023-11-14 22:13:20.123 UTC', unit: 'ms' })
  // 2023-11-14 22:13:20 UTC as a Windows FILETIME
  assert.deepEqual(describeTime64(133444736000000000n), { text: '2023-11-14 22:13:20 UTC', unit: 'FILETIME' })
  assert.equal(describeTime64(0n), null)
  assert.equal(describeTime64(18446744073709551615n), null)
})

test('DOS date and time', () => {
  // 2021-06-15 13:45:30: time 0x6daf, date 0x52cf, both little-endian
  assert.deepEqual(readDosDateTime(b(0xaf, 0x6d, 0xcf, 0x52), 0), { text: '2021-06-15 13:45:30' })
  assert.equal(readDosDateTime(b(0, 0, 0, 0), 0).error, 'invalid')
  // 1981-02-29 does not exist
  assert.equal(readDosDateTime(b(0, 0, 0x5d, 0x02), 0).error, 'invalid')
  assert.equal(readDosDateTime(b(1, 2, 3), 0), null)
})

test('GUID in both layouts', () => {
  const bytes = b(0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff)
  assert.equal(readGuid(bytes, 0, true), '{00112233-4455-6677-8899-aabbccddeeff}')
  assert.equal(readGuid(bytes, 0, false), '{33221100-5544-7766-8899-aabbccddeeff}')
  assert.equal(readGuid(bytes, 1, true), null)
})

test('colours', () => {
  assert.deepEqual(readColor(b(0xff, 0x80, 0x00, 0x40), 0, false), { hex: '#ff8000', css: '#ff8000' })
  assert.deepEqual(readColor(b(0xff, 0x80, 0x00, 0x40), 0, true), { hex: '#ff800040', css: '#ff800040' })
  assert.equal(readColor(b(0xff, 0x80, 0x00), 0, true), null)
})

test('inspect: every entry names its bytes; unavailable values are null', () => {
  const bytes = b(0x41, 0x42)
  const entries = inspect(bytes, 1, true)
  const byId = Object.fromEntries(entries.map(e => [e.id, e]))
  assert.equal(byId.int8.value, '66')
  assert.equal(byId.int8.start, 1)
  assert.equal(byId.int8.length, 1)
  assert.equal(byId.int16.value, null)
  assert.equal(byId.int64.value, null)
  assert.equal(byId.float32.value, null)
  assert.equal(byId.ascii.value, "'B'")
  assert.equal(byId.utf8.value, 'U+0042 B')
  assert.equal(byId.leb128.value, '66 / -62')
  assert.equal(byId.leb128.length, 1)
  assert.equal(byId.guid.value, null)
  assert.equal(byId.color.value, null)
  for (const entry of entries) assert.ok(entry.length >= 1)

  const empty = inspect(new Uint8Array(0), 0, true)
  assert.ok(empty.every(e => e.value === null))
})

test('inspect: signed and unsigned shown together when they differ', () => {
  const byId = Object.fromEntries(inspect(new Uint8Array(8).fill(0xff), 0, false).map(e => [e.id, e]))
  assert.equal(byId.int8.value, '255 / -1')
  assert.equal(byId.int64.value, '18446744073709551615 / -1')
  assert.equal(byId.int64.length, 8)
  assert.equal(byId.color.value, '#ffffffff')
  assert.equal(byId.color.length, 4)
})

test('inspect: colour falls back to RGB when only three bytes remain', () => {
  const byId = Object.fromEntries(inspect(Uint8Array.from([0, 0x10, 0x20, 0x30]), 1, true).map(e => [e.id, e]))
  assert.equal(byId.color.value, '#102030')
  assert.equal(byId.color.length, 3)
  assert.equal(byId.color.colorAlpha, undefined)
})
