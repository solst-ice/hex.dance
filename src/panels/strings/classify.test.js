import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLASSES, classify } from './classify.js'

const bit = Object.fromEntries(CLASSES.map(c => [c.id, c.bit]))
const has = (text, id) => (classify(text) & bit[id]) !== 0

test('URLs', () => {
  assert.ok(has('see https://example.com/path?q=1 for details', 'url'))
  assert.ok(has('ftp://files.example.org/pub', 'url'))
  assert.ok(!has('http:// alone', 'url'))
  assert.ok(!has('just some text', 'url'))
})

test('IP addresses', () => {
  for (const ip of ['10.0.0.1', 'connect to 192.168.1.254:80', '::1', 'fe80::1ff:fe23:4567:890a', '2001:db8:0:0:0:0:2:1', '::ffff:192.0.2.128']) {
    assert.ok(has(ip, 'ip'), ip)
  }
  for (const text of ['999.1.1.1', '1.2.3.4.5', 'Version=4.0.0.0', 'std::vector', 'Base::Add', '12:34:56', 'aa:bb:cc:dd:ee:ff', '1:2:3', 'a::b::c1']) {
    assert.ok(!has(text, 'ip'), text)
  }
})

test('e-mail addresses', () => {
  assert.ok(has('Contact: someone.else+tag@mail.example.co.uk', 'email'))
  assert.ok(!has('user@localhost', 'email'))
  assert.ok(!has('@property.name', 'email'))
})

test('file paths', () => {
  for (const path of ['C:\\Windows\\System32\\kernel32.dll', '\\\\server\\share\\file', '%SystemRoot%\\system32', '/lib64/ld-linux-x86-64.so.2', '/usr/lib/debug', 'open "/etc/passwd"']) {
    assert.ok(has(path, 'path'), path)
  }
  for (const text of ['a/b', 'http://x.org/a/b/c', 'and/or', '1/2/3']) assert.ok(!has(text, 'path'), text)
})

test('registry keys', () => {
  assert.ok(has('HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor', 'registry'))
  assert.ok(has('Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'registry'))
  assert.ok(has('HKCU\\Control Panel', 'registry'))
  assert.ok(!has('C:\\Software\\thing', 'registry'))
})

test('GUIDs', () => {
  assert.ok(has('{6B29FC40-CA47-1067-B31D-00DD010662DA}', 'guid'))
  assert.ok(has('clsid 00020400-0000-0000-c000-000000000046', 'guid'))
  assert.ok(!has('6B29FC40-CA47-1067-B31D-00DD010662D', 'guid'))
})

test('format strings and messages', () => {
  for (const text of ['Error: cannot open %s', 'value=%d, count=%lu', 'Failed to allocate memory', 'usage: prog [options] file', '%s: invalid option -- %c', 'Writing %d bytes']) {
    assert.ok(has(text, 'message'), text)
  }
  for (const text of ['%dX#k', 'q%s7', '_ZN4node5errorE', 'GetLastError', 'error', 'xx%%yy']) {
    assert.ok(!has(text, 'message'), text)
  }
})

test('random printable noise rarely matches anything', () => {
  let seed = 7
  let matched = 0
  const next = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
  }
  for (let n = 0; n < 20000; n++) {
    let s = ''
    const len = 5 + (n % 12)
    for (let i = 0; i < len; i++) s += String.fromCharCode(0x20 + (next() % 95))
    if (classify(s)) matched++
  }
  assert.ok(matched < 20, `${matched} random strings classified`)
})
