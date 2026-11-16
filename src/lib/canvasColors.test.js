import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hexString, parseCssColor, rampTable, rgbString, resolveColor } from './canvasColors.js'

test('parseCssColor reads hex colours in every length', () => {
  assert.deepEqual(parseCssColor('#0ff'), [0, 255, 255, 1])
  assert.deepEqual(parseCssColor('#FF36AB'), [255, 54, 171, 1])
  assert.deepEqual(parseCssColor('#0ff8'), [0, 255, 255, 0.533])
  assert.deepEqual(parseCssColor('#00000080'), [0, 0, 0, 0.502])
  assert.equal(parseCssColor('#12345'), null)
})

test('parseCssColor reads rgb() and rgba() with commas, spaces and percentages', () => {
  assert.deepEqual(parseCssColor('rgb(10, 20, 30)'), [10, 20, 30, 1])
  assert.deepEqual(parseCssColor('rgba(0, 255, 255, 0.25)'), [0, 255, 255, 0.25])
  assert.deepEqual(parseCssColor('rgb(10 20 30 / 50%)'), [10, 20, 30, 0.5])
  assert.deepEqual(parseCssColor('rgb(100% 0% 50%)'), [255, 0, 127.5, 1])
  assert.deepEqual(parseCssColor('rgba(300, -4, 0, 2)'), [255, 0, 0, 1])
})

test('parseCssColor reads color(srgb ...), which browsers compute for color-mix()', () => {
  assert.deepEqual(parseCssColor('color(srgb 0 1 1 / 0.22)'), [0, 255, 255, 0.22])
  assert.deepEqual(parseCssColor('color(srgb 1 0.5 0)'), [255, 127.5, 0, 1])
})

test('parseCssColor rejects what it cannot read', () => {
  for (const text of ['', null, undefined, 'var(--x)', 'color-mix(in srgb, #0ff 20%, transparent)', 'red', 'rgb(a, b, c)']) {
    assert.equal(parseCssColor(text), null, String(text))
  }
})

test('rgbString and hexString format for canvases and SVG', () => {
  assert.equal(rgbString([0, 255, 255]), 'rgb(0, 255, 255)')
  assert.equal(rgbString([255, 54, 171], 0.28), 'rgba(255, 54, 171, 0.28)')
  assert.equal(rgbString([127.5, 0.2, 254.6]), 'rgb(128, 0, 255)')
  assert.equal(hexString([255, 176, 0]), '#ffb000')
  assert.equal(hexString([300, -1, 15.4]), '#ff000f')
})

test('rampTable runs through its stops', () => {
  const table = rampTable([[0, 0, 0], [255, 255, 255]])
  assert.equal(table.length, 768)
  assert.deepEqual([...table.slice(0, 3)], [0, 0, 0])
  assert.deepEqual([...table.slice(765)], [255, 255, 255])
  const three = rampTable([[0, 0, 0], [255, 0, 0], [255, 255, 0]])
  assert.deepEqual([...three.slice(765)], [255, 255, 0])
  assert.equal(three[127 * 3], 254)
})

test('resolveColor parses plain colours without a DOM and gives up otherwise', () => {
  assert.deepEqual(resolveColor('#0ff'), [0, 255, 255, 1])
  assert.equal(resolveColor('var(--neon-blue)'), null)
  assert.equal(resolveColor(''), null)
})
