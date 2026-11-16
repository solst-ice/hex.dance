import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { canCopyImage, copyImage, copyText } from './clipboard.js'

// Minimal stand-ins for the browser globals the module touches
const saved = {}
function stub(name, value) {
  if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
afterEach(() => {
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
    delete saved[name]
  }
})

function fakeDocument({ execResult = true } = {}) {
  const log = []
  const focused = { focus: options => log.push(['focus', options]) }
  const doc = {
    activeElement: focused,
    body: { appendChild: el => log.push(['append', el.value]) },
    createElement: () => ({
      style: {},
      setAttribute() {},
      select: () => log.push(['select']),
      remove: () => log.push(['remove'])
    }),
    execCommand: command => {
      log.push(['exec', command])
      if (execResult instanceof Error) throw execResult
      return execResult
    }
  }
  return { doc, log }
}

test('copies text with the async clipboard API', async () => {
  const written = []
  stub('navigator', { clipboard: { writeText: async text => written.push(text) } })
  assert.equal(await copyText('hello'), true)
  assert.deepEqual(written, ['hello'])
})

test('falls back to a hidden textarea and gives focus back', async () => {
  const { doc, log } = fakeDocument()
  stub('document', doc)
  stub('navigator', { clipboard: { writeText: async () => { throw new Error('denied') } } })
  assert.equal(await copyText('abc'), true)
  assert.deepEqual(log, [['append', 'abc'], ['select'], ['exec', 'copy'], ['remove'], ['focus', { preventScroll: true }]])

  const failing = fakeDocument({ execResult: new Error('nope') })
  stub('document', failing.doc)
  stub('navigator', {})
  assert.equal(await copyText('abc'), false)
})

test('copies an image when the browser can', async () => {
  stub('window', { isSecureContext: true, ClipboardItem: class { constructor(items) { this.items = items } } })
  const written = []
  stub('navigator', { clipboard: { write: async items => written.push(...items) } })
  assert.equal(canCopyImage(), true)
  const blob = Promise.resolve('png bytes')
  await copyImage(blob)
  assert.equal(written[0].items['image/png'], blob)
  stub('window', { isSecureContext: false, ClipboardItem: class {} })
  assert.equal(canCopyImage(), false)
})
