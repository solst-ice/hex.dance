import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHex, parseText, parseNumberQuery, parseNumber, encodeInteger } from './pattern.js'
import { findAll, startSearch, stepMatch, firstAfter, chooseAnchor, byteWeights, planPattern, chunkPositions, CHUNK_WORK } from './scanner.js'

const enc = (s) => new TextEncoder().encode(s)
const offsetsOf = (list) => Array.from(list.offsets.subarray(0, list.count))

// Brute-force reference: every start where a pattern matches
function naive(bytes, patterns, kinds = null) {
  const out = []
  for (let i = 0; i < bytes.length; i++) {
    for (let p = 0; p < patterns.length; p++) {
      const { values, alt, mask } = patterns[p]
      if (i + values.length > bytes.length) continue
      let ok = true
      for (let j = 0; j < values.length && ok; j++) {
        ok = !mask[j] || bytes[i + j] === values[j] || bytes[i + j] === alt[j]
      }
      if (ok) { out.push(i); kinds?.push(p); break }
    }
  }
  return out
}

function random(n, seed = 1) {
  const out = new Uint8Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    out[i] = s >>> 24
  }
  return out
}

test('hex parsing: spaces, 0x prefixes, wildcards and errors', () => {
  const p = parseHex('7f 45 4c 46').patterns[0]
  assert.deepEqual(Array.from(p.values), [0x7f, 0x45, 0x4c, 0x46])
  const w = parseHex('ffd8ff??').patterns[0]
  assert.deepEqual(Array.from(w.mask), [1, 1, 1, 0])
  assert.deepEqual(Array.from(parseHex('0x7f, 0x45').patterns[0].values), [0x7f, 0x45])
  assert.equal(parseHex('').ok, false)
  assert.equal(parseHex('').empty, true)
  assert.match(parseHex('7f4').error, /Odd/)
  assert.match(parseHex('zz').error, /"z"/)
  assert.match(parseHex('7?').error, /\?\?/)
  assert.match(parseHex('?? ??').error, /at least one/)
})

test('number parsing and encodings that fit', () => {
  assert.equal(parseNumber('0x10'), 16n)
  assert.equal(parseNumber('-5'), -5n)
  assert.equal(parseNumber('1_000'), 1000n)
  assert.equal(parseNumber('12a'), null)
  assert.deepEqual(Array.from(encodeInteger(-2n, 16, true)), [0xfe, 0xff])
  assert.deepEqual(Array.from(encodeInteger(0x1234n, 32, false)), [0, 0, 0x12, 0x34])
  assert.equal(encodeInteger(256n, 8, true), null)
  assert.equal(encodeInteger(-129n, 8, true), null)
  assert.deepEqual(Array.from(encodeInteger(-128n, 8, true)), [0x80])
  assert.deepEqual(Array.from(encodeInteger(18446744073709551615n, 64, true)), Array(8).fill(0xff))
  assert.equal(encodeInteger(18446744073709551616n, 64, true), null)

  const labels = parseNumberQuery('1000').patterns.map(p => p.label)
  assert.deepEqual(labels, ['64-bit LE', '64-bit BE', '32-bit LE', '32-bit BE', '16-bit LE', '16-bit BE'])
  // Palindromic encodings are searched once
  assert.deepEqual(parseNumberQuery('0', { widths: [16, 8] }).patterns.map(p => p.label), ['16-bit LE', '8-bit'])
  assert.match(parseNumberQuery('70000', { widths: [8, 16] }).error, /does not fit/)
  assert.match(parseNumberQuery('abc').error, /Not a number/)
})

test('text patterns: UTF-8 and UTF-16LE, case folding only for A-Z', () => {
  const { patterns } = parseText('Hé', { ignoreCase: true })
  assert.deepEqual(patterns.map(p => p.label), ['UTF-8', 'UTF-16LE'])
  assert.deepEqual(Array.from(patterns[0].values), [0x48, 0xc3, 0xa9])
  assert.deepEqual(Array.from(patterns[0].alt), [0x68, 0xc3, 0xa9])
  assert.deepEqual(Array.from(patterns[1].values), [0x48, 0, 0xe9, 0])
  assert.deepEqual(Array.from(patterns[1].alt), [0x68, 0, 0xe9, 0])
  // U+0141 (Ł) has 0x41 as its low byte; it must not fold to U+0161
  const l = parseText('Ł', { ignoreCase: true, utf8: false }).patterns[0]
  assert.deepEqual(Array.from(l.alt), [0x41, 0x01])
  assert.equal(parseText('abc').patterns[0].label, 'ASCII')
  assert.equal(parseText('x', { utf8: false, utf16: false }).ok, false)
})

test('overlapping matches are all reported', () => {
  const bytes = enc('aaaaa')
  assert.deepEqual(offsetsOf(findAll(bytes, parseText('aa', { utf16: false }).patterns)), [0, 1, 2, 3])
  assert.deepEqual(offsetsOf(findAll(enc('abababa'), parseText('aba', { utf16: false }).patterns)), [0, 2, 4])
})

test('wildcards, including a leading wildcard', () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd8])
  assert.deepEqual(offsetsOf(findAll(bytes, parseHex('ffd8ff??').patterns)), [0, 5])
  assert.deepEqual(offsetsOf(findAll(bytes, parseHex('?? d8').patterns)), [0, 5, 9])
  assert.deepEqual(offsetsOf(findAll(bytes, parseHex('d8 ?? ??').patterns)), [1, 6])
})

test('matches spanning chunk boundaries', () => {
  const bytes = random(1000, 7)
  const needle = Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55])
  const at = [0, 59, 64, 123, 128, 995]
  for (const offset of at) bytes.set(needle, offset)
  const patterns = parseHex('11 22 33 44 55').patterns
  for (const chunkSize of [1, 2, 3, 64, 100, 4096]) {
    assert.deepEqual(offsetsOf(findAll(bytes, patterns, { chunkSize })), at)
  }
})

test('case-insensitive text and UTF-16 agree with a brute-force scan', () => {
  const text = 'xx HeLLo hello HELLO\0 H\0e\0L\0l\0O\0 hellohello h\0e\0l\0l\0'
  const bytes = enc(text)
  const insensitive = parseText('hello', { ignoreCase: true }).patterns
  const found = offsetsOf(findAll(bytes, insensitive, { chunkSize: 5 }))
  assert.deepEqual(found, naive(bytes, insensitive))
  assert.equal(found.length, 6)
  const sensitive = parseText('hello').patterns
  assert.deepEqual(offsetsOf(findAll(bytes, sensitive)), [9, 33, 38])
})

test('random data with many patterns matches brute force', () => {
  const bytes = random(50000, 3)
  const cases = [
    parseHex('00').patterns,
    parseHex('?? 7f').patterns,
    parseHex('41 ?? 42').patterns,
    parseNumberQuery('255').patterns,
    parseNumberQuery('-1', { widths: [8, 16] }).patterns,
    parseText('ab', { ignoreCase: true }).patterns
  ]
  for (const patterns of cases) {
    for (const chunkSize of [7, 1000, 1 << 20]) {
      assert.deepEqual(offsetsOf(findAll(bytes, patterns, { chunkSize })), naive(bytes, patterns))
    }
  }
})

test('the earliest pattern names a match where several start at one offset', () => {
  const bytes = Uint8Array.from([0xe8, 0x03, 0x00, 0x00, 0xe8, 0x03, 0x01])
  const list = findAll(bytes, parseNumberQuery('1000', { widths: [32, 16], big: false }).patterns)
  assert.deepEqual(offsetsOf(list), [0, 4])
  assert.deepEqual(Array.from(list.kinds.subarray(0, 2)), [0, 1])
})

test('cap stops the scan and is reported', () => {
  const list = findAll(new Uint8Array(100), parseHex('00').patterns, { cap: 10 })
  assert.equal(list.count, 10)
  assert.ok(list.full)
})

test('anchor avoids wildcards, case pairs and filler bytes', () => {
  assert.equal(chooseAnchor(parseHex('00 ?? 41').patterns[0]).index, 2)
  assert.equal(chooseAnchor(parseText('a1', { ignoreCase: true, utf16: false }).patterns[0]).index, 1)
  // UTF-16 'ab' ignoring case: a letter, not the zero high byte
  assert.equal(chooseAnchor(parseText('ab', { ignoreCase: true, utf8: false }).patterns[0]).index, 0)
})

test('time-sliced search streams progress and can be cancelled', async () => {
  const bytes = random(300000, 5)
  const patterns = parseHex('00').patterns
  let clock = 0
  const now = () => (clock += 1)
  const schedule = (fn) => setTimeout(fn, 0)

  const done = await new Promise(resolve => {
    let progress = 0
    startSearch(bytes, patterns, {
      chunkSize: 1000, sliceMs: 5, now, schedule,
      onProgress: () => progress++,
      onDone: (list, info) => resolve({ list, info, progress })
    })
  })
  assert.ok(done.progress > 10)
  assert.deepEqual(offsetsOf(done.list), naive(bytes, patterns))
  assert.equal(done.info.capped, false)

  let finished = false
  let progressed = 0
  const search = startSearch(bytes, patterns, {
    chunkSize: 1000, sliceMs: 5, now, schedule,
    onProgress: () => { if (++progressed === 3) search.cancel() },
    onDone: () => { finished = true }
  })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(finished, false)
  assert.equal(progressed, 3)
  assert.ok(search.list.count < done.list.count)
})

test('empty and tiny inputs', () => {
  assert.equal(findAll(new Uint8Array(0), parseHex('00').patterns).count, 0)
  assert.equal(findAll(Uint8Array.from([1]), parseHex('01 02').patterns).count, 0)
  assert.deepEqual(offsetsOf(findAll(Uint8Array.from([1, 2]), parseHex('01 02').patterns)), [0])
})

test('stepping wraps around', () => {
  const offsets = Float64Array.from([10, 20, 30])
  assert.equal(stepMatch(offsets, 3, 0, 1), 0)
  assert.equal(stepMatch(offsets, 3, 10, 1), 1)
  assert.equal(stepMatch(offsets, 3, 15, 1), 1)
  assert.equal(stepMatch(offsets, 3, 30, 1), 0)
  assert.equal(stepMatch(offsets, 3, 10, -1), 2)
  assert.equal(stepMatch(offsets, 3, 25, -1), 1)
  assert.equal(stepMatch(offsets, 3, 99, -1), 2)
  assert.equal(stepMatch(offsets, 0, 5, 1), -1)
  assert.equal(firstAfter(offsets, 3, 20, true), 1)
  assert.equal(firstAfter(offsets, 3, 20), 2)
})

test('anchor is the rarest fixed byte in the file, not the first', () => {
  // Mostly zeros with a few 0xff: a long run of zeros ending in ff anchors on the ff
  const bytes = new Uint8Array(100000)
  for (let i = 500; i < bytes.length; i += 9000) bytes[i] = 0xff
  const weights = byteWeights(bytes)
  const pattern = parseHex('00'.repeat(1023) + 'ff').patterns[0]
  assert.equal(chooseAnchor(pattern, weights).index, 1023)
  // Text full of 'e': a case pair of rarer letters wins over a common fixed byte
  const text = enc('e'.repeat(5000) + 'Qz')
  const word = parseText('eqz', { utf16: false }).patterns[0]
  assert.equal(chooseAnchor(word, byteWeights(text)).index, 1)
  // The other fixed bytes are checked rarest first
  const plan = planPattern(parseHex('00 ff 41 ?? 00').patterns[0], weights)
  assert.equal(plan.anchor.index, 2)
  assert.deepEqual(Array.from(plan.order), [1, 0, 4])
})

test('rarest-first scanning gives the same matches, kinds and order as brute force', () => {
  const sparse = new Uint8Array(40000)
  for (let i = 1023; i < sparse.length; i += 3001) sparse[i] = 0xff
  sparse.fill(0x41, 20000, 20100)
  const mixed = random(30000, 11)
  mixed.fill(0, 1000, 5000)
  mixed.set(enc('Hello hELLO h\0e\0l\0l\0o\0'), 7000)
  const cases = [
    [sparse, parseHex('00'.repeat(1023) + 'ff').patterns],
    [sparse, parseHex('00'.repeat(1024)).patterns],
    [sparse, parseHex('00 ?? 00 ff').patterns],
    [sparse, parseHex('41'.repeat(50) + ' ?? 00').patterns],
    [mixed, parseHex('00'.repeat(300) + ' ?? ' + '00'.repeat(20)).patterns],
    [mixed, parseText('hello', { ignoreCase: true }).patterns],
    [mixed, parseText('hello').patterns],
    [mixed, parseNumberQuery('0').patterns],
    [mixed, parseNumberQuery('-1', { widths: [8, 16, 32] }).patterns]
  ]
  for (const [bytes, patterns] of cases) {
    const kinds = []
    const expected = naive(bytes, patterns, kinds)
    for (const chunkSize of [13, 4096, 1 << 20]) {
      const list = findAll(bytes, patterns, { chunkSize })
      assert.deepEqual(offsetsOf(list), expected)
      assert.deepEqual(Array.from(list.kinds.subarray(0, list.count)), kinds)
    }
  }
})

test('chunks shrink with the pattern so one slice stays bounded', async () => {
  assert.equal(chunkPositions(parseHex('00').patterns, 256 * 1024), 256 * 1024)
  const long = parseHex('00'.repeat(1023) + 'ff').patterns
  assert.ok(chunkPositions(long, 256 * 1024) * 1024 <= CHUNK_WORK)
  // Worst case: every offset of a zero file is a candidate for a 1024-byte
  // run of zeros. A clock that moves on every reading makes each slice scan
  // exactly one chunk, so the progress steps show the work per slice.
  const bytes = new Uint8Array(1 << 19)
  const patterns = parseHex('00'.repeat(1024)).patterns
  let clock = 0
  const steps = []
  let last = 0
  const done = await new Promise(resolve => {
    startSearch(bytes, patterns, {
      sliceMs: 1,
      cap: bytes.length,
      now: () => (clock += 1),
      schedule: fn => setTimeout(fn, 0),
      onProgress: (list, scanned) => { steps.push(scanned - last); last = scanned },
      onDone: list => resolve(list)
    })
  })
  assert.ok(steps.length > 100)
  for (const positions of steps) assert.ok(positions * 1024 <= CHUNK_WORK)
  assert.equal(done.count, bytes.length - 1023)
})

test('a time-sliced search finds what findAll finds', async () => {
  const bytes = random(200000, 9)
  bytes.fill(0, 50000, 60000)
  for (const patterns of [parseHex('00'.repeat(200) + '??').patterns, parseText('ab', { ignoreCase: true }).patterns]) {
    const list = await new Promise(resolve => startSearch(bytes, patterns, { schedule: fn => setTimeout(fn, 0), onDone: resolve }))
    const reference = findAll(bytes, patterns)
    assert.deepEqual(offsetsOf(list), offsetsOf(reference))
    assert.deepEqual(Array.from(list.kinds.subarray(0, list.count)), Array.from(reference.kinds.subarray(0, reference.count)))
  }
})
