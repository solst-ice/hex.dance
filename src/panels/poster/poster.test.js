import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanText, escapeXml, truncate, posterBaseName } from './escape.js'
import { planPoster, planRows, topLevelChoices, COLLAPSE_MIN } from './plan.js'
import { fieldRuns, runShapes, flowColumns } from './layout.js'
import { buildPoster } from './render.js'
import { assignShades, posterColors, parseColor } from './palette.js'

const HOSTILE = 'evil<script>alert(1)</script>&amp;"\'\u0000\u0007\u202e\ud800]]><!--'

function bytesOf(n, fill = i => i & 0xff) {
  return Uint8Array.from({ length: n }, (_, i) => fill(i))
}

function analysisWith(fields, extra = {}) {
  return { formatId: 'test', formatName: 'Test format', category: 'data', summary: [], fields, regions: [], symbols: [], entries: [], warnings: [], ...extra }
}

const overlaps = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01

// Minimal well-formedness check: balanced tags, no raw '<' or '&' in text
function assertWellFormed(svg) {
  const body = svg.replace(/^<\?xml[^>]*\?>\s*/, '')
  const stack = []
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/gy
  let m
  let pos = 0
  while ((m = re.exec(body))) {
    pos = re.lastIndex
    if (m[5] !== undefined) {
      assert.ok(!/&(?!(amp|lt|gt|quot|#39);)/.test(m[5]), `bad entity in text: ${m[5].slice(0, 40)}`)
      continue
    }
    if (m[1]) assert.equal(stack.pop(), m[2])
    else if (!m[4]) stack.push(m[2])
  }
  assert.equal(pos, body.length, `unparsed markup at ${pos}: ${body.slice(pos, pos + 60)}`)
  assert.deepEqual(stack, [])
}

function assertNoExternalRefs(svg) {
  const withoutNs = svg.replace('xmlns="http://www.w3.org/2000/svg"', '')
  assert.ok(!/https?:|href|url\(|@import/i.test(withoutNs))
}

function assertTidy(result) {
  const { scene } = result
  for (const box of scene.boxes) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= scene.width && box.y + box.h <= scene.height, `box outside page: ${JSON.stringify(box)}`)
  }
  for (const role of ['legend', 'tab', 'break']) {
    const boxes = scene.boxes.filter(b => b.role === role)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `${role} boxes overlap: ${JSON.stringify([boxes[i], boxes[j]])}`)
    }
  }
  for (const el of scene.elements) {
    if (el.t === 'text' || el.t === 'rect') {
      assert.ok(el.x >= 0 && el.x <= scene.width && el.y >= 0 && el.y <= scene.height, `element outside page: ${JSON.stringify(el).slice(0, 120)}`)
    }
  }
}

test('escapeXml neutralises markup, quotes and control characters', () => {
  const out = escapeXml(HOSTILE)
  assert.ok(!/[<>"']/.test(out))
  assert.ok(!/&(?!(amp|lt|gt|quot|#39);)/.test(out))
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f\u202e]/.test(out))
  assert.ok(!/[\ud800-\udfff]/.test(out))
  assert.equal(cleanText('a\tb\r\nc'), 'a b c')
  assert.equal(escapeXml(null), '')
})

test('truncate counts code points and adds an ellipsis', () => {
  assert.equal(truncate('hello', 10), 'hello')
  assert.equal(truncate('hello world', 6), 'hello…')
  assert.equal(truncate('😀😀😀😀', 3), '😀😀…')
  assert.equal(truncate('abc', 0), '')
})

test('download names are derived from the file name and safe', () => {
  assert.equal(posterBaseName('grad.png'), 'grad_png-poster')
  assert.equal(posterBaseName('../../etc/pass wd'), 'etc_pass_wd-poster')
  assert.equal(posterBaseName(''), 'file-poster')
  assert.equal(posterBaseName(HOSTILE).includes('<'), false)
})

test('planRows collapses long runs between label boundaries into one break', () => {
  const items = planRows({ window: { start: 0, end: 1600 }, size: 1600, bytesPerRow: 16, boundaries: [0, 7, 8, 1599] })
  assert.deepEqual(items.map(i => i.type), ['row', 'break', 'row'])
  assert.equal(items[1].start, 16)
  assert.equal(items[1].end, 1584)
})

test('planRows keeps short gaps instead of collapsing them', () => {
  const end = 16 * (COLLAPSE_MIN + 1)
  const items = planRows({ window: { start: 0, end }, size: end, bytesPerRow: 16, boundaries: [0, end - 1] })
  assert.ok(items.every(i => i.type === 'row'))
  assert.equal(items.length, COLLAPSE_MIN + 1)
})

test('planRows without labels shows the start and says what is cut', () => {
  const items = planRows({ window: { start: 0, end: 100000 }, size: 100000, bytesPerRow: 16, boundaries: [], maxRows: 10 })
  assert.equal(items.length, 10)
  const last = items[items.length - 1]
  assert.equal(last.type, 'break')
  assert.equal(last.where, 'after')
  assert.equal(last.end, 100000)
  assert.equal(last.start, items[items.length - 2].end)
})

test('planRows marks bytes before a selection and after it', () => {
  const items = planRows({ window: { start: 40, end: 60 }, size: 200, bytesPerRow: 16, boundaries: [] })
  assert.equal(items[0].where, 'before')
  assert.equal(items[1].start, 40)
  assert.equal(items[items.length - 1].where, 'after')
})

test('auto plan stops at the label limit and counts the rest', () => {
  // Distinct names, so the fields are not a run of repeated entries
  const name = i => `f${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`
  const fields = Array.from({ length: 50 }, (_, i) => ({ name: name(i), offset: i * 4, length: 4, kind: 'size' }))
  const plan = planPoster({ analysis: analysisWith(fields), size: 1000, maxLabels: 12, mode: 'auto' })
  assert.equal(plan.labels.length, 12)
  assert.equal(plan.omittedLabels, 38)
  assert.equal(plan.window.end, 128)
  assert.ok(plan.items.length <= plan.maxRows)
})

test('auto plan shows some context when the field map is thin', () => {
  const plan = planPoster({ analysis: analysisWith([{ name: 'Magic', offset: 0, length: 4, kind: 'magic' }]), size: 10000, mode: 'auto' })
  assert.equal(plan.items.filter(i => i.type === 'row').length, 8)
  assert.equal(plan.items[plan.items.length - 1].where, 'after')
})

test('auto plan never exceeds the row limit', () => {
  const fields = Array.from({ length: 99 }, (_, i) => ({ name: `f${i}`, offset: i * 64, length: 64 }))
  const plan = planPoster({ analysis: analysisWith(fields), size: 99 * 64, maxLabels: 99, bytesPerRow: 8, maxRows: 40 })
  assert.ok(plan.items.length <= 40)
  assert.ok(plan.labels.length < 99)
  assert.ok(plan.labels.length > 0)
})

test('labels follow the depth limit and record their parents', () => {
  const fields = [
    { name: 'Header', offset: 0, length: 8, kind: 'header', children: [
      { name: 'Magic', offset: 0, length: 4, kind: 'magic' },
      { name: 'Inner', offset: 4, length: 4, children: [{ name: 'A', offset: 4, length: 2 }, { name: 'B', offset: 6, length: 2 }] }
    ] }
  ]
  const shallow = planPoster({ analysis: analysisWith(fields), size: 64, depth: 1 })
  assert.deepEqual(shallow.labels.map(l => l.name), ['Header'])
  const deep = planPoster({ analysis: analysisWith(fields), size: 64, depth: 3 })
  assert.deepEqual(deep.labels.map(l => l.name), ['Magic', 'A', 'B'])
  assert.equal(deep.labels[1].parents.length, 2)
  assert.deepEqual(deep.parents.map(p => p.name), ['Header', 'Inner'])
})

test('field mode labels the children of one top-level field', () => {
  const fields = [
    { name: 'One', offset: 0, length: 4 },
    { name: 'Two', offset: 4, length: 8, children: [{ name: 'x', offset: 4, length: 4 }, { name: 'y', offset: 8, length: 4 }] }
  ]
  const plan = planPoster({ analysis: analysisWith(fields), size: 32, mode: 'field', fieldIndex: 1 })
  assert.deepEqual(plan.window, { start: 4, end: 12 })
  assert.deepEqual(plan.labels.map(l => l.name), ['x', 'y'])
  assert.equal(plan.parents[0].name, 'Two')
  assert.deepEqual(topLevelChoices(analysisWith(fields), 32).map(c => c.name), ['One', 'Two'])
})

test('overlapping and invalid fields are skipped', () => {
  const fields = [
    { name: 'a', offset: 0, length: 8 },
    { name: 'b', offset: 4, length: 8 },
    { name: 'c', offset: -1, length: 4 },
    { name: 'd', offset: 2 ** 60, length: 4 },
    null,
    { name: 'e', offset: 16, length: Infinity }
  ]
  const plan = planPoster({ analysis: analysisWith(fields), size: 32 })
  assert.deepEqual(plan.labels.map(l => l.name), ['a'])
})

test('regions stand in when a format has no fields', () => {
  const plan = planPoster({ analysis: analysisWith([], { regions: [{ name: 'Body', offset: 0, length: 64, kind: 'data' }] }), size: 64 })
  assert.equal(plan.source, 'regions')
  assert.equal(plan.labels[0].name, 'Body')
})

test('a field wrapping rows becomes one polygon; a split one two rectangles', () => {
  const items = [0, 1, 2].map(row => ({ type: 'row', row, start: row * 16, end: row * 16 + 16 }))
  const runs = fieldRuns(items, 16, 10, 40)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].length, 3)
  const g = { bpr: 16, boxTop: i => i * 32, left: c => c * 10, right: c => c * 10 + 8 }
  const [shape] = runShapes(runs[0], g)
  assert.equal(shape.type, 'poly')
  assert.equal(shape.points.length, 8)
  const ys = shape.points.map(p => p[1])
  assert.equal(Math.min(...ys), 0)
  assert.equal(Math.max(...ys), 64 + 21)

  const short = fieldRuns(items, 16, 14, 18)
  const shapes = runShapes(short[0], g)
  assert.deepEqual(shapes.map(s => s.type), ['rect', 'rect'])
})

test('a break splits a field into separate runs', () => {
  const items = [
    { type: 'row', row: 0, start: 0, end: 16 },
    { type: 'break', start: 16, end: 160 },
    { type: 'row', row: 10, start: 160, end: 176 }
  ]
  const runs = fieldRuns(items, 16, 8, 170)
  assert.equal(runs.length, 2)
})

test('legend columns keep headings with their entries', () => {
  const blocks = [{ type: 'heading', h: 30 }, { type: 'entry', h: 44 }, { type: 'heading', h: 30 }, { type: 'entry', h: 44 }]
  const { cols } = flowColumns(blocks, 2)
  assert.equal(cols.length, 2)
  assert.equal(cols[1][0].type, 'heading')
})

test('neighbouring fields of one kind get different shades', () => {
  const shades = assignShades([{ kind: 'size' }, { kind: 'size' }, { kind: 'size' }, { kind: 'magic' }, { kind: 'size' }])
  assert.notEqual(shades[0], shades[1])
  assert.notEqual(shades[1], shades[2])
})

test('theme colours are resolved to literal values', () => {
  const colors = posterColors('dark', { background: 'rgb(1, 2, 3)', accent: 'not a colour' })
  assert.equal(colors.background, '#010203')
  assert.equal(colors.accent, '#00ffff')
  assert.ok(parseColor(colors.shades.magic[2]))
  assert.equal(posterColors('print', null).background, '#ffffff')
})

const date = '2026-11-16'

test('posters for hostile names and values stay well-formed and self-contained', () => {
  const fields = [
    { name: HOSTILE, offset: 0, length: 3, value: HOSTILE, description: HOSTILE, kind: '<x>' },
    { name: 'ok', offset: 3, length: 40, value: 'x'.repeat(500), description: 'y '.repeat(300), children: [{ name: HOSTILE, offset: 3, length: 40 }] }
  ]
  const analysis = analysisWith(fields, { formatName: HOSTILE, summary: [{ label: HOSTILE, value: HOSTILE }], regions: [{ name: HOSTILE, offset: 0, length: 64, kind: '"' }] })
  for (const style of ['dark', 'print']) {
    for (const proportion of ['landscape', 'portrait', 'square']) {
      const result = buildPoster({ bytes: bytesOf(64, i => (i * 37) & 0xff), analysis, fileName: HOSTILE, options: { style, proportion }, date })
      assertWellFormed(result.svg)
      assertNoExternalRefs(result.svg)
      assert.ok(!result.svg.includes('<script'))
      assertTidy(result)
    }
  }
})

test('zero-field, tiny and empty files still produce a poster with a note', () => {
  for (const size of [0, 1, 2, 300, 5000]) {
    const result = buildPoster({ bytes: bytesOf(size), analysis: analysisWith([]), fileName: 'x.bin', options: {}, date })
    assertWellFormed(result.svg)
    assertTidy(result)
    assert.ok(/no field map|empty/.test(result.svg))
    if (size > 0) assert.ok(result.plan.items.some(i => i.type === 'row'))
  }
  const none = buildPoster({ bytes: new Uint8Array(10), analysis: null, fileName: '', options: {} })
  assertWellFormed(none.svg)
})

test('a busy poster has no overlapping labels in any proportion or width', () => {
  const fields = Array.from({ length: 30 }, (_, i) => ({
    name: `group ${i}`,
    offset: i * 40,
    length: 40,
    kind: 'header',
    children: [
      { name: `a${i}`, offset: i * 40, length: 1, kind: 'magic', value: '1', description: 'one byte' },
      { name: `b${i}`, offset: i * 40 + 1, length: 2, kind: 'size', value: '2' },
      { name: `long name ${'n'.repeat(60)}`, offset: i * 40 + 3, length: 37, kind: 'data', value: 'v'.repeat(80), description: 'd'.repeat(200) }
    ]
  }))
  for (const bytesPerRow of [8, 16, 32]) {
    for (const proportion of ['landscape', 'portrait', 'square']) {
      const result = buildPoster({ bytes: bytesOf(1200), analysis: analysisWith(fields), fileName: 'busy.bin', options: { bytesPerRow, proportion, maxLabels: 99 }, date })
      assertTidy(result)
      assert.ok(result.plan.items.length <= result.plan.maxRows)
      const ratio = result.width / result.height
      const want = { landscape: Math.SQRT2, portrait: 1 / Math.SQRT2, square: 1 }[proportion]
      assert.ok(Math.abs(ratio - want) < 0.01, `${proportion} ratio ${ratio}`)
    }
  }
})

test('generation reads only the bytes it shows', () => {
  const bytes = bytesOf(5_000_000)
  const t = performance.now()
  const result = buildPoster({ bytes, analysis: analysisWith([{ name: 'All', offset: 0, length: 5_000_000, kind: 'data' }]), fileName: 'big.bin', options: {}, date })
  assert.ok(performance.now() - t < 1000)
  assert.ok(result.plan.items.length <= result.plan.maxRows)
})
