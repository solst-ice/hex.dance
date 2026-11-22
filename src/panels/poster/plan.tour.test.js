import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPoster, MAX_LINKS, BYTES_PER_ROW, DEPTHS, LABEL_LIMITS } from './plan.js'
import { buildPoster } from './render.js'
import { leadingNumber, zeroText, nameStem } from './planTree.js'

function analysisWith(fields, extra = {}) {
  return { formatId: 'test', formatName: 'Test format', category: 'data', summary: [], fields, regions: [], symbols: [], entries: [], warnings: [], ...extra }
}

const hex = n => '0x' + n.toString(16).toUpperCase()
const overlaps = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01

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
}

function assertPlanSane(plan) {
  assert.ok(plan.items.length <= plan.maxRows, `${plan.items.length} items for ${plan.maxRows} rows`)
  assert.ok(plan.labels.length <= Math.max(plan.maxLabels, 0) + 64)
  for (let i = 1; i < plan.labels.length; i++) {
    assert.ok(plan.labels[i].offset >= plan.labels[i - 1].offset + plan.labels[i - 1].length, 'labels overlap or are out of file order')
    assert.equal(plan.labels[i].number, i + 1)
  }
  for (let i = 1; i < plan.items.length; i++) assert.ok(plan.items[i].start >= plan.items[i - 1].end, 'items out of order')
}

/**
 * A small Windows-like program: a mostly zero DOS header with a pointer, a
 * section table of `count` entries, section data no field covers, and an
 * entry point in the last section.
 */
function fakeProgram(count = 24) {
  const tableAt = 0x80
  const dataAt = 0x400
  const size = dataAt + count * 0x200
  const bytes = new Uint8Array(size)
  bytes[0] = 0x4d
  bytes[1] = 0x5a
  bytes[0x3c] = 0x40
  for (let i = 0; i < count; i++) bytes.fill(0x90 + (i % 7), dataAt + i * 0x200, dataAt + (i + 1) * 0x200)
  const dosNames = ['e_cblp', 'e_cp', 'e_crlc', 'e_cparhdr', 'e_minalloc', 'e_maxalloc', 'e_ss', 'e_sp', 'e_csum', 'e_ip', 'e_cs', 'e_lfarlc', 'e_ovno']
  const dos = dosNames.map((name, i) => ({ name, offset: 2 + i * 2, length: 2, kind: 'data', value: '0x0' }))
  dos.push({ name: 'e_res', offset: 0x1c, length: 0x20, kind: 'padding' })
  dos.push({ name: 'e_lfanew', offset: 0x3c, length: 4, kind: 'offset', value: '0x40', target: 0x40 })
  for (let i = 0x40; i < 0x44; i++) bytes[i] = 0x50
  const entries = Array.from({ length: count }, (_, i) => {
    const at = tableAt + i * 32
    return {
      name: `[${i}] .s${i}`, offset: at, length: 32, kind: 'header', value: `raw ${hex(dataAt + i * 0x200)}`,
      children: [
        { name: 'Name', offset: at, length: 8, kind: 'string', value: `.s${i}` },
        { name: 'VirtualAddress', offset: at + 8, length: 4, kind: 'offset', value: hex(0x1000 * (i + 1)) },
        { name: 'SizeOfRawData', offset: at + 12, length: 4, kind: 'size', value: '0x200' },
        { name: 'PointerToRawData', offset: at + 16, length: 4, kind: 'offset', value: hex(dataAt + i * 0x200), target: dataAt + i * 0x200 },
        { name: 'Characteristics', offset: at + 20, length: 12, kind: 'flags', value: '0x60000020 (Code, Executable)' }
      ]
    }
  })
  for (let i = tableAt; i < tableAt + count * 32; i++) bytes[i] = 1 + (i % 5)
  const fields = [
    { name: 'DOS signature', offset: 0, length: 2, kind: 'magic', value: 'MZ' },
    { name: 'DOS header', offset: 2, length: 62, kind: 'header', children: dos },
    { name: 'PE signature', offset: 0x40, length: 4, kind: 'magic', value: 'PE' },
    { name: 'Entry', offset: 0x44, length: 4, kind: 'offset', value: 'last section', target: dataAt + (count - 1) * 0x200 },
    { name: 'Section table', offset: tableAt, length: count * 32, kind: 'header', value: `${count} sections`, children: entries }
  ]
  const regions = [
    { name: 'Headers', offset: 0, length: tableAt + count * 32, kind: 'header' },
    ...Array.from({ length: count }, (_, i) => ({ name: `Section ${i + 1}`, offset: dataAt + i * 0x200, length: 0x200, kind: 'code' }))
  ]
  return { bytes, size, analysis: analysisWith(fields, { regions }), dataAt, count }
}

test('number and name helpers', () => {
  assert.equal(leadingNumber('0x200').n, 0x200n)
  assert.equal(leadingNumber('3,617 bytes').n, 3617n)
  assert.equal(leadingNumber('x86'), null)
  assert.ok(zeroText('0x0 (none)'))
  assert.ok(zeroText('empty'))
  assert.ok(!zeroText('0x10B (PE32)'))
  assert.equal(nameStem('[12] LOAD'), 'load')
  assert.equal(nameStem('Section 12'), nameStem('Section 3'))
  assert.notEqual(nameStem('e_cblp'), nameStem('e_cp'))
})

test('a section table collapses to its first and last entry, with what they share', () => {
  const { bytes, size, analysis, count } = fakeProgram(24)
  const plan = planPoster({ analysis, size, bytes, maxLabels: 60 })
  assertPlanSane(plan)
  const rep = plan.repeats.find(r => r.first === '[0] .s0')
  assert.ok(rep, 'section table repeat found')
  assert.equal(rep.count, count)
  assert.equal(rep.entryLength, 32)
  assert.match(rep.text, /^24 entries of 32 bytes\./)
  assert.match(rep.text, /SizeOfRawData 0x200/)
  assert.match(rep.text, /Characteristics 0x60000020/)
  assert.match(rep.text, /VirtualAddress goes up by 0x1000 each time, PointerToRawData by 0x200/)
  const brk = plan.items.find(i => i.type === 'break' && i.repeat && i.repeat.id === rep.id)
  assert.ok(brk, 'a break stands for the skipped entries')
  assert.equal(brk.repeat.count, count - 2)
  assert.equal(brk.repeat.start, 0x80 + 32)
  assert.equal(brk.repeat.end, 0x80 + (count - 1) * 32)
  // First entry in full, last as one box
  const last = plan.labels.find(l => l.name === `[${count - 1}] .s${count - 1}`)
  assert.ok(last && last.repeat.role === 'last')
  assert.ok(plan.labels.some(l => l.name === 'VirtualAddress' && l.offset < 0x80 + 32))
  assert.ok(!plan.labels.some(l => l.offset >= 0x80 + 32 && l.offset < 0x80 + (count - 1) * 32))
  // The section data regions repeat too
  const data = plan.repeats.find(r => r.first === 'Section 1' || r.first === 'Section 2')
  assert.ok(data)
  assert.match(data.text, /regions of 512 bytes/)
})

test('entries whose layouts differ are not collapsed', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({
    name: `[${i}]`, offset: i * 16, length: 16, kind: 'header',
    children: [{ name: i % 2 ? 'tag' : 'type', offset: i * 16, length: 4, kind: 'data', value: '1' }, { name: 'body', offset: i * 16 + 4, length: 12, kind: 'data', value: '2' }]
  }))
  const plan = planPoster({ analysis: analysisWith([{ name: 'Table', offset: 0, length: 192, kind: 'header', children: entries }]), size: 192, maxLabels: 99 })
  assert.equal(plan.repeats.length, 0)
  // Distinctly named single fields of one size are not a repeat either
  const fields = ['e_cblp', 'e_cp', 'e_crlc', 'e_ss', 'e_sp', 'e_ip'].map((name, i) => ({ name, offset: i * 2, length: 2, kind: 'data', value: String(i + 1) }))
  const flat = planPoster({ analysis: analysisWith(fields), size: 12 })
  assert.equal(flat.repeats.length, 0)
  assert.equal(flat.labels.length, 6)
  // A run of differently named records that is not most of its list needs matching names
  const segments = ['SOI', 'APP0', 'DQT', 'DQT', 'SOF0', 'DHT', 'DHT', 'DHT', 'DHT', 'SOS', 'EOI', 'COM', 'COM'].map((name, i) => ({
    name, offset: i * 8, length: 8, kind: 'header',
    children: [{ name: 'Marker', offset: i * 8, length: 2 }, { name: 'Length', offset: i * 8 + 2, length: 2 }, { name: 'Payload', offset: i * 8 + 4, length: 4 }]
  }))
  const jpeg = planPoster({ analysis: analysisWith(segments), size: 104, maxLabels: 99 })
  assert.equal(jpeg.repeats.length, 1)
  assert.equal(jpeg.repeats[0].count, 4)
  assert.equal(jpeg.repeats[0].first, 'DHT')
})

test('a pinned entry inside a repeat is labelled, splitting the run', () => {
  const { bytes, size, analysis } = fakeProgram(24)
  const pinAt = 0x80 + 10 * 32
  const plan = planPoster({ analysis, size, bytes, pins: [{ offset: pinAt + 8, length: 4 }, { offset: 3, length: 7 }] })
  assertPlanSane(plan)
  const pinned = plan.labels.find(l => l.offset === pinAt + 8)
  assert.ok(pinned && pinned.pinned, 'the pinned field has its own label')
  const breaks = plan.items.filter(i => i.repeat && i.repeat.end <= 0x80 + 24 * 32)
  assert.deepEqual(breaks.map(b => b.repeat.count), [9, 12])
  assert.equal(plan.pins.ignored, 1)
  // A pinned entry with children is shown down to the chosen depth
  const deep = planPoster({ analysis, size, bytes, depth: 3, pins: [{ offset: pinAt, length: 32 }] })
  assert.ok(deep.labels.some(l => l.name === 'VirtualAddress' && l.offset === pinAt + 8))
})

test('runs of zero and reserved fields merge into one box', () => {
  const { bytes, size, analysis } = fakeProgram(8)
  const plan = planPoster({ analysis, size, bytes, mode: 'auto' })
  const merged = plan.labels.find(l => l.merged)
  assert.ok(merged)
  assert.equal(merged.name, 'e_cblp to e_res')
  assert.equal(merged.value, '14 fields, all zero')
  assert.equal(merged.merged.count, 14)
  assert.ok(plan.labels.some(l => l.name === 'e_lfanew'))
  // Without bytes the value text decides
  const noBytes = planPoster({ analysis, size, mode: 'auto' })
  assert.equal(noBytes.labels.find(l => l.merged).value, '14 fields, zero or reserved')
  // A pointer, a magic number or a pinned field is never merged away
  const fields = [
    { name: 'a', offset: 0, length: 4, value: '0' },
    { name: 'b', offset: 4, length: 4, value: '0', target: 0 },
    { name: 'c', offset: 8, length: 4, value: '0' },
    { name: 'd', offset: 12, length: 4, value: '0' }
  ]
  const kept = planPoster({ analysis: analysisWith(fields), size: 16, bytes: new Uint8Array(16), pins: [{ offset: 0, length: 4 }] })
  assert.deepEqual(kept.labels.map(l => l.name), ['a', 'b', 'c to d'])
})

test('the least interesting labels are dropped first, and numbers stay in file order', () => {
  const fields = Array.from({ length: 40 }, (_, i) => (i % 4 === 0
    ? { name: `count${String.fromCharCode(97 + i)}`, offset: i * 4, length: 4, kind: 'count', value: String(i + 1) }
    : { name: `rsv${String.fromCharCode(97 + i)}`, offset: i * 4, length: 4, kind: 'data', value: '0x0', description: 'Reserved' }))
  // Space the dull fields apart so they cannot merge
  const spaced = fields.map((f, i) => ({ ...f, offset: i * 8 }))
  const plan = planPoster({ analysis: analysisWith(spaced), size: 320, mode: 'selection', range: { start: 0, end: 320 }, maxLabels: 12 })
  assert.equal(plan.labels.length, 12)
  assert.equal(plan.labels.filter(l => l.kind === 'count').length, 10)
  assertPlanSane(plan)
})

test('a tour labels every top-level structure, uses its rows and lands every pointer', () => {
  const { bytes, size, analysis, dataAt, count } = fakeProgram(24)
  for (const bytesPerRow of BYTES_PER_ROW) {
    const plan = planPoster({ analysis, size, bytes, bytesPerRow })
    assertPlanSane(plan)
    assert.equal(plan.mode, 'tour')
    for (const root of analysis.fields) {
      const covered = plan.labels.some(l => l.offset >= root.offset && l.offset < root.offset + root.length)
      assert.ok(covered, `${root.name} has a box at ${bytesPerRow} bytes per row`)
    }
    const rows = plan.items.filter(i => i.type === 'row').length
    assert.ok(plan.items.length >= plan.maxRows - 2, `uses its rows: ${plan.items.length} of ${plan.maxRows}`)
    assert.ok(rows >= 20)
    // The end of the file is on the poster, and the entry point lands on a drawn row in a labelled region
    assert.equal(plan.shown.end, size)
    const entry = plan.pointers.find(p => p.offset === 0x44)
    assert.ok(entry && entry.targetShown, 'entry point target is drawn')
    const holder = plan.labels.find(l => l.number === entry.targetLabel)
    assert.equal(holder.offset, dataAt + (count - 1) * 0x200)
    assert.ok(holder.region)
    for (const p of plan.pointers) {
      assert.ok(plan.labels[p.from - 1], 'pointer from a label')
      if (p.targetShown) assert.ok(plan.items.some(i => i.type === 'row' && p.target >= i.start && p.target < i.end))
    }
  }
})

test('links list every pointer in file order, at most MAX_LINKS', () => {
  const fields = Array.from({ length: 600 }, (_, i) => ({ name: `p${i}`, offset: (599 - i) * 4, length: 4, kind: 'offset', target: (i * 7) % 2400 }))
  const plan = planPoster({ analysis: analysisWith(fields), size: 2400 })
  assert.equal(plan.links.length, MAX_LINKS)
  for (let i = 1; i < plan.links.length; i++) assert.ok(plan.links[i].offset >= plan.links[i - 1].offset)
  assert.equal(plan.links[0].offset, 0)
  assert.ok(plan.pointers.length > 0)
  assert.ok(plan.pointers.length <= plan.labels.length)
})

test('start-of-file, selection and field modes still work', () => {
  const { bytes, size, analysis } = fakeProgram(24)
  const auto = planPoster({ analysis, size, bytes, mode: 'auto' })
  assert.equal(auto.mode, 'auto')
  assert.equal(auto.items[0].start, 0)
  assert.ok(auto.labels.every(l => l.offset < 0x80 + 24 * 32))
  assert.ok(auto.items.some(i => i.repeat), 'repeat collapse in auto mode')
  const sel = planPoster({ analysis, size, bytes, mode: 'selection', range: { start: 0x40, end: 0x80 } })
  assert.equal(sel.mode, 'selection')
  assert.deepEqual(sel.window, { start: 0x40, end: 0x80 })
  assert.ok(sel.labels.every(l => l.end <= 0x80 && l.start >= 0x40))
  const field = planPoster({ analysis, size, bytes, mode: 'field', fieldIndex: 4 })
  assert.equal(field.mode, 'field')
  assert.deepEqual(field.window, { start: 0x80, end: 0x80 + 24 * 32 })
  assert.equal(field.parents[0].name, 'Section table')
  assert.ok(field.repeats.length === 1)
  // An unknown mode falls back to the tour
  assert.equal(planPoster({ analysis, size, mode: 'nonsense' }).mode, 'tour')
})

test('hostile trees stay bounded and quick', () => {
  const cases = []
  cases.push(Array.from({ length: 100000 }, (_, i) => ({ name: `s${i}`, offset: i * 2, length: 2, kind: 'data', value: String(i) })))
  cases.push(Array.from({ length: 100000 }, (_, i) => ({ name: 'same', offset: i % 7, length: 50 - (i % 50), children: [{ name: 'x', offset: 0, length: 1e9 }] })))
  cases.push([{ name: 'neg', offset: 4, length: -5 }, { name: 'zero', offset: 4, length: 0 }, { name: 'nan', offset: NaN, length: 4 }, { name: 'past', offset: 1e7, length: 4 }, { name: 'half', offset: 0, length: 0.5 }, 'str', null, 7])
  // Deep chain and a node that is its own child
  let deep = { name: 'leaf', offset: 0, length: 1 }
  for (let i = 0; i < 5000; i++) deep = { name: `d${i}`, offset: 0, length: 100, children: [deep] }
  cases.push([deep])
  const self = { name: 'self', offset: 0, length: 64 }
  self.children = [self, self]
  cases.push([self])
  // Wide and repeated at every level
  cases.push(Array.from({ length: 300 }, (_, i) => ({
    name: `[${i}]`, offset: i * 600, length: 600,
    children: Array.from({ length: 300 }, (_, j) => ({ name: `f${j % 3}`, offset: i * 600 + j * 2, length: 2, kind: 'size', value: hex(j), target: (i * j) % 180000 }))
  })))
  const size = 200000
  const bytes = new Uint8Array(size)
  for (const fields of cases) {
    const regions = Array.from({ length: 5000 }, (_, i) => ({ name: `r${i}`, offset: i * 40, length: 40, kind: i % 2 ? 'code' : 'padding' }))
    for (const extra of [{}, { depth: 4, maxLabels: 99, maxRows: 200 }, { mode: 'auto' }, { pins: Array.from({ length: 200 }, (_, i) => ({ offset: i * 2, length: 2 })) }]) {
      const t = performance.now()
      const plan = planPoster({ analysis: analysisWith(fields, { regions }), size, bytes, ...extra })
      const ms = performance.now() - t
      assert.ok(ms < 400, `plan took ${ms.toFixed(0)} ms`)
      assertPlanSane(plan)
      assert.ok(plan.links.length <= MAX_LINKS)
    }
  }
})

test('posters stay tidy across bytes per row, depth, label limits and styles', () => {
  const { bytes, analysis } = fakeProgram(24)
  for (const bytesPerRow of BYTES_PER_ROW) {
    for (const depth of DEPTHS) {
      for (const maxLabels of LABEL_LIMITS) {
        for (const style of ['dark', 'print']) {
          const result = buildPoster({ bytes, analysis, fileName: 'fake.exe', options: { bytesPerRow, depth, maxLabels, style }, date: '2026-11-22' })
          assertTidy(result)
          assertPlanSane(result.plan)
        }
      }
    }
  }
})

test('the poster says what was left out, and the breaks name skipped entries', () => {
  const { bytes, analysis } = fakeProgram(24)
  const result = buildPoster({ bytes, analysis, fileName: 'fake.exe', options: { maxLabels: 12 }, date: '2026-11-22' })
  assert.match(result.svg, /22 more entries, same layout \(0xA0–0x35F\)/)
  assert.match(result.svg, /Repeated: \[0\] \.s0 to \[23\] \.s23/)
  assert.match(result.svg, /not labelled, to keep to 12 labels/)
  assert.match(result.svg, /Dashed boxes/)
  assert.match(result.svg, /stroke-dasharray/)
})
