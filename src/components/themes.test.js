import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { THEMES } from './themes.js'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '')

// Splits a selector list at its top-level commas
function splitSelectors(list) {
  const parts = ['']
  let depth = 0
  for (const char of list) {
    if (char === '(') depth++
    if (char === ')') depth--
    if (char === ',' && depth === 0) parts.push('')
    else parts[parts.length - 1] += char
  }
  return parts.map(part => part.trim())
}

test('the pre-paint script knows the same themes and theme colours', () => {
  const init = read('../../public/theme-init.js')
  const literal = /var colors = (\{[^}]*\})/.exec(init)[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"')
  assert.deepEqual(JSON.parse(literal), Object.fromEntries(THEMES.map(theme => [theme.id, theme.color])))
})

test('every rule of the text-mode stylesheet is scoped to that theme', () => {
  const css = stripComments(read('../styles/theme-tui.css'))
  // Selectors are what precedes a "{"; at-rules and keyframe steps are not selectors
  const selectors = [...css.matchAll(/([^{};]+)\{/g)]
    .map(match => match[1].trim())
    .filter(text => text && !text.startsWith('@') && !/^(from|to|\d+%)/.test(text))
  assert.ok(selectors.length > 50)
  for (const list of selectors) {
    for (const selector of splitSelectors(list)) {
      assert.match(selector, /^:root\[data-theme="tui"\]/, `unscoped: ${selector}`)
    }
  }
})

// Contrast of the text-mode palette, worked out from the stylesheet itself
function tokens() {
  const css = stripComments(read('../styles/theme-tui.css'))
  const map = {}
  for (const block of css.matchAll(/:root\[data-theme="tui"\] \{([^}]*)\}/g)) {
    for (const [, name, value] of block[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) map[name] = value.trim()
  }
  const resolve = name => {
    const value = map[name]
    const ref = /^var\((--[\w-]+)\)$/.exec(value || '')
    return ref ? resolve(ref[1]) : value
  }
  return resolve
}

function rgb(hex) {
  const full = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, c => c + c) : hex
  return [1, 3, 5].map(i => parseInt(full.slice(i, i + 2), 16))
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('text-mode text colours keep 4.5:1 on black', () => {
  const resolve = tokens()
  const background = resolve('--darker-bg')
  const text = ['--text', '--text-muted', '--text-bright', '--neon-blue', '--neon-pink', '--neon-yellow',
    '--hd-link', '--hd-link-hover', '--hd-success', '--hd-warning', '--hd-danger', '--hx-offset', '--hx-muted',
    '--hx-detail', '--hx-modified']
  const classes = ['zero', 'print', 'ctrl', 'ff', 'high'].map(name => `--hx-byte-${name}`)
  const kinds = ['magic', 'header', 'size', 'count', 'offset', 'flags', 'string', 'checksum', 'data', 'padding', 'other']
    .map(name => `--hd-kind-${name}`)
  for (const name of [...text, ...classes, ...kinds]) {
    const value = resolve(name)
    assert.match(value, /^#[0-9a-f]{3,6}$/i, name)
    assert.ok(contrast(value, background) >= 4.5, `${name} ${value}: ${contrast(value, background).toFixed(2)}`)
  }
  // Inverse bars: black text on the bar colours
  for (const name of ['--tui-select', '--tui-bar']) assert.ok(contrast(resolve(name), '#000') >= 4.5, name)
})

test('text-mode categorical colours are all different', () => {
  const resolve = tokens()
  const kinds = ['magic', 'header', 'size', 'count', 'offset', 'flags', 'string', 'checksum', 'data', 'padding', 'other']
    .map(name => resolve(`--hd-kind-${name}`).toLowerCase())
  assert.equal(new Set(kinds).size, kinds.length)
  const classes = ['zero', 'print', 'ctrl', 'ff', 'high'].map(name => resolve(`--hx-byte-${name}`).toLowerCase())
  assert.equal(new Set(classes).size, classes.length)
})
