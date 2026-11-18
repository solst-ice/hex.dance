import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOWNLOAD_TYPE, isPassiveType, passiveType } from './passive.js'

test('only raster images, audio, video and plain bytes may become an address', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'image/avif',
    'audio/mpeg', 'audio/wav', 'video/mp4', 'video/webm', 'application/octet-stream', 'IMAGE/PNG']) {
    assert.ok(isPassiveType(type), type)
  }
  for (const type of ['image/svg+xml', 'IMAGE/SVG+XML', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml',
    'image/svg+xml;charset=utf-8', 'image/png;x=1', 'image/png ', 'text/plain', 'application/pdf', 'text/javascript',
    'application/json', 'video/x+xml', 'audio/html', 'image/tiff', '', null, undefined, 42]) {
    assert.ok(!isPassiveType(type), String(type))
  }
})

test('passiveType keeps a passive type and turns everything else into plain bytes', () => {
  assert.equal(passiveType('image/png'), 'image/png')
  assert.equal(passiveType('Video/MP4'), 'video/mp4')
  assert.equal(passiveType('image/svg+xml'), DOWNLOAD_TYPE)
  assert.equal(passiveType('text/html'), DOWNLOAD_TYPE)
  assert.equal(passiveType('application/xhtml+xml'), DOWNLOAD_TYPE)
  assert.equal(passiveType(undefined), DOWNLOAD_TYPE)
})
