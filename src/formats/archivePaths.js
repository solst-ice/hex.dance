// Warnings about entry names in archives that a careless extractor would act
// on in a harmful or surprising way. Shared by the ZIP and tar parsers.

import { plural } from './reader.js'

const MAX_EXAMPLE = 80

function example(name) {
  return name.length > MAX_EXAMPLE ? `${name.slice(0, MAX_EXAMPLE)}…` : name
}

// ZIP specifies '/' as the separator, but extractors on Windows also split on '\'
const parts = name => name.split(/[/\\]/)

function isAbsolute(name) {
  return /^[/\\]/.test(name) || /^[A-Za-z]:/.test(name)
}

/**
 * @param {string[]} names  entry names as stored
 * @returns {string[]} warnings in plain words, none for ordinary archives
 */
export function pathWarnings(names) {
  const warnings = []
  const climbing = names.filter(name => parts(name).includes('..'))
  const absolute = names.filter(isAbsolute)
  const seen = new Set()
  const repeated = new Set()
  for (const name of names) {
    if (seen.has(name)) repeated.add(name)
    else seen.add(name)
  }
  if (climbing.length) {
    warnings.push(`${plural(climbing.length, 'entry has a path that climbs', 'entries have paths that climb')} out of the folder being extracted to with ".." (such as "${example(climbing[0])}"); a careless extractor would write ${climbing.length === 1 ? 'it' : 'them'} elsewhere on the disk`)
  }
  if (absolute.length) {
    warnings.push(`${plural(absolute.length, 'entry has an absolute path', 'entries have absolute paths')} (such as "${example(absolute[0])}"); a careless extractor would write ${absolute.length === 1 ? 'it' : 'them'} outside the folder being extracted to`)
  }
  if (repeated.size) {
    const first = repeated.values().next().value
    warnings.push(`${plural(repeated.size, 'name appears', 'names appear')} more than once (such as "${example(first)}"); extractors differ on which copy wins, so what one shows may not be what another extracts`)
  }
  return warnings
}
