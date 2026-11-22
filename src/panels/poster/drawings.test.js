import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPoster } from './plan.js'
import { layoutPoster, PROPORTIONS } from './layout.js'
import { sceneToSvg } from './render.js'
import { posterColors } from './palette.js'
import { contentGroups, tilesCaption, tileParts, MAX_TILES } from './tiles.js'
import { unusualNotes } from './unusual.js'
import { MAX_CONNECTORS } from './pointers.js'

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
const SOLID = ['head', 'strip', 'arcs', 'unusual', 'tiles', 'memory', 'legend', 'ptag', 'rail', 'pend', 'dumptext']
const SELF = ['legend', 'tab', 'break', 'unusual', 'ptag', 'rail', 'pend', 'strip', 'head']

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
    for (const b of scene.boxes.filter(x => ['unusual', 'tiles', 'memory', 'strip', 'arcs', 'legend', 'ptag', 'rail'].includes(x.role))) {
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
  assert.deepEqual(plain.scene.available, { pointers: false, unusual: false, tiles: false, memory: true })
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
  const off = { pointers: false, unusual: false, tiles: false, memory: false }
  const { scene } = check({ plan, bytes: file.bytes, analysis: file.analysis, show: off })
  assert.deepEqual(scene.available, { pointers: true, unusual: true, tiles: true, memory: true })
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
