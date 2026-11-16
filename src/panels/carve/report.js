// Turns the scan's hits into what the panel says: which hit is the file
// itself, which are parts of another file's normal structure, which are
// discoveries, and what is unusual about the file as a whole. Pure.

import { hex, plural, sizeText } from './validate/common.js'

/** Hits that are a normal part of their parent's format, hidden unless asked for. */
const EXPECTED = {
  png: ['zlib'],
  pdf: ['zlib'],
  jpeg: ['jpeg', 'tiff'],
  pe: ['der'],
  ico: ['png', 'bmp'],
  tiff: ['jpeg'],
  heif: ['jpeg'],
  macho: ['macho']
}

const WHY = {
  appended: 'Programs that read the main file stop at its end, so whatever follows travels along unseen; that is how payloads are hidden in images and how installers carry their data.',
  overlay: 'Windows maps only the sections into memory, so installers, self-extractors and droppers keep their payload in this overlay.',
  prepended: 'Something that is not a recognised format comes first, as with a loader or firmware header in front of the real content.',
  polyglot: 'Different programs will see different content in the same file, which is used to slip files past filters and scanners.',
  zipAtEnd: 'ZIP readers look for the end record at the end of the file, so this file opens as a ZIP archive too, whatever comes first.',
  pdfShifted: 'PDF readers accept a header anywhere in the first 1024 bytes, so this file also opens as a PDF.',
  overlap: 'Two structures sharing bytes means at least one was crafted or damaged; each reader sees a different file.'
}

const byStart = (a, b) => a.start - b.start || ((b.end ?? Infinity) - b.start) - ((a.end ?? Infinity) - a.start)

const rank = { high: 3, medium: 2, low: 1 }

/**
 * @typedef {import('./scan.js').Hit & { role: 'main'|'embedded'|'internal', parent: number|null }} ReportHit
 * @typedef {{ kind: string, title: string, why: string, start: number, end: number }} Finding
 */

/**
 * @param {import('./scan.js').Hit[]} rawHits
 * @param {{ size: number, lastNonZero?: number, formatId?: string|null }} file
 *   `formatId`: what the app's analysis says the file is, to pick the main hit
 */
export function buildReport(rawHits, { size, lastNonZero = size - 1, formatId = null }) {
  const hits = rawHits.map(h => ({ ...h, role: 'embedded', parent: null })).sort(byStart)
  const atZero = hits.filter(h => h.start === 0)
  let main = null
  if (atZero.length) {
    main = atZero.find(h => formatId && (h.module === formatId || h.type === formatId)) ||
      [...atZero].sort((a, b) => rank[b.confidence] - rank[a.confidence] || (b.end ?? size) - (a.end ?? size))[0]
    main.role = 'main'
  }

  // Innermost enclosing hit with a known end
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    if (h === main) continue
    let parent = null
    for (let j = i - 1; j >= 0; j--) {
      const p = hits[j]
      if (p.end === null || p.start > h.start || p.end <= h.start) continue
      if (h.end !== null && h.end > p.end) continue
      if (p.start === h.start && p === main) {
        parent = null
        break
      }
      if (!parent || p.end - p.start < parent.end - parent.start) parent = p
    }
    if (!parent && main && main.end !== null && h.start < main.end && h.start > 0 && (h.end === null || h.end <= main.end)) parent = main
    if (parent) {
      h.parent = parent.id
      if ((EXPECTED[parent.type] || []).includes(h.type)) h.role = 'internal'
    }
  }

  const findings = []
  const byId = new Map(hits.map(h => [h.id, h]))
  const embedded = hits.filter(h => h.role === 'embedded')
  const describe = (list) => {
    const names = [...new Set(list.map(h => h.name))]
    return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
  }

  if (main && main.end !== null && main.end < size) {
    const tail = size - main.end
    const inside = embedded.filter(h => h.start >= main.end)
    const zeros = main.end > lastNonZero
    const isPE = main.type === 'pe'
    findings.push({
      kind: isPE ? 'overlay' : 'appended',
      title: zeros
        ? `${sizeText(tail)} of zero bytes after the end of the ${main.name}`
        : `${sizeText(tail)} after the end of the ${main.name}${isPE ? ' (overlay)' : ''}${inside.length ? `, containing ${describe(inside)}` : ''}`,
      why: zeros ? 'Usually just padding, but worth knowing: the bytes are not part of the file\'s structure.' : isPE ? WHY.overlay : WHY.appended,
      start: main.end,
      end: size,
      severity: zeros ? 'info' : 'notice'
    })
  }

  if (!main && hits.length) {
    const first = hits[0]
    findings.push({
      kind: 'prepended',
      title: `${sizeText(first.start)} before the first recognised structure (${first.name} at ${hex(first.start)})`,
      why: WHY.prepended,
      start: 0,
      end: first.start,
      severity: 'notice'
    })
  }

  if (!main && hits.length) {
    const ends = hits.filter(h => h.end !== null && h.role !== 'internal')
    const lastEnd = ends.length ? Math.max(...ends.map(h => h.end)) : -1
    const beyond = hits.some(h => h.start >= lastEnd)
    if (lastEnd > 0 && lastEnd < size && !beyond && lastNonZero >= lastEnd) {
      findings.push({
        kind: 'trailing',
        title: `${sizeText(size - lastEnd)} after the last recognised structure, from ${hex(lastEnd)}`,
        why: 'Nothing known starts there, so it may be raw data, a format without a signature, or padding.',
        start: lastEnd,
        end: size,
        severity: 'info'
      })
    }
  }

  if (main) {
    for (const other of atZero) {
      if (other === main || rank[other.confidence] < 2 || other.type === main.type) continue
      other.role = 'embedded'
      other.parent = null
      findings.push({
        kind: 'polyglot',
        title: `Valid as both ${main.name} and ${other.name} from offset 0`,
        why: WHY.polyglot,
        start: 0,
        end: other.end ?? size,
        severity: 'notice'
      })
    }
    for (const h of hits) {
      if (h === main || h.role === 'internal' || h.start === 0) continue
      if (h.type === 'zip' && h.end === size && main.type !== 'zip') {
        findings.push({ kind: 'polyglot', title: `Also a ZIP archive: its end record is at the end of the file (archive at ${hex(h.start)})`, why: WHY.zipAtEnd, start: h.start, end: size, severity: 'notice' })
      } else if (h.type === 'pdf' && h.start <= 1024 && main.type !== 'pdf') {
        findings.push({ kind: 'polyglot', title: `Also a PDF: its header is at ${hex(h.start)}, within the first 1024 bytes`, why: WHY.pdfShifted, start: h.start, end: h.end ?? size, severity: 'notice' })
      }
    }
  }

  // Partial overlaps between hits that do not nest
  let overlaps = 0
  for (let i = 0; i < hits.length && overlaps < 5; i++) {
    const a = hits[i]
    if (a.end === null || a.role === 'internal') continue
    for (let j = i + 1; j < hits.length && hits[j].start < a.end && overlaps < 5; j++) {
      const b = hits[j]
      if (b.end === null || b.end <= a.end || b.start === a.start || b.role === 'internal' || b.type === a.type) continue
      if (a === main && b.type === 'zip' && b.end === size) continue
      overlaps++
      findings.push({
        kind: 'overlap',
        title: `${a.name} at ${hex(a.start)} and ${b.name} at ${hex(b.start)} overlap by ${sizeText(a.end - b.start)}`,
        why: WHY.overlap,
        start: b.start,
        end: a.end,
        severity: 'notice'
      })
    }
  }

  const internal = hits.filter(h => h.role === 'internal').length
  const discoveries = hits.filter(h => h.role === 'embedded')
  let summary
  if (!hits.length) {
    summary = 'No embedded files found: no known signature passed validation.'
  } else if (!discoveries.length) {
    summary = main ? `Nothing embedded beyond the main ${main.name}.` : 'No embedded files found.'
  } else if (main) {
    const after = main.end !== null && discoveries.every(h => h.start >= main.end)
    const within = main.end !== null && discoveries.every(h => h.start < main.end)
    const where = after ? 'after' : within ? 'inside' : 'besides'
    summary = `${plural(discoveries.length, 'embedded file')} found ${where} the main ${main.name}.`
  } else {
    summary = `${plural(discoveries.length, 'file')} found; none of them starts at offset 0.`
  }

  for (const h of hits) {
    if (h.parent !== null) {
      const p = byId.get(h.parent)
      h.parentLabel = p ? `${p === main ? 'the main ' : ''}${p.name} at ${hex(p.start)}` : ''
      h.parentType = p ? p.type.toUpperCase() : ''
    }
  }

  return { hits, main, findings, summary, internal, discoveries: discoveries.length }
}

/**
 * Where an extract or selection of a hit ends: its own end, or for an
 * unknown end the next hit that starts after it, or the end of the file.
 * @param {'next'|'eof'} mode
 */
export function rangeEnd(hit, hits, size, mode = 'next') {
  if (hit.end !== null) return hit.end
  if (mode === 'next') {
    for (const h of hits) {
      if (h.start > hit.start && h.role !== 'internal' && h.parent !== hit.id) return h.start
    }
  }
  return size
}

/** "photo.jpg" + a ZIP at 0x1A2B → "photo-0x1A2B.zip" */
export function extractName(fileName, hit) {
  const base = String(fileName || 'file').replace(/\.[^./\\]{1,8}$/, '') || 'file'
  return `${base}-${hex(hit.start)}.${hit.ext || 'bin'}`
}
