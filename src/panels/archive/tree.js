import { formatBytes } from '../../formats/shared.js'

export const MAX_TREE_ENTRIES = 1000

function newDirectory() {
  return { dirs: new Map(), files: [] }
}

/**
 * Builds a directory tree from archive entries. Paths are split on '/',
 * ignoring empty and '.' parts; directory entries add only their directories.
 * @param {import('../../analysis/types.js').ArchiveEntry[]} entries
 */
export function buildTree(entries) {
  const root = newDirectory()
  root.directoryCount = 0
  root.fileCount = 0
  for (const entry of entries) {
    const isDirectory = entry.isDirectory || entry.path.endsWith('/')
    const parts = entry.path.split('/').filter(part => part !== '' && part !== '.')
    if (parts.length === 0) continue
    const fileName = isDirectory ? null : parts.pop()
    let node = root
    for (const part of parts) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, newDirectory())
        root.directoryCount++
      }
      node = node.dirs.get(part)
    }
    if (fileName !== null) {
      node.files.push({ ...entry, baseName: fileName })
      root.fileCount++
    }
  }
  return root
}

// Code-unit order, so the listing does not depend on the browser's locale
function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function describeFile(file) {
  const details = [file.size === null ? 'size unknown' : formatBytes(file.size)]
  if (file.method && file.method !== 'stored') details.push(file.method)
  if (file.encrypted) details.push('encrypted')
  return `${file.baseName} (${details.join(', ')})`
}

/** Renders the tree as `tree`-style text, listing at most `maxEntries` nodes. */
export function renderTree(root, maxEntries = MAX_TREE_ENTRIES) {
  const lines = ['.']
  let rendered = 0

  function walk(node, prefix) {
    const children = [
      ...[...node.dirs.keys()].sort(compareNames).map(name => ({ name, dir: node.dirs.get(name) })),
      ...[...node.files].sort((a, b) => compareNames(a.baseName, b.baseName)).map(file => ({ file }))
    ]
    children.forEach((child, index) => {
      if (rendered >= maxEntries) return
      const last = index === children.length - 1
      rendered++
      if (child.dir) {
        lines.push(`${prefix}${last ? '└── ' : '├── '}${child.name}/`)
        walk(child.dir, prefix + (last ? '    ' : '│   '))
      } else {
        lines.push(`${prefix}${last ? '└── ' : '├── '}${describeFile(child.file)}`)
      }
    })
  }

  walk(root, '')
  const total = root.directoryCount + root.fileCount
  if (total > rendered) lines.push(`… and ${total - rendered} more`)
  return lines.join('\n')
}
