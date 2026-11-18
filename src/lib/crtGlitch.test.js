import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BAND_MAX_HEIGHT, BAND_MAX_OPACITY, BIG_BURST_MS, BLIP_GAP_MS, BLIP_MS, BURST_GAP_MS, BURST_KINDS, BURST_MS, REPEAT_GAP_MS,
  STEP_MS, filterAttributes, nextBlipDelay, nextBurstDelay, planBlip, planBurst, seededRandom, tearTable
} from './crtGlitch.js'

const RUNS = 2000

test('the seeded source repeats itself and stays in [0, 1)', () => {
  const a = seededRandom(42)
  const b = seededRandom(42)
  const first = Array.from({ length: 50 }, a)
  assert.deepEqual(first, Array.from({ length: 50 }, b))
  assert.notDeepEqual(first, Array.from({ length: 50 }, seededRandom(43)))
  for (const value of first) assert.ok(value >= 0 && value < 1)
})

test('bursts come a few seconds apart, sometimes in quick pairs', () => {
  const rand = seededRandom(1)
  const gaps = Array.from({ length: RUNS }, () => nextBurstDelay(rand))
  for (const gap of gaps) {
    const ordinary = gap >= BURST_GAP_MS[0] && gap <= BURST_GAP_MS[1]
    const repeat = gap >= REPEAT_GAP_MS[0] && gap <= REPEAT_GAP_MS[1]
    assert.ok(ordinary || repeat, `gap ${gap}`)
  }
  const repeats = gaps.filter(gap => gap < BURST_GAP_MS[0]).length / RUNS
  assert.ok(repeats > 0.08 && repeats < 0.22, `repeat share ${repeats}`)
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / RUNS
  assert.ok(mean > 3000 && mean < 5500, `mean gap ${mean}`)
})

test('bursts last 100 to 400 ms, the occasional big one longer, and their steps add up', () => {
  const rand = seededRandom(2)
  let big = 0
  for (let i = 0; i < RUNS; i++) {
    const burst = planBurst(rand)
    const [low, high] = burst.big ? BIG_BURST_MS : BURST_MS
    assert.ok(burst.duration >= low && burst.duration <= high, `duration ${burst.duration}`)
    assert.equal(burst.steps.reduce((sum, step) => sum + step.ms, 0), burst.duration)
    for (const step of burst.steps) {
      assert.ok(step.ms >= STEP_MS[0] / 2, `step ${step.ms}`)
      assert.ok(step.ms <= STEP_MS[1] + STEP_MS[0] / 2, `step ${step.ms}`)
    }
    assert.equal(burst.kind === 'big', burst.big)
    if (!burst.big) assert.ok(BURST_KINDS.includes(burst.kind))
    if (burst.big) big++
  }
  assert.ok(big / RUNS > 0.08 && big / RUNS < 0.2, `big share ${big / RUNS}`)
})

test('no two bursts look the same and every kind turns up', () => {
  const rand = seededRandom(3)
  const bursts = Array.from({ length: 200 }, () => planBurst(rand))
  const fingerprints = new Set(bursts.map(burst => JSON.stringify(burst.steps[0])))
  assert.equal(fingerprints.size, bursts.length)
  const kinds = new Set(bursts.map(burst => burst.kind))
  for (const kind of [...BURST_KINDS, 'big']) assert.ok(kinds.has(kind), kind)
})

test('each kind leans on its own distortion', () => {
  const rand = seededRandom(4)
  const byKind = {}
  for (let i = 0; i < RUNS; i++) {
    const burst = planBurst(rand)
    ;(byKind[burst.kind] ||= []).push(burst)
  }
  const steps = kind => byKind[kind].flatMap(burst => burst.steps)
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
  assert.ok(mean(steps('tear').map(step => step.scale)) > 2 * mean(steps('split').map(step => step.scale)))
  assert.ok(mean(steps('split').map(step => Math.abs(step.split))) > 2 * mean(steps('tear').map(step => Math.abs(step.split))))
  assert.ok(steps('roll').every(step => step.jump !== 0))
  assert.ok(byKind.static.every(burst => burst.band))
  assert.ok(byKind.big.every(burst => burst.band))
})

test('the static band stays small and faint, so a burst never brightens the screen much', () => {
  const rand = seededRandom(5)
  for (let i = 0; i < RUNS; i++) {
    const { band } = planBurst(rand)
    if (!band) continue
    assert.ok(band.height > 0 && band.height <= BAND_MAX_HEIGHT)
    assert.ok(band.opacity > 0 && band.opacity <= BAND_MAX_OPACITY)
    assert.ok(band.top >= 0 && band.top + band.height <= 1.0001)
  }
})

test('tear tables stay in range and the share decides how much moves', () => {
  const rand = seededRandom(6)
  const moved = share => {
    let count = 0
    for (let i = 0; i < 300; i++) count += tearTable(rand, share).filter(value => value !== 0.5).length
    return count / (300 * 12)
  }
  for (let i = 0; i < 300; i++) for (const value of tearTable(rand, 0.6)) assert.ok(value >= 0 && value <= 1)
  assert.ok(Math.abs(moved(0.2) - 0.2) < 0.05)
  assert.ok(Math.abs(moved(0.6) - 0.6) < 0.05)
  assert.ok(tearTable(rand, 0).every(value => value === 0.5))
})

test('blips are short, thin and come often', () => {
  const rand = seededRandom(7)
  for (let i = 0; i < RUNS; i++) {
    const gap = nextBlipDelay(rand)
    assert.ok(gap >= BLIP_GAP_MS[0] && gap <= BLIP_GAP_MS[1])
    const blip = planBlip(rand)
    assert.ok(blip.duration >= BLIP_MS[0] && blip.duration <= BLIP_MS[1])
    assert.ok(blip.lines.length >= 1 && blip.lines.length <= 3)
    for (const line of blip.lines) {
      assert.ok(line.top >= 0 && line.top <= 1)
      assert.ok(line.height >= 1 && line.height <= 10)
      assert.ok(line.opacity > 0 && line.opacity <= 0.6)
    }
  }
})

test('filter attributes spell out a step for the SVG primitives', () => {
  const step = { ms: 60, seed: 12, frequency: 0.01, table: [0.5, 0.8, 0.2], rows: [0.5, 0.5, 0.5], scale: 90, split: -6, jump: 14 }
  assert.deepEqual(filterAttributes(step), {
    noise: { seed: '12', baseFrequency: '0 0.01' },
    tearX: { tableValues: '0.5 0.8 0.2' },
    tearY: { tableValues: '0.5 0.5 0.5' },
    tear: { scale: '90' },
    red: { dx: '3' },
    rest: { dx: '-3' },
    jump: { dy: '14' }
  })
})

test('tearing follows the width of the screen, within limits', () => {
  const step = { ms: 60, seed: 1, frequency: 0.01, table: [0.5], rows: [0.5], scale: 100, split: 4, jump: 0 }
  assert.equal(filterAttributes(step, 1440).tear.scale, '100')
  assert.equal(filterAttributes(step, 2880).tear.scale, '200')
  assert.equal(filterAttributes(step, 3440).tear.scale, '200')
  assert.equal(filterAttributes(step, 390).tear.scale, '60')
  assert.equal(filterAttributes(step, 390).red.dx, '-2')
})
