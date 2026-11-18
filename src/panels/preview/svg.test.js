import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CSS_HEIGHT, MAX_PIXELS, MAX_SIDE, decodeSvgText, fitCanvas, parseLength, parseViewBox, svgSize } from './svg.js'

test('parseLength reads absolute lengths and refuses the rest', () => {
  assert.equal(parseLength('120'), 120)
  assert.equal(parseLength(' 64px '), 64)
  assert.equal(parseLength('1in'), 96)
  assert.equal(parseLength('72pt'), 96)
  assert.ok(Math.abs(parseLength('2.54cm') - 96) < 1e-9)
  assert.equal(parseLength('1e2'), 100)
  for (const v of ['100%', 'auto', '0', '-5', '', 'abc', null, '10 px']) assert.equal(parseLength(v), null, String(v))
})

test('parseViewBox needs four numbers and a positive size', () => {
  assert.deepEqual(parseViewBox('0 0 100 50'), { x: 0, y: 0, width: 100, height: 50 })
  assert.deepEqual(parseViewBox('-5,-5, 10,20'), { x: -5, y: -5, width: 10, height: 20 })
  assert.equal(parseViewBox('0 0 0 10'), null)
  assert.equal(parseViewBox('0 0 10'), null)
  assert.equal(parseViewBox(null), null)
})

test('svgSize sizes an SVG as an image would', () => {
  assert.deepEqual(svgSize({ width: '200', height: '120', viewBox: null }),
    { width: 200, height: 120, intrinsic: true, fill: false, viewBox: '0 0 200 120' })
  assert.deepEqual(svgSize({ width: '200', height: '120', viewBox: '0 0 10 10' }),
    { width: 200, height: 120, intrinsic: true, fill: false, viewBox: '0 0 10 10' })
  assert.deepEqual(svgSize({ width: '300', height: null, viewBox: '0 0 30 10' }),
    { width: 300, height: 100, intrinsic: true, fill: false, viewBox: '0 0 30 10' })
  assert.deepEqual(svgSize({ width: '100%', height: '100%', viewBox: '0 0 400 100' }),
    { width: 400, height: 100, intrinsic: false, fill: true, viewBox: '0 0 400 100' })
  assert.deepEqual(svgSize({ width: null, height: null, viewBox: null }),
    { width: 300, height: 150, intrinsic: false, fill: false, viewBox: '0 0 300 150' })
  assert.deepEqual(svgSize({ width: '40', height: null, viewBox: null }),
    { width: 40, height: 150, intrinsic: true, fill: false, viewBox: '0 0 40 150' })
})

test('fitCanvas never enlarges, keeps the aspect ratio and draws at the screen density', () => {
  assert.deepEqual(fitCanvas({ width: 200, height: 100 }, 600, 1), { cssWidth: 200, cssHeight: 100, pixelWidth: 200, pixelHeight: 100 })
  assert.deepEqual(fitCanvas({ width: 200, height: 100 }, 600, 2), { cssWidth: 200, cssHeight: 100, pixelWidth: 400, pixelHeight: 200 })
  assert.deepEqual(fitCanvas({ width: 2000, height: 1000 }, 500, 2), { cssWidth: 500, cssHeight: 250, pixelWidth: 1000, pixelHeight: 500 })
  // Only a viewBox: fills the width, like an <img>
  assert.deepEqual(fitCanvas({ width: 40, height: 20, fill: true }, 600, 2), { cssWidth: 600, cssHeight: 300, pixelWidth: 1200, pixelHeight: 600 })
})

test('fitCanvas caps the pixels of huge and very tall drawings', () => {
  const tall = fitCanvas({ width: 400, height: 400000 }, 600, 2)
  assert.equal(tall.cssHeight, MAX_CSS_HEIGHT)
  assert.ok(Math.abs(tall.cssWidth - 4.096) < 1e-9)
  assert.ok(tall.pixelHeight <= MAX_SIDE && tall.pixelWidth * tall.pixelHeight <= MAX_PIXELS)
  const wide = fitCanvas({ width: 1e6, height: 1e6 }, 1e6, 3)
  assert.ok(wide.pixelWidth <= MAX_SIDE && wide.pixelWidth * wide.pixelHeight <= MAX_PIXELS)
  assert.ok(Math.abs(wide.pixelWidth / wide.pixelHeight - 1) < 0.01)
  const tiny = fitCanvas({ width: 0.2, height: 0.1 }, 600, 1)
  assert.ok(tiny.pixelWidth >= 1 && tiny.pixelHeight >= 1)
})

test('decodeSvgText follows the byte order mark, then the declaration', () => {
  const enc = s => new TextEncoder().encode(s)
  assert.equal(decodeSvgText(enc('﻿<svg/>')), '<svg/>')
  assert.equal(decodeSvgText(Uint8Array.from([0xff, 0xfe, 0x3c, 0, 0x73, 0])), '<s')
  assert.equal(decodeSvgText(Uint8Array.from([0xfe, 0xff, 0, 0x3c, 0, 0x73])), '<s')
  const latin = Uint8Array.from([...enc('<?xml version="1.0" encoding="ISO-8859-1"?><t>'), 0xe9, ...enc('</t>')])
  assert.ok(decodeSvgText(latin).includes('<t>é</t>'))
  assert.ok(decodeSvgText(enc('<?xml version="1.0" encoding="no-such"?><t/>')).includes('<t/>'))
})
