// Panels stay independent: code shared by several panels lives in src/lib,
// src/state or src/components, never in another panel's folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PANELS = dirname(fileURLToPath(import.meta.url))

const SOURCE = /\.(jsx?|mjs|css)$/
const SPECIFIERS = [
  /\bimport\s[^'"]*?from\s*['"]([^'"]+)['"]/g, // import x from '...'
  /\bexport\s[^'"]*?from\s*['"]([^'"]+)['"]/g, // export { x } from '...'
  /\bimport\s*['"]([^'"]+)['"]/g, // import '...'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('...')
  /\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g, // workers and assets
  /@import\s+(?:url\()?['"]([^'"]+)['"]/g // CSS
]

function filesUnder(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : SOURCE.test(name) ? [path] : []
  })
}

function importsOf(text) {
  const out = []
  for (const pattern of SPECIFIERS) {
    for (const match of text.matchAll(pattern)) out.push(match[1])
  }
  return out
}

// The panel folder a path is in, or null
function panelOf(path) {
  const rel = relative(PANELS, path)
  if (rel.startsWith('..') || !rel.includes(sep)) return null
  return rel.split(sep)[0]
}

test('finds every kind of import', () => {
  const text = `
    import a from '../x/a.js'
    import { b,
      c } from "../x/b.js"
    import '../x/c.css'
    export { d } from '../x/d.js'
    const e = await import('../x/e.js')
    const w = new Worker(new URL('../x/f.worker.js', import.meta.url), { type: 'module' })
    @import url('../x/g.css');
  `
  assert.deepEqual(importsOf(text).sort(), ['../x/a.js', '../x/b.js', '../x/c.css', '../x/d.js', '../x/e.js', '../x/f.worker.js', '../x/g.css'])
})

test('no panel imports from another panel\'s folder', () => {
  const crossings = []
  for (const file of filesUnder(PANELS)) {
    const from = panelOf(file)
    if (!from) continue
    for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      const target = resolve(dirname(file), specifier)
      const to = panelOf(target)
      if (!to || to === from) continue
      crossings.push(`${relative(PANELS, file)} imports ${specifier}`)
    }
  }
  assert.deepEqual(crossings, [], 'move shared code to src/lib, src/state or src/components')
})
