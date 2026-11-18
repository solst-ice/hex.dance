import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasDeceptiveCharacters, revealText, visibleText } from './visibleText.js'

const mark = code => `\u27E8U+${code}\u27E9`

test('bidirectional controls are shown as markers', () => {
  assert.equal(visibleText('invoice\u202Efdp.exe'), `invoice${mark('202E')}fdp.exe`)
  for (const code of ['202A', '202B', '202C', '202D', '202E', '2066', '2067', '2068', '2069', '200E', '200F', '061C']) {
    const ch = String.fromCodePoint(parseInt(code, 16))
    assert.equal(visibleText(`a${ch}b`), `a${mark(code)}b`, code)
    assert.ok(hasDeceptiveCharacters(`a${ch}b`), code)
  }
})

test('zero-width and other invisible format characters are shown as markers', () => {
  const codes = ['200B', '2060', '2061', '2062', '2063', '2064', 'FEFF', '00AD', '034F', '115F', '1160', '3164', 'FFA0', '17B4', '17B5', '180E',
    'FFF9', 'FFFA', 'FFFB', '2028', '2029', '206A', '206F', 'E0001', 'E0041', 'E007F']
  for (const code of codes) {
    const ch = String.fromCodePoint(parseInt(code, 16))
    assert.equal(visibleText(`a${ch}b`), `a${mark(code)}b`, code)
    assert.ok(hasDeceptiveCharacters(`a${ch}b`), code)
  }
})

test('C0 and C1 controls are marked, but tab and line breaks are kept', () => {
  for (let code = 0; code < 0x20; code++) {
    const ch = String.fromCharCode(code)
    const expected = code === 9 || code === 10 || code === 13 ? `a${ch}b` : `a${mark(code.toString(16).toUpperCase().padStart(4, '0'))}b`
    assert.equal(visibleText(`a${ch}b`), expected, String(code))
  }
  for (let code = 0x7F; code <= 0x9F; code++) {
    assert.equal(visibleText(`a${String.fromCharCode(code)}b`), `a${mark(code.toString(16).toUpperCase().padStart(4, '0'))}b`)
  }
  // Control bytes are binary data rather than disguise
  assert.deepEqual(revealText('GA$\u0001x'), { text: `GA$${mark('0001')}x`, hidden: 1, deceptive: 0 })
})

test('lone surrogates and noncharacters are marked; pairs are kept', () => {
  assert.equal(visibleText('a\uD800b'), `a${mark('D800')}b`)
  assert.equal(visibleText('a\uDC00'), `a${mark('DC00')}`)
  assert.equal(visibleText('\uDFFF\uD800'), `${mark('DFFF')}${mark('D800')}`)
  assert.equal(visibleText('a\uFFFEb\uFFFF'), `a${mark('FFFE')}b${mark('FFFF')}`)
  assert.equal(visibleText('\uD83D\uDE00'), '\uD83D\uDE00')
})

test('a literal marker bracket from the file is escaped, so a marker cannot be faked', () => {
  assert.deepEqual(revealText('\u27E8U+202E\u27E9'), { text: `${mark('27E8')}U+202E\u27E9`, hidden: 0, deceptive: 0 })
  // Only for code that cleans the same text twice
  assert.equal(visibleText(visibleText('a\u202E'), { keepMarkers: true }), `a${mark('202E')}`)
})

test('ordinary text in any script comes through unchanged', () => {
  const samples = [
    'report-2024 (final).pdf',
    'Grüße aus Köln, ½ € — “quoted” ‘text’ … ß',
    'Привет, мир', 'Γειά σου Κόσμε', 'こんにちは世界.txt', '你好，世界', '안녕하세요',
    'שלום עולם.docx', 'مرحبا بالعالم', 'سلام دنیا',
    // Persian and Hindi words that need the zero-width non-joiner and joiner
    'می\u200Cخواهم', 'क्\u200Dष', 'ಕನ್ನಡ', 'ภาษาไทย', 'ქართული', 'Հայերեն', 'ܐܪܡܝܐ', 'ދިވެހި',
    // Emoji sequences: joiners, a variation selector, a skin tone, a keycap and a flag
    '\uD83D\uDC69\u200D\uD83D\uDCBB', '\u2764\uFE0F', '\uD83D\uDC4D\uD83C\uDFFD', '1\uFE0F\u20E3', '\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08',
    // A CJK ideographic variation sequence
    '\u845B\u{E0100}',
    'tabs\tand\nlines\r\n', '', '   '
  ]
  for (const text of samples) assert.equal(visibleText(text), text, JSON.stringify(text))
})

test('joiners and variation selectors are marked where they join nothing', () => {
  assert.equal(visibleText('pay\u200Dpal'), 'pay\u200Dpal') // between two letters it is allowed
  assert.equal(visibleText('a.\u200Dexe'), `a.${mark('200D')}exe`)
  assert.equal(visibleText('\u200Cstart'), `${mark('200C')}start`)
  assert.equal(visibleText('end\u200D'), `end${mark('200D')}`)
  assert.equal(visibleText('a \uFE0F'), `a ${mark('FE0F')}`)
  assert.equal(visibleText('\uFE0Fa'), `${mark('FE0F')}a`)
})

test('anything that is not a string is returned as it is', () => {
  for (const value of [undefined, null, 5, true]) assert.equal(visibleText(value), value)
})
