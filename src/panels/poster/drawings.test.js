import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPoster } from './plan.js'
import { layoutPoster, PROPORTIONS, factLines, flowColumns } from './layout.js'
import { sceneToSvg } from './render.js'
import { posterColors } from './palette.js'
import { contentGroups, tilesCaption, tileParts, MAX_TILES } from './tiles.js'
import { unusualNotes } from './unusual.js'
import { MAX_CONNECTORS } from './pointers.js'
import { excerpt, decodeText, textStretches, MAX_ROWS, READ_CAP } from './readable.js'

const HOSTILE = 'evil<script>alert(1)</script>&amp;"\'\u0000\u0007‮\ud800]]><!--'
const STYLES = ['dark', 'print']
const SHAPES = Object.keys(PROPORTIONS)

function analysisWith(fields, extra = {}) {
  return { formatId: 'test', formatName: 'Test format', category: 'data', summary: [], fields, regions: [], symbols: [], entries: [], warnings: [], unusual: [], image: null, ...extra }
}

const overlaps = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01

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
  assert.ok(!svg.includes('<script'))
  assert.ok(!/NaN|Infinity/.test(svg.replace(/<text[^>]*>[^<]*<\/text>|<tspan[^>]*>[^<]*<\/tspan>/g, '')), 'a number in the markup is not finite')
}

// Roles whose boxes must not overlap one another, within a role or across roles
const SOLID = ['head', 'strip', 'arcs', 'unusual', 'text', 'tiles', 'memory', 'legend', 'ptag', 'rail', 'pend', 'dumptext']
const SELF = ['legend', 'tab', 'break', 'unusual', 'text', 'ptag', 'rail', 'pend', 'strip', 'head']

function assertTidy(scene) {
  for (const box of scene.boxes) {
    assert.ok([box.x, box.y, box.w, box.h].every(Number.isFinite), `box with a bad number: ${JSON.stringify(box)}`)
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= scene.width + 0.01 && box.y + box.h <= scene.height + 0.01, `box outside page: ${JSON.stringify(box)}`)
  }
  for (const role of SELF) {
    const boxes = scene.boxes.filter(b => b.role === role)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `${role} boxes overlap: ${JSON.stringify([boxes[i], boxes[j]])}`)
    }
  }
  const solid = scene.boxes.filter(b => SOLID.includes(b.role))
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      if (solid[i].role === solid[j].role) continue
      assert.ok(!overlaps(solid[i], solid[j]), `${solid[i].role} and ${solid[j].role} overlap: ${JSON.stringify([solid[i], solid[j]])}`)
    }
  }
  // The dump's tabs and breaks stay clear of the new drawings
  for (const a of scene.boxes.filter(b => b.role === 'tab' || b.role === 'break')) {
    for (const b of scene.boxes.filter(x => ['unusual', 'text', 'tiles', 'memory', 'strip', 'arcs', 'legend', 'ptag', 'rail'].includes(x.role))) {
      assert.ok(!overlaps(a, b), `${a.role} and ${b.role} overlap: ${JSON.stringify([a, b])}`)
    }
  }
  // Connectors and tags stay in the rail: clear of the bytes and their text
  const text = scene.boxes.filter(b => b.role === 'dumptext')
  for (const b of scene.boxes.filter(x => ['rail', 'pend', 'ptag'].includes(x.role))) {
    for (const t of text) assert.ok(!overlaps(b, t), `${b.role} over the dump: ${JSON.stringify([b, t])}`)
  }
  for (const el of scene.elements) {
    if (el.t !== 'path' || !String(el.g).startsWith('pointer:')) continue
    const nums = el.d.match(/-?[\d.]+/g).map(Number)
    let x = 0
    let y = 0
    for (const cmd of el.d.match(/[MHVQ][^MHVQ]*/g)) {
      const v = cmd.slice(1).trim().split(/[ ,]+/).map(Number)
      if (cmd[0] === 'M') [x, y] = v
      else if (cmd[0] === 'H') x = v[0]
      else if (cmd[0] === 'V') y = v[0]
      else [x, y] = v.slice(2)
      for (const t of text) assert.ok(!(x > t.x && x < t.x + t.w && y > t.y && y < t.y + t.h), `connector point (${x}, ${y}) over the dump`)
    }
    assert.ok(nums.every(Number.isFinite))
  }
  for (const el of scene.elements) {
    if (el.t === 'text' || el.t === 'rect') {
      assert.ok(el.x >= -0.01 && el.x <= scene.width + 0.01 && el.y >= -0.01 && el.y <= scene.height + 0.01, `element outside page: ${JSON.stringify(el).slice(0, 160)}`)
    }
  }
}

function render(input) {
  const colors = posterColors(input.style || 'dark')
  const scene = layoutPoster({ fileName: 'x.bin', date: '2026-11-22', ...input, colors })
  const svg = sceneToSvg(scene, { title: 't', description: 'd' })
  return { scene, svg }
}

function check(input) {
  const result = render(input)
  assertWellFormed(result.svg)
  assertNoExternalRefs(result.svg)
  assertTidy(result.scene)
  return result
}

// A file shaped like corkami's 96workingsections.exe: headers, then 96
// sections of 0x200 bytes from 0x1200, the first different, the other 95
// identical; 0x1000 apart in memory from RVA 0x2000; entry in the last.
function sectionsFile(count = 96) {
  const size = 0x1200 + count * 0x200
  const bytes = new Uint8Array(size)
  bytes[0] = 0x4d
  bytes[1] = 0x5a
  for (let i = 0; i < 0x200; i++) bytes[0x1200 + i] = (i * 7) & 0xff
  for (let s = 1; s < count; s++) for (let i = 0; i < 0x200; i += 4) bytes.set([0xeb, 0xff, 0xc0, 0x48], 0x1200 + s * 0x200 + i)
  const sections = Array.from({ length: count }, (_, i) => ({ name: '', offset: 0x1200 + i * 0x200, size: 0x200, address: 0x2000 + i * 0x1000, memSize: 0x200, flags: '-wx' }))
  const headers = Array.from({ length: count }, (_, i) => ({
    name: `[${i}]`, offset: 0x138 + i * 40, length: 40, kind: 'header',
    children: [
      { name: 'VirtualAddress', offset: 0x138 + i * 40 + 12, length: 4, kind: 'offset' },
      { name: 'PointerToRawData', offset: 0x138 + i * 40 + 20, length: 4, kind: 'offset', target: 0x1200 + i * 0x200 }
    ]
  }))
  const fields = [
    { name: 'Signature', offset: 0, length: 2, kind: 'magic' },
    { name: 'e_lfanew', offset: 0x3c, length: 4, kind: 'offset', target: 0x40 },
    { name: 'PE signature', offset: 0x40, length: 4, kind: 'magic' },
    { name: 'AddressOfEntryPoint', offset: 0x68, length: 4, kind: 'offset', target: 0x1200 + (count - 1) * 0x200 },
    { name: 'Section table', offset: 0x138, length: count * 40, kind: 'table', children: headers }
  ]
  const entryOffset = 0x1200 + (count - 1) * 0x200
  const analysis = analysisWith(fields, {
    formatName: 'Windows PE Executable',
    category: 'executable',
    regions: [{ name: 'Headers', offset: 0, length: 0x1200, kind: 'header' }, ...sections.map((s, i) => ({ name: `Section ${i + 1}`, offset: s.offset, length: s.size, kind: 'code' }))],
    unusual: [{ text: 'Execution starts in the last section, not the first.', offset: entryOffset }],
    image: { addressLabel: 'RVA', entry: { address: 0x2000 + (count - 1) * 0x1000, offset: entryOffset }, sections, total: count }
  })
  return { bytes, analysis, size, entryOffset }
}

// What the planner will add: pointers from labelled fields, links for every pointer field
function withPointers(plan, analysis) {
  const links = []
  const walk = nodes => { for (const n of nodes || []) { if (n.target !== undefined) links.push({ offset: n.offset, length: n.length, target: n.target }); walk(n.children) } }
  walk(analysis.fields)
  const shownRows = plan.items.filter(i => i.type === 'row')
  const isShown = o => shownRows.some(r => o >= r.start && o < r.end)
  const targets = new Map()
  for (const l of links) targets.set(l.offset, l.target)
  const pointers = plan.labels.filter(l => targets.has(l.offset)).map(l => {
    const target = targets.get(l.offset)
    return { from: l.number, offset: l.offset, target, targetShown: isShown(target), targetLabel: plan.labels.find(m => target >= m.start && target < m.end)?.number ?? null }
  })
  return { ...plan, pointers, links: links.slice(0, 400) }
}

function corkamiPlan(file, options = {}) {
  const plan = planPoster({ analysis: file.analysis, size: file.size, depth: 3, maxLabels: 99, maxRows: 60, ...options })
  return withPointers(plan, file.analysis)
}

test('an ordinary file gains no extra boxes', () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff)
  const analysis = analysisWith([{ name: 'Magic', offset: 0, length: 4, kind: 'magic' }], { regions: [{ name: 'Body', offset: 0, length: 300, kind: 'data' }] })
  const plan = planPoster({ analysis, size: bytes.length })
  for (const style of STYLES) {
    for (const proportion of SHAPES) {
      const { scene } = check({ plan, bytes, analysis, style, proportion })
      assert.deepEqual(scene.arrangement.bands, ['title', 'map'])
      assert.ok(!scene.boxes.some(b => ['unusual', 'tiles', 'memory', 'arcs', 'rail', 'ptag'].includes(b.role)))
    }
  }
  // A missing analysis is fine too
  check({ plan: planPoster({ analysis: null, size: 10 }), bytes: new Uint8Array(10), analysis: null })
})

test('each drawing appears only with its data and its flag', () => {
  const file = sectionsFile()
  const plan = corkamiPlan(file)
  const all = check({ plan, bytes: file.bytes, analysis: file.analysis })
  assert.deepEqual(all.scene.arrangement.bands, ['title', 'map', 'unusual', 'tiles', 'memory'])
  assert.ok(all.scene.boxes.some(b => b.role === 'arcs'))
  for (const key of ['unusual', 'tiles', 'memory']) {
    const { scene } = check({ plan, bytes: file.bytes, analysis: file.analysis, show: { [key]: false } })
    assert.ok(!scene.arrangement.bands.includes(key), key)
    assert.ok(!scene.boxes.some(b => b.role === key), key)
  }
  const off = check({ plan, bytes: file.bytes, analysis: file.analysis, show: { pointers: false } })
  assert.ok(!off.scene.boxes.some(b => ['arcs', 'rail', 'ptag'].includes(b.role)))
  assert.ok(!off.svg.includes('pointer:'))
  // Flags on, data gone
  const bare = check({ plan: { ...plan, pointers: undefined, links: undefined }, bytes: file.bytes, analysis: { ...file.analysis, unusual: undefined, image: undefined } })
  assert.deepEqual(bare.scene.arrangement.bands, ['title', 'map'])
  assert.ok(!bare.scene.boxes.some(b => ['arcs', 'rail', 'ptag'].includes(b.role)))
})

test('the 96-section file reads as one odd section and 95 copies', () => {
  const file = sectionsFile()
  const plan = corkamiPlan(file)
  const { svg, scene } = check({ plan, bytes: file.bytes, analysis: file.analysis })
  assert.ok(svg.includes('96 sections. 2 different contents: 95 are identical.'))
  // The tiles' caption says it; the unusual box repeats it only without the tiles
  assert.ok(!svg.includes('95 of the 96 sections have identical contents.'))
  const noTiles = check({ plan, bytes: file.bytes, analysis: file.analysis, show: { tiles: false } })
  assert.ok(noTiles.svg.includes('95 of the 96 sections have identical contents.'))
  assert.ok(svg.includes('Execution starts in the last section'))
  assert.equal((svg.match(/data-id="tile:\d+"/g) || []).length, 96)
  assert.ok(svg.includes('entry point RVA 0x61000 (section 96)'))
  assert.ok(svg.includes('entry point 0xD000'))
  // At most a few connectors, each on its own rail line
  const rails = scene.boxes.filter(b => b.role === 'rail')
  assert.ok(rails.length >= 1 && rails.length <= MAX_CONNECTORS)
  assert.equal(new Set(rails.map(r => Math.round(r.x * 10))).size, rails.length)
})

test('posters keep their proportion with up to 200 rows, in every style', () => {
  const file = sectionsFile()
  for (const maxRows of [20, 200]) {
    for (const bytesPerRow of [8, 16, 32]) {
      const plan = corkamiPlan(file, { maxRows, bytesPerRow })
      for (const proportion of SHAPES) {
        for (const style of STYLES) {
          const { scene } = check({ plan, bytes: file.bytes, analysis: file.analysis, proportion, style })
          const ratio = scene.width / scene.height
          assert.ok(Math.abs(ratio - PROPORTIONS[proportion]) < 0.01, `${proportion} ratio ${ratio}`)
          // Sensible: no page more than about twice the area its contents need
          assert.ok(scene.width < 9000 && scene.height < 9000, `${proportion} ${maxRows} rows: ${scene.width}×${scene.height}`)
        }
      }
    }
  }
})

test('tall is about one wide to two high', () => {
  assert.equal(PROPORTIONS.tall, 0.5)
})

test('hostile layouts, pointers and notes stay tidy and self-contained', () => {
  const size = 4096
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 13) & 0xff)
  const fields = Array.from({ length: 60 }, (_, i) => ({ name: HOSTILE, offset: i * 16, length: 4, kind: 'offset', value: HOSTILE, target: 2048 }))
  const sections = []
  for (let i = 0; i < 3000; i++) {
    const kind = i % 6
    sections.push({
      name: i % 7 ? HOSTILE : '',
      offset: [(i % 50) * 3, size + i, NaN, -5, 2 ** 60, i][kind],
      size: [3, 100, 5, 0, 7, Infinity][kind],
      address: [i * 0x1000, 2 ** 62 + i, NaN, 0, -1, 1e300][kind],
      memSize: [0x1000, 0, 2 ** 70, 0x10, 5, NaN][kind],
      flags: HOSTILE
    })
  }
  const notes = Array.from({ length: 40 }, (_, i) => ({ text: i % 3 ? `${HOSTILE} ${'word '.repeat(80)}` : HOSTILE, offset: [5, NaN, -1, 2 ** 70][i % 4] }))
  notes.push(null, { text: { toString: () => 'x' } }, { text: '' })
  const analysis = analysisWith(fields, {
    formatName: HOSTILE,
    summary: [{ label: HOSTILE, value: HOSTILE }],
    regions: [{ name: HOSTILE, offset: 0, length: size, kind: '"' }],
    unusual: notes,
    image: { addressLabel: HOSTILE, entry: { address: NaN, offset: 2 ** 70 }, sections, total: -1 }
  })
  const base = planPoster({ analysis, size, maxLabels: 99, maxRows: 200 })
  const links = Array.from({ length: 1000 }, (_, i) => ({ offset: i % size, length: 4, target: 2048 }))
  links.push({ offset: NaN, length: 4, target: 1 }, { offset: 1, length: 4, target: 2 ** 80 }, null)
  const pointers = base.labels.map(l => ({ from: l.number, offset: l.offset, target: 2048, targetShown: true, targetLabel: null }))
  pointers.push({ from: 9999, offset: -1, target: NaN }, null)
  const plan = { ...base, pointers, links }
  for (const style of STYLES) {
    for (const proportion of SHAPES) {
      const t = performance.now()
      const { scene, svg } = check({ plan, bytes, analysis, style, proportion, fileName: HOSTILE })
      assert.ok(performance.now() - t < 2000)
      assert.ok(scene.boxes.filter(b => b.role === 'rail').length <= MAX_CONNECTORS)
      assert.ok((svg.match(/data-id="tile:/g) || []).length <= MAX_TILES)
      assert.ok(svg.includes('3,000 sections, the first 512 shown.'))
    }
  }
  // An image with no sections draws neither tiles nor the memory diagram
  const empty = check({ plan: base, bytes, analysis: { ...analysis, image: { addressLabel: 'RVA', entry: null, sections: [], total: 0 } } })
  assert.ok(!empty.scene.arrangement.bands.includes('tiles'))
  assert.ok(!empty.scene.arrangement.bands.includes('memory'))
})

test('notes from the parsers are cleaned, deduplicated and capped', () => {
  const notes = unusualNotes({ unusual: [{ text: 'a\u0000<b>' }, { text: 'a\u0000<b>' }, { text: '  ' }, { text: 5 }, null, { text: 'x', offset: NaN }] }, ['fact'])
  assert.deepEqual(notes.map(n => n.text), ['a⟨U+0000⟩<b>', '5', 'x', 'fact'])
  assert.equal(notes[2].offset, null)
  assert.equal(unusualNotes({ unusual: Array.from({ length: 500 }, (_, i) => ({ text: `n${i}` })) }).length, 24)
})

test('contents are compared byte for byte, within a cap', () => {
  const bytes = new Uint8Array(1000)
  bytes.fill(1, 0, 100)
  bytes.fill(1, 100, 200)
  bytes.fill(2, 200, 300)
  const parts = [{ offset: 0, size: 100 }, { offset: 100, size: 100 }, { offset: 200, size: 100 }, { offset: 300, size: 0 }, { offset: 5000, size: 10 }, { offset: null, size: 4 }]
  const all = contentGroups(parts, bytes)
  assert.deepEqual(all.parts.map(p => p.group), [0, 0, 1, -1, -1, -1])
  assert.deepEqual(all.parts.map(p => p.state), ['ok', 'ok', 'ok', 'empty', 'empty', 'empty'])
  // With room for only 150 bytes: the second part is never claimed identical
  const capped = contentGroups(parts, bytes, 150)
  assert.equal(capped.parts[0].state, 'ok')
  assert.equal(capped.parts[1].state, 'unchecked')
  assert.equal(capped.parts[2].state, 'unchecked')
  assert.ok(capped.groups.every(g => g.members === 1))
  const caption = tilesCaption({ kind: 'sections', parts, total: parts.length }, capped)
  assert.ok(/not compared/.test(caption))
  assert.ok(!/identical/.test(caption))
  // Equal lengths with different bytes are different
  const other = contentGroups([{ offset: 0, size: 150 }, { offset: 100, size: 150 }], bytes)
  assert.deepEqual(other.parts.map(p => p.group), [0, 1])
})

test('regions stand in for sections only with at least three data parts', () => {
  const regions = n => Array.from({ length: n }, (_, i) => ({ name: `m${i}`, offset: i * 10, length: 10, kind: 'data' }))
  assert.equal(tileParts({ regions: regions(2) }, 100), null)
  assert.equal(tileParts({ regions: regions(3) }, 100).kind, 'parts')
  assert.equal(tileParts({ category: 'executable', regions: regions(5) }, 100), null)
  assert.equal(tileParts({ image: { sections: [] }, regions: regions(5) }, 100), null)
})

test('pointers without a connector get paired tags', () => {
  const size = 1024
  const bytes = new Uint8Array(size)
  const fields = []
  for (let i = 0; i < 12; i++) {
    fields.push({ name: `ptr${i}`, offset: i * 64, length: 4, kind: 'offset', target: i * 64 + 40 })
    fields.push({ name: `data${i}`, offset: i * 64 + 40, length: 4, kind: 'data' })
  }
  const analysis = analysisWith(fields)
  const plan = withPointers(planPoster({ analysis, size, mode: 'auto', maxRows: 200, maxLabels: 99, depth: 1 }), analysis)
  assert.ok(plan.pointers.length >= 10)
  for (const proportion of SHAPES) {
    const { scene, svg } = check({ plan, bytes, analysis, proportion })
    const connectors = scene.boxes.filter(b => b.role === 'rail')
    assert.ok(connectors.length >= 1 && connectors.length <= MAX_CONNECTORS)
    const tags = [...svg.matchAll(/data-id="ptag:\d+">([\s\S]*?)<\/g>/g)].map(m => m[1].replace(/<[^>]+>/g, ''))
    const out = tags.flatMap(t => [...t.matchAll(/→ (\d+) · 0x[0-9A-F]+/g)].map(m => Number(m[1])))
    const into = tags.flatMap(t => [...t.matchAll(/← ([\d, ]+)/g)].flatMap(m => m[1].split(',').map(Number)))
    assert.equal(connectors.length + out.length, plan.pointers.length, proportion)
    assert.equal(into.length, out.length)
    // Every "→ n" names a label that a "← m" answers
    for (const n of out) assert.ok(plan.labels.some(l => l.number === n))
    for (const m of into) assert.ok(plan.pointers.some(p => p.from === m))
  }
})

test('tiles appear only when some parts share their contents, and available says so', () => {
  const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + (i >> 9) * 7) & 0xff)
  const distinct = Array.from({ length: 4 }, (_, i) => ({ name: `.s${i}`, offset: 1024 + i * 512, size: 512, address: 0x1000 * (i + 1), memSize: 512, flags: 'r--' }))
  const image = { addressLabel: 'RVA', entry: null, sections: distinct, total: 4 }
  const analysis = analysisWith([{ name: 'Magic', offset: 0, length: 2, kind: 'magic' }], { image, category: 'executable' })
  const plan = planPoster({ analysis, size: bytes.length })
  const plain = check({ plan, bytes, analysis })
  assert.ok(!plain.scene.arrangement.bands.includes('tiles'))
  assert.deepEqual(plain.scene.available, { pointers: false, unusual: false, text: false, tiles: false, memory: true })
  // Two of them the same
  const same = { ...image, sections: [...distinct, { ...distinct[1], name: '.copy', address: 0x9000 }] }
  const withCopy = check({ plan, bytes, analysis: { ...analysis, image: same } })
  assert.ok(withCopy.scene.arrangement.bands.includes('tiles'))
  assert.equal(withCopy.scene.available.tiles, true)
  assert.equal(withCopy.scene.available.unusual, true)
  // Regions: three members, two identical
  const zip = new Uint8Array(300)
  zip.fill(7, 0, 100)
  zip.fill(7, 100, 200)
  const regions = [0, 1, 2].map(i => ({ name: `m${i}`, offset: i * 100, length: 100, kind: 'data' }))
  const zipAnalysis = analysisWith([], { regions })
  const z = check({ plan: planPoster({ analysis: zipAnalysis, size: 300 }), bytes: zip, analysis: zipAnalysis })
  assert.ok(z.scene.arrangement.bands.includes('tiles'))
})

test('available ignores the show flags', () => {
  const file = sectionsFile()
  const plan = corkamiPlan(file)
  const off = { pointers: false, unusual: false, text: false, tiles: false, memory: false }
  const { scene } = check({ plan, bytes: file.bytes, analysis: file.analysis, show: off })
  assert.deepEqual(scene.available, { pointers: true, unusual: true, text: false, tiles: true, memory: true })
  assert.deepEqual(scene.arrangement.bands, ['title', 'map'])
})

test('landscape pages put the bands beside the dump and keep the story connectors', () => {
  const file = sectionsFile()
  const plan = corkamiPlan(file, { maxRows: 60 })
  const entryLabel = plan.labels.find(l => l.name === 'AddressOfEntryPoint')
  for (const style of STYLES) {
    const side = check({ plan, bytes: file.bytes, analysis: file.analysis, style })
    assert.notEqual(side.scene.arrangement.layout, 'stack')
    if (entryLabel) assert.ok(side.scene.boxes.some(b => b.role === 'rail' && b.id === entryLabel.number), 'entry point connector kept')
    // Every drawing is still there
    for (const role of ['strip', 'unusual', 'tiles', 'memory']) assert.ok(side.scene.boxes.some(b => b.role === role), role)
  }
  // Long dumps: a split into dump columns never costs the entry connector unless it saves a lot
  const long = corkamiPlan(file, { maxRows: 200, bytesPerRow: 8 })
  const entry = long.labels.find(l => l.name === 'AddressOfEntryPoint')
  for (const proportion of SHAPES) {
    const { scene } = check({ plan: long, bytes: file.bytes, analysis: file.analysis, proportion })
    if (entry && scene.arrangement.dumpColumns === 1) assert.ok(scene.boxes.some(b => b.role === 'rail' && b.id === entry.number))
  }
})

// --- Readable text, numbered notes, title facts, memory rule, legends --------

const LISTING = [
  '\r; a listing that is also a program:',
  '; this second line is long on purpose, so that it has to wrap at the width of a narrow column on the poster and never be cut short.',
  '; third line',
  '',
  '; fifth line, after a blank one',
  'start:\tmov eax, 1',
  '\tret'
].join('\r\n') + '\r\n'

// A file shaped like corkami's quine.exe: a DOS header of 0x0D bytes, then
// 7,616 bytes of text at 0x40, the PE header at 0x1E00 and one section
function quineFile(text = LISTING) {
  const size = 0x2200
  const bytes = new Uint8Array(size).fill(0x0d, 2, 0x3c)
  bytes.set([0x4d, 0x5a])
  bytes.set([0x00, 0x1e, 0x00, 0x00], 0x3c)
  const body = typeof text === 'string' ? new TextEncoder().encode(text) : text
  for (let i = 0; i < 7616; i++) bytes[0x40 + i] = i < body.length ? body[i] : 0x3b + (i % 40 === 39 ? -0x31 : (i % 26))
  bytes.set([0x50, 0x45, 0, 0], 0x1e00)
  const fields = [
    { name: 'DOS signature', offset: 0, length: 2, kind: 'magic' },
    { name: 'e_lfanew', offset: 0x3c, length: 4, kind: 'offset', target: 0x1e00 },
    { name: 'DOS stub', offset: 0x40, length: 7616, kind: 'data' },
    { name: 'PE signature', offset: 0x1e00, length: 4, kind: 'magic' },
    { name: 'Characteristics', offset: 0x1e16, length: 2, kind: 'flags' }
  ]
  const analysis = analysisWith(fields, {
    formatName: 'Windows PE Executable',
    category: 'executable',
    unusual: [
      { text: 'The PE header starts far into the file.', offset: 0x3c },
      { text: 'Text where the DOS program usually is.', offset: 0x50 },
      { text: 'Something past every box.', offset: 0x2100 },
      { text: 'A note with no offset.' }
    ],
    image: { addressLabel: 'RVA', entry: null, sections: [{ name: '', offset: 0x2000, size: 0x200, address: 0x2000, memSize: 0x200, flags: 'rwx' }], total: 1 }
  })
  return { bytes, analysis, size }
}

function withText(plan, texts) {
  const label = offset => plan.labels.find(l => l.start === offset)?.number ?? null
  return { ...plan, texts: texts.map(([offset, length, name]) => ({ offset, length, label: label(offset), name })) }
}

function quinePlan(file, options = {}) {
  const plan = planPoster({ analysis: file.analysis, size: file.size, bytes: file.bytes, depth: 3, maxLabels: 60, maxRows: 60, ...options })
  return withText(plan, [[0x40, 7616, 'DOS stub']])
}

const textOf = (scene, g) => scene.elements.filter(e => e.t === 'text' && e.g === g).map(e => e.text ?? e.spans.map(s => s.text).join(''))

test('the readable text band appears only with text in the plan and its flag on', () => {
  const file = quineFile()
  const bare = planPoster({ analysis: file.analysis, size: file.size, bytes: file.bytes, depth: 3, maxLabels: 60, maxRows: 60 })
  const none = check({ plan: { ...bare, texts: undefined }, bytes: file.bytes, analysis: file.analysis })
  assert.ok(!none.scene.arrangement.bands.includes('text'))
  assert.equal(none.scene.available.text, false)
  assert.ok(!none.scene.boxes.some(b => b.role === 'text'))

  const plan = quinePlan(file)
  for (const style of STYLES) {
    for (const proportion of SHAPES) {
      const { scene, svg } = check({ plan, bytes: file.bytes, analysis: file.analysis, style, proportion })
      assert.ok(scene.arrangement.bands.includes('text'), proportion)
      assert.equal(scene.available.text, true)
      const lines = textOf(scene, 'band:text')
      assert.ok(lines.includes('; a listing that is also a program:'), 'the first line, without the leading CR')
      assert.ok(lines.includes('; third line'))
      assert.ok(svg.includes('READABLE TEXT'))
      assert.ok(lines.some(l => /^… [\d,]+ more bytes of text follow$/.test(l)), 'says how much more there is')
      // Where the text is, with the box's number in the box's colour
      const stub = plan.labels.find(l => l.start === 0x40)
      const tab = scene.elements.find(e => e.t === 'tab' && e.g === 'band:text')
      const dumpTab = scene.elements.find(e => e.t === 'tab' && e.g === `tab:${stub.number}`)
      assert.equal(tab.fill, dumpTab.fill)
      assert.ok(lines.includes(String(stub.number)) && lines.includes('DOS stub') && lines.includes('0x40 · 7,616 B'))
      // Right after the unusual box when it does not lead
      const box = role => scene.boxes.find(b => b.role === role)
      if (!scene.arrangement.textLeads) assert.ok(box('text').y > box('unusual').y)
      else assert.ok(box('text').y < box('strip').y || box('text').x !== box('strip').x)
    }
  }
  // Switched off: gone, but still available
  const off = check({ plan, bytes: file.bytes, analysis: file.analysis, show: { text: false } })
  assert.ok(!off.scene.arrangement.bands.includes('text'))
  assert.ok(!off.scene.boxes.some(b => b.role === 'text'))
  assert.equal(off.scene.available.text, true)
  // Malformed entries are ignored
  const junk = [null, 'x', { offset: -1, length: 5 }, { offset: NaN, length: 5 }, { offset: file.size + 5, length: 3 }, { offset: 0x40, length: 0 }, { offset: 0x40, length: Infinity }, { offset: 0x40, length: 2 ** 40 }]
  assert.equal(textStretches({ texts: junk }, file.size).length, 1, 'only the last entry is usable')
  assert.equal(textStretches({ texts: junk }, file.size)[0].length, file.size - 0x40, 'clamped to the file')
  for (const texts of [junk.slice(0, 7), 'nonsense', { length: 3 }, []]) {
    const { scene } = check({ plan: { ...bare, texts }, bytes: file.bytes, analysis: file.analysis })
    assert.equal(scene.available.text, false)
  }
})

test('several stretches: the longest is shown, the others named in one line', () => {
  const file = quineFile()
  const base = planPoster({ analysis: file.analysis, size: file.size, bytes: file.bytes, depth: 3, maxLabels: 60, maxRows: 60 })
  const plan = withText(base, [[0x1e00, 80, 'PE signature'], [0x40, 7616, 'DOS stub'], [0x2000, 100, 'Section']])
  const { scene } = check({ plan, bytes: file.bytes, analysis: file.analysis })
  const lines = textOf(scene, 'band:text')
  assert.ok(lines.includes('; a listing that is also a program:'))
  assert.ok(lines.includes('Also readable text: '))
  assert.ok(lines.some(l => l.startsWith('PE signature 0x1E00 · 80 B')))
  assert.equal(lines.filter(l => l === 'DOS stub').length, 1, 'one excerpt only')
})

test('the excerpt breaks lines, wraps without cutting and counts what follows', () => {
  const bytes = new TextEncoder().encode(LISTING)
  const cols = 40
  const ex = excerpt(bytes, 0, bytes.length, cols)
  assert.equal(ex.encoding, 'ascii')
  assert.equal(ex.rows[0].text, '; a listing that is also a program:')
  for (const row of ex.rows) assert.ok(row.text.length <= cols, row.text)
  // The long line comes back whole from its rows
  const start = ex.rows.findIndex(r => r.text.startsWith('; this second'))
  let joined = ex.rows[start].text
  for (let i = start + 1; ex.rows[i].continued; i++) joined += ' ' + ex.rows[i].text
  assert.equal(joined, LISTING.split('\r\n')[1])
  // Tabs as spaces, blank lines kept, nothing after the end
  assert.ok(ex.rows.some(r => r.text === 'start:  mov eax, 1'))
  assert.ok(ex.rows.some(r => r.text === '    ret'))
  assert.ok(ex.rows.some(r => r.text === ''))
  assert.equal(ex.more, 0)
  // Few rows: whole lines only, and the rest counted in bytes
  const short = excerpt(bytes, 0, bytes.length, cols, 3)
  assert.deepEqual(short.rows.map(r => r.text), ['; a listing that is also a program:'])
  assert.equal(short.more, bytes.length - (LISTING.indexOf('\r\n') + 2))
  // CR, LF and CR LF all end a line
  const mixed = excerpt(new TextEncoder().encode('a\rb\nc\r\nd'), 0, 8, 40)
  assert.deepEqual(mixed.rows.map(r => r.text), ['a', 'b', 'c', 'd'])
})

test('text from the file is decoded safely and stays bounded', () => {
  const enc = s => new TextEncoder().encode(s)
  // UTF-8 when valid, one byte per character otherwise
  assert.equal(decodeText(enc('café'), 0, 5).encoding, 'utf-8')
  assert.equal(decodeText(enc('café'), 0, 5).chars.join(''), 'café')
  const latin = decodeText(Uint8Array.from([0x63, 0xe9, 0x41, 0x85]), 0, 4)
  assert.equal(latin.encoding, 'latin-1')
  assert.equal(excerpt(Uint8Array.from([0x63, 0xe9, 0x41, 0x85]), 0, 4, 40).rows[0].text, 'céA⟨U+0085⟩')
  // Overlong forms and surrogates are not UTF-8
  for (const bad of [[0xc0, 0xaf], [0xe0, 0x80, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xff]]) {
    assert.equal(decodeText(Uint8Array.from([0x41, ...bad]), 0, bad.length + 1).encoding, 'latin-1', bad.join(','))
  }
  // Control and direction characters become markers, never split by wrapping
  const hostile = enc('abc\u0007def\u202Eghi\u200Bjkl '.repeat(6))
  const rows = excerpt(hostile, 0, hostile.length, 20).rows
  assert.ok(rows.some(r => r.text.includes('⟨U+0007⟩')) && rows.some(r => r.text.includes('⟨U+202E⟩')))
  for (const r of rows) {
    assert.ok(![...r.text].some(c => c.codePointAt(0) < 0x20 || c === "\u202E" || c === "\u200B"))
    assert.equal((r.text.match(/⟨/g) || []).length, (r.text.match(/⟩/g) || []).length, 'a marker is never split')
  }
  // A 100 KB single line: bounded reads, at most MAX_ROWS rows, the rest counted
  const long = new Uint8Array(100 * 1024).fill(0x61)
  let reads = 0
  const counting = new Proxy(long, { get: (t, k) => { if (typeof k === 'string' && /^\d+$/.test(k)) reads++; return Reflect.get(t, k) } })
  const t0 = performance.now()
  const big = excerpt(counting, 0, long.length, 120)
  assert.ok(performance.now() - t0 < 500)
  assert.ok(reads <= 2 * READ_CAP + 16, `${reads} reads`)
  assert.equal(big.rows.length, MAX_ROWS)
  assert.equal(big.more, long.length - MAX_ROWS * 120)
})

test('hostile text goes through the normal pipeline', () => {
  const nasty = new Uint8Array([
    ...new TextEncoder().encode('<script>alert(1)</script> &amp; ]]><!-- \u202Eexe.pdf \u0000\u0007\u001B[31m\r\n'),
    0xc3, 0x28, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0x41
  ])
  for (const text of [nasty, new Uint8Array(100 * 1024).fill(0x41), new TextEncoder().encode('⟨U+0041⟩ looks like a marker\n'.repeat(40))]) {
    const file = quineFile(text)
    const plan = quinePlan(file)
    for (const style of STYLES) {
      for (const proportion of SHAPES) {
        const t = performance.now()
        const { svg, scene } = check({ plan, bytes: file.bytes, analysis: file.analysis, style, proportion, fileName: HOSTILE })
        assert.ok(performance.now() - t < 2000)
        assert.ok(scene.arrangement.bands.includes('text'))
        assert.ok(!svg.includes('<script'))
      }
    }
  }
  const { svg } = check({ plan: quinePlan(quineFile(nasty)), bytes: quineFile(nasty).bytes, analysis: quineFile(nasty).analysis })
  assert.ok(svg.includes('&lt;script&gt;'))
  // Not valid UTF-8, so one byte per character: the override's bytes show as Latin-1 and a C1 marker
  assert.ok(svg.includes('⟨U+001B⟩') && svg.includes('⟨U+0080⟩') && svg.includes('⟨U+0007⟩'))
  const valid = quineFile('\u202Eexe.pdf <b>bold</b>\r\n')
  assert.ok(check({ plan: quinePlan(valid), bytes: valid.bytes, analysis: valid.analysis }).svg.includes('⟨U+202E⟩exe.pdf &lt;b&gt;'))
})

test('unusual notes carry the number of the box that holds their offset', () => {
  const file = quineFile()
  const plan = quinePlan(file)
  const holder = offset => plan.labels.filter(l => offset >= l.start && offset < l.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
  for (const proportion of SHAPES) {
    const { scene } = check({ plan, bytes: file.bytes, analysis: file.analysis, proportion })
    const els = scene.elements.filter(e => e.g === 'unusual')
    const tabs = els.filter(e => e.t === 'tab')
    const numbers = tabs.map(tab => els.find(e => e.t === 'text' && e.anchor === 'middle' && Math.abs(e.x - (tab.x + tab.w / 2)) < 0.01 && e.y > tab.y && e.y < tab.y + tab.h).text)
    assert.deepEqual(numbers, [0x3c, 0x50].map(o => String(holder(o).number)))
    // The tab's colour is the box's colour in the dump
    tabs.forEach((tab, i) => assert.equal(tab.fill, scene.elements.find(e => e.t === 'tab' && e.g === `tab:${numbers[i]}`).fill))
    // The offset with no box keeps its offset alone
    assert.ok(els.some(e => e.text === '0x2100'))
    assert.equal(holder(0x2100), undefined)
    // Offsets and texts in aligned columns
    const offsets = els.filter(e => e.t === 'text' && /^0x/.test(e.text ?? ''))
    assert.equal(new Set(tabs.map(t => Math.round(t.x - offsets.find(o => Math.abs(o.y - (t.y + 11)) < 0.01).x))).size, 1)
  }
})

test('every unusual note is shown whole, however many there are', () => {
  const file = quineFile()
  const sentence = i => `Note ${i}: sections are aligned to 0x4 bytes in the file and 0x4 in memory, where programs normally use 0x200 and 0x1000, and this goes on for a while.`
  const unusual = Array.from({ length: 12 }, (_, i) => ({ text: sentence(i + 1), offset: 0x40 + i * 4 }))
  const analysis = { ...file.analysis, unusual }
  const plan = quinePlan(file)
  for (const proportion of SHAPES) {
    for (const style of STYLES) {
      const { scene } = check({ plan, bytes: file.bytes, analysis, proportion, style })
      const lines = textOf(scene, 'unusual')
      assert.ok(!lines.some(line => line.includes('…')), `a note is cut: ${lines.find(line => line.includes('…'))}`)
      const joined = lines.join(' ').replace(/\s+/g, ' ')
      for (let i = 1; i <= 12; i++) assert.ok(joined.includes(sentence(i).slice(-28)), `note ${i} is not whole in ${proportion}`)
    }
  }
})

test('names on the file map and the memory diagram are whole or left out', () => {
  const file = sectionsFile(12)
  const names = ['.text', '.a-very-long-section-name', '.rdata', '.data']
  const analysis = {
    ...file.analysis,
    regions: file.analysis.regions.map((r, i) => ({ ...r, name: `${names[i % names.length]} region` })),
    image: { ...file.analysis.image, sections: file.analysis.image.sections.map((sec, i) => ({ ...sec, name: names[i % names.length] })) }
  }
  for (const proportion of SHAPES) {
    const { scene } = check({ plan: corkamiPlan({ ...file, analysis }), bytes: file.bytes, analysis, proportion })
    const cut = scene.elements.filter(e => e.t === 'text' && typeof e.text === 'string' && e.text.endsWith('…') && e.text.length > 1 && /region|^\.[a-z-]/.test(e.text))
    assert.deepEqual(cut.map(e => e.text), [])
  }
})

test('beside the dump the legend takes at most two columns, which may be wider', () => {
  const cases = [
    [sectionsFile(), file => corkamiPlan(file)],
    [sectionsFile(), file => corkamiPlan(file, { maxLabels: 36, maxRows: 40 })],
    [quineFile(), file => quinePlan(file)]
  ]
  let beside = 0
  let wider = 0
  for (const [file, planOf] of cases) {
    const plan = planOf(file)
    for (const proportion of SHAPES) {
      for (const style of STYLES) {
        const { scene } = check({ plan, bytes: file.bytes, analysis: file.analysis, proportion, style })
        const columns = new Set(scene.boxes.filter(b => b.role === 'legend').map(b => Math.round(b.x)))
        assert.equal(columns.size, scene.arrangement.columns)
        if (scene.arrangement.stacked) continue
        beside++
        assert.ok(columns.size <= 2, `${columns.size} legend columns beside the dump (${proportion}, ${scene.arrangement.layout})`)
        if (scene.arrangement.legendWidth > 384) wider++
      }
    }
  }
  assert.ok(beside >= 8, 'most arrangements put the legend beside the dump')
  assert.ok(wider > 0, 'some arrangement widens the columns')
})

test('the title facts wrap and are never cut', () => {
  const summary = [
    { label: 'Architecture', value: 'x86' }, { label: 'Timestamp', value: '0 (not set)' },
    { label: 'Characteristics', value: '0x102 (Executable image, 32-bit machine)' }, { label: 'Subsystem', value: 'Windows GUI' },
    { label: 'Entry point', value: 'RVA 0x61000' }, { label: 'Image base', value: '0x400000' },
    { label: 'Linker version', value: '0.0' }, { label: 'Overlay', value: 'none at all in this file' }
  ]
  const file = sectionsFile()
  const analysis = { ...file.analysis, summary }
  const plan = corkamiPlan({ ...file, analysis })
  for (const proportion of SHAPES) {
    for (const style of STYLES) {
      const { scene } = check({ plan, bytes: file.bytes, analysis, proportion, style })
      const facts = scene.elements.filter(e => e.g === 'band:title' || e.g === 'band:title+map').filter(e => e.spans && e.size === 12.5)
      const text = facts.map(e => e.spans.map(s => s.text).join('')).join('\n')
      for (const f of summary) assert.ok(text.includes(`${f.label} ${f.value}`), `${proportion}: ${f.label}`)
      assert.ok(!text.includes('…'))
    }
  }
  // Lines of the width asked for; a value longer than a line is the only thing cut
  const lines = factLines(summary, 520)
  assert.ok(lines.length >= 3)
  assert.deepEqual(lines.flat().map(f => f.value), summary.map(f => f.value))
  const huge = factLines([{ label: 'Note', value: 'x'.repeat(200) }, { label: 'A', value: 'b' }], 300)
  assert.ok(huge[0][0].value.endsWith('…'))
  assert.deepEqual(huge[1], [{ label: 'A', value: 'b' }])
})

test('the disk-versus-memory diagram needs two sections in memory', () => {
  const file = quineFile()
  const plan = quinePlan(file)
  const one = check({ plan, bytes: file.bytes, analysis: file.analysis })
  assert.ok(!one.scene.arrangement.bands.includes('memory'))
  assert.equal(one.scene.available.memory, false)
  const sections = file.analysis.image.sections
  const two = { ...file.analysis, image: { ...file.analysis.image, sections: [...sections, { name: '.d', offset: 0x2100, size: 0x100, address: 0x3000, memSize: 0x100 }] } }
  assert.equal(check({ plan, bytes: file.bytes, analysis: two }).scene.available.memory, true)
  const bss = { ...file.analysis, image: { ...file.analysis.image, sections: [...sections, { name: '.d', offset: 0x2100, size: 0x100, address: 0x3000, memSize: 0 }] } }
  assert.equal(check({ plan, bytes: file.bytes, analysis: bss }).scene.available.memory, false)
})

// Legend blocks of the given heights, drawn as plain boxes
function syntheticLegend(heights) {
  return heights.map((h, i) => ({
    type: i % 9 === 0 ? 'heading' : 'entry',
    h,
    draw(x, y, out) {
      out.elements.push({ t: 'rect', x, y, w: 384, h: h - 9, fill: '#888' })
      out.boxes.push({ role: 'legend', x, y, w: 384, h: h - 9 })
    }
  }))
}

test('the arrangement copes with legends of varied and great height', () => {
  const file = sectionsFile()
  const plan = corkamiPlan(file)
  // Wrapped entries: heights from 30 to 140; the same total in even blocks for comparison
  const varied = Array.from({ length: 99 }, (_, i) => [44, 61, 78, 30, 140, 44, 95][i % 7])
  const total = varied.reduce((a, b) => a + b, 0)
  const even = Array.from({ length: 99 }, () => total / 99)
  for (const proportion of SHAPES) {
    const a = check({ plan, bytes: file.bytes, analysis: file.analysis, proportion, legend: syntheticLegend(varied) }).scene
    const b = check({ plan, bytes: file.bytes, analysis: file.analysis, proportion, legend: syntheticLegend(even) }).scene
    assert.ok(Math.abs(a.width / a.height - PROPORTIONS[proportion]) < 0.01)
    assert.ok(a.width * a.height < b.width * b.height * 1.15, `${proportion}: ${a.width}×${a.height} against ${b.width}×${b.height}`)
    // Every block is drawn, inside the page
    assert.equal(a.boxes.filter(x => x.role === 'legend').length, 99)
  }
  // A few very tall blocks do not pile up in the last column
  const lumpy = syntheticLegend([400, 40, 40, 40, 400, 40, 40, 40, 400, 40, 40, 40])
  const flow = flowColumns(lumpy, 3)
  assert.equal(flow.cols.length, 3)
  assert.ok(flow.height <= 520, `tallest column ${flow.height}`)
  // With a minimum height the columns may be as tall as that
  assert.equal(flowColumns(lumpy, 3, 5000).cols.length, 1)
})
