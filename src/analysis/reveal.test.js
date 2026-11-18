import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBytes } from './analyze.js'
import { buildZip } from '../formats/__fixtures__/fileFormats.js'
import { buildTar } from '../formats/__fixtures__/moreFormats.js'

const mark = code => `\u27E8U+${code}\u27E9`

test('names from the file show hidden characters as markers everywhere, with one warning', () => {
  const analysis = analyzeBytes(buildZip([
    { name: 'invoice\u202Efdp.exe', data: 'MZ', utf8: true },
    { name: 'pass\u200Bword.txt', data: 'x', utf8: true },
    { name: 'plain.txt', data: 'y' }
  ]))
  assert.deepEqual(analysis.entries.map(entry => entry.path), [`invoice${mark('202E')}fdp.exe`, `pass${mark('200B')}word.txt`, 'plain.txt'])
  const json = JSON.stringify(analysis)
  assert.ok(!json.includes('\u202E') && !json.includes('\u200B'))
  // The structure tree carries the names too
  const values = []
  const walk = fields => {
    for (const f of fields) {
      if (f.value) values.push(f.value)
      if (f.children) walk(f.children)
    }
  }
  walk(analysis.fields)
  assert.ok(values.includes(`invoice${mark('202E')}fdp.exe`))
  assert.deepEqual(analysis.warnings, [
    '2 names or values from the file contain hidden or direction-changing characters, such as a right-to-left override or a zero-width space, which can make a name look like something else. They are shown as markers like \u27E8U+202E\u27E9.'
  ])
})

test('an archive with ordinary names in any script gets no such warning', () => {
  const names = ['שלום/مرحبا.txt', 'می\u200Cخواهم.txt']
  const analysis = analyzeBytes(buildZip(names.map(name => ({ name, data: 'x', utf8: true }))))
  assert.deepEqual(analysis.warnings, [])
  assert.deepEqual(analysis.entries.map(entry => entry.path), names)
})

test('ZIP: entries that climb out, absolute paths and repeated names are warned about', () => {
  const analysis = analyzeBytes(buildZip([
    { name: '../../../etc/passwd', data: 'x' },
    { name: 'a/..\\..\\evil.dll', data: 'x' },
    { name: '/etc/cron.d/job', data: 'x' },
    { name: 'C:/Windows/evil.dll', data: 'x' },
    { name: 'readme.txt', data: 'one' },
    { name: 'readme.txt', data: 'two' }
  ]))
  assert.deepEqual(analysis.warnings, [
    '2 entries have paths that climb out of the folder being extracted to with ".." (such as "../../../etc/passwd"); a careless extractor would write them elsewhere on the disk',
    '2 entries have absolute paths (such as "/etc/cron.d/job"); a careless extractor would write them outside the folder being extracted to',
    '1 name appears more than once (such as "readme.txt"); extractors differ on which copy wins, so what one shows may not be what another extracts'
  ])
})

test('tar: the same warnings', () => {
  const analysis = analyzeBytes(buildTar([
    { name: '../escape.sh', data: 'x' },
    { name: '/abs.txt', data: 'x' },
    { name: 'same', data: 'a' },
    { name: 'same', data: 'b' }
  ]))
  assert.equal(analysis.formatId, 'tar')
  const has = text => assert.ok(analysis.warnings.includes(text), analysis.warnings.join('\n'))
  has('1 entry has a path that climbs out of the folder being extracted to with ".." (such as "../escape.sh"); a careless extractor would write it elsewhere on the disk')
  has('1 entry has an absolute path (such as "/abs.txt"); a careless extractor would write it outside the folder being extracted to')
  has('1 name appears more than once (such as "same"); extractors differ on which copy wins, so what one shows may not be what another extracts')
})

test('ordinary archives get no path warnings', () => {
  assert.deepEqual(analyzeBytes(buildZip([{ name: 'dir/' }, { name: 'dir/a..b.txt', data: 'x' }, { name: '.hidden', data: 'y' }])).warnings, [])
  assert.deepEqual(analyzeBytes(buildTar()).warnings, [])
})
