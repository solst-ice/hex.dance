/*
 * Timing and look of the CRT mode's glitches, kept free of the DOM so it can
 * be tested with a seeded random source. src/components/CrtScreen.jsx turns
 * these plans into attributes on <html>, the burst filter and the overlays.
 *
 * Two kinds of event:
 *   bursts  the picture itself tears, its colour channels pull apart and it
 *           jumps, through an SVG filter on the root element. A few seconds
 *           apart, 100 to 400 ms long, now and then a bigger one.
 *   blips   a few thin lines flicker on an overlay between bursts, so the
 *           screen never sits still for long. Nothing under them moves.
 *
 * Photosensitivity: neither changes the brightness of the whole screen.
 * Tearing, channel split and jumps move the picture without adding light;
 * the static band and blip lines cover a small part of it at low opacity,
 * and the band stays up for the whole burst instead of blinking.
 */

// Gap between the end of one burst and the start of the next, ms
export const BURST_GAP_MS = [2200, 7500]
// Now and then a burst comes straight after another, like a loose connector
export const REPEAT_CHANCE = 0.15
export const REPEAT_GAP_MS = [450, 1100]
export const BURST_MS = [100, 400]
export const BIG_CHANCE = 0.14
export const BIG_BURST_MS = [380, 650]
// How long the picture holds one distortion before the next replaces it
export const STEP_MS = [40, 110]

export const BLIP_GAP_MS = [250, 1600]
export const BLIP_MS = [50, 160]

// Kinds of burst, each with its own emphasis; "big" is all of them at once
export const BURST_KINDS = ['tear', 'split', 'roll', 'static']

// Entries in the band table: the noise is cut into this many levels, each
// shifting its rows by its own amount
const TABLE_SIZE = 12
// Static band limits, as fractions of the screen height and opacity
export const BAND_MAX_HEIGHT = 0.16
export const BAND_MAX_OPACITY = 0.3

/** A small seeded generator (mulberry32) returning numbers in [0, 1). */
export function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const between = (rand, [low, high]) => low + rand() * (high - low)
const int = (rand, low, high) => Math.floor(low + rand() * (high - low + 1))
const pick = (rand, list) => list[Math.floor(rand() * list.length)]
const sign = rand => (rand() < 0.5 ? -1 : 1)
const round = (value, places = 3) => Math.round(value * 10 ** places) / 10 ** places

/** Milliseconds from the end of a burst to the start of the next one. */
export function nextBurstDelay(rand) {
  if (rand() < REPEAT_CHANCE) return Math.round(between(rand, REPEAT_GAP_MS))
  return Math.round(between(rand, BURST_GAP_MS))
}

/** Milliseconds from the end of a blip to the next one. */
export function nextBlipDelay(rand) {
  return Math.round(between(rand, BLIP_GAP_MS))
}

/**
 * The band table for the tearing: TABLE_SIZE values around 0.5 (no shift).
 * The noise feeding it sits mostly in the middle levels, so those are the
 * ones that decide how much of the picture tears; `share` is roughly the
 * part of the rows that move.
 */
export function tearTable(rand, share, reach = 0.5) {
  return Array.from({ length: TABLE_SIZE }, () => {
    if (rand() >= share) return 0.5
    // Mostly small slips, sometimes a long one
    const amount = rand() < 0.7 ? between(rand, [0.08, 0.3]) : between(rand, [0.3, reach])
    return round(0.5 + sign(rand) * Math.min(amount, 0.5))
  })
}

/**
 * One distortion held for `ms`. Distances are in CSS pixels.
 *   seed, frequency  the noise that cuts the picture into bands of rows
 *                    (lower frequency, taller bands)
 *   table, scale     how far each band moves sideways: (value - 0.5) * scale
 *   rows             vertical slips inside bands, same encoding (big bursts)
 *   split            how far the red channel and the rest pull apart
 *   jump             vertical jump of the whole picture
 */
function planStep(rand, kind, big, ms) {
  const tear = kind === 'tear' || big
  const step = {
    ms,
    seed: int(rand, 1, 9999),
    frequency: round(between(rand, tear ? [0.004, 0.022] : [0.008, 0.03]), 4),
    table: tearTable(rand, tear ? between(rand, [0.35, 0.7]) : between(rand, [0.1, 0.3]), big ? 0.5 : 0.4),
    rows: Array.from({ length: TABLE_SIZE }, () => 0.5),
    scale: Math.round(tear ? between(rand, big ? [120, 260] : [50, 150]) : between(rand, [16, 50])),
    split: round(sign(rand) * (kind === 'split' || big ? between(rand, big ? [7, 16] : [5, 11]) : between(rand, [1.5, 4])), 1),
    jump: 0
  }
  if (kind === 'roll' || (big && rand() < 0.6)) step.jump = Math.round(sign(rand) * between(rand, big ? [10, 48] : [6, 28]))
  else if (rand() < 0.2) step.jump = Math.round(sign(rand) * between(rand, [2, 6]))
  if (big) step.rows = step.rows.map(value => (rand() < 0.25 ? round(value + sign(rand) * between(rand, [0.02, 0.07])) : value))
  return step
}

/**
 * A whole burst: its kind, steps and an optional band of static. Each burst
 * draws its own kind, strengths, seeds and offsets, so no two look alike.
 */
export function planBurst(rand) {
  const big = rand() < BIG_CHANCE
  const kind = big ? 'big' : pick(rand, BURST_KINDS)
  const duration = Math.round(between(rand, big ? BIG_BURST_MS : BURST_MS))

  const steps = []
  let left = duration
  while (left > 0) {
    const ms = Math.min(left, Math.round(between(rand, STEP_MS)))
    // A sliver too short to see is folded into the step before it
    if (ms < STEP_MS[0] / 2 && steps.length) steps[steps.length - 1].ms += ms
    else steps.push(planStep(rand, kind, big, ms))
    left -= ms
  }

  let band = null
  if (kind === 'static' || big || rand() < 0.25) {
    const height = round(between(rand, kind === 'static' || big ? [0.05, BAND_MAX_HEIGHT] : [0.02, 0.07]))
    band = {
      top: round(between(rand, [0, 1 - height])),
      height,
      opacity: round(between(rand, [0.16, BAND_MAX_OPACITY])),
      // The band slides a little while it is up, rather than blinking
      drift: round(sign(rand) * between(rand, [0, 0.08]))
    }
  }
  return { kind, big, duration, steps, band }
}

/**
 * A blip: one to three thin lines at random heights, bright or dark, held
 * for a moment. `top` is a fraction of the screen height, `height` pixels.
 */
export function planBlip(rand) {
  const count = int(rand, 1, 3)
  return {
    duration: Math.round(between(rand, BLIP_MS)),
    lines: Array.from({ length: count }, () => {
      const wide = rand() < 0.15
      return {
        top: round(rand()),
        height: wide ? int(rand, 4, 10) : int(rand, 1, 2),
        bright: rand() < 0.6,
        opacity: round(between(rand, wide ? [0.12, 0.25] : [0.25, 0.6]))
      }
    })
  }
}

const list = values => values.join(' ')

/**
 * Attributes for the burst filter's primitives, keyed by their role (the
 * component gives each primitive a matching data-role).
 */
export function filterAttributes(step) {
  const half = step.split / 2
  return {
    noise: { seed: String(step.seed), baseFrequency: `0 ${step.frequency}` },
    tearX: { tableValues: list(step.table) },
    tearY: { tableValues: list(step.rows) },
    tear: { scale: String(step.scale) },
    red: { dx: String(-half) },
    rest: { dx: String(half) },
    jump: { dy: String(step.jump) }
  }
}
