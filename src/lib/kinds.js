// Colours and plain-language meanings for field and region kinds. Colours are
// CSS variables (see kinds.css) so a theme can change them.

const FIELD_KINDS = {
  magic: ['Magic', 'Fixed bytes that identify the format or a record type'],
  header: ['Header', 'A structural value that describes what follows'],
  size: ['Size', 'A length in bytes, or a width or height'],
  count: ['Count', 'How many items of something follow'],
  offset: ['Offset', 'A position in the file that points somewhere else'],
  flags: ['Flags', 'Bits that switch options on or off'],
  string: ['Text', 'Characters: a name, keyword or comment'],
  checksum: ['Checksum', 'A value computed from other bytes, used to detect damage'],
  data: ['Data', 'Content the format carries: pixels, compressed data, payloads'],
  padding: ['Padding', 'Filler or separator bytes with no meaning of their own']
}

const REGION_KINDS = {
  header: 'Header',
  code: 'Code',
  data: 'Data',
  table: 'Table',
  metadata: 'Metadata',
  padding: 'Padding',
  other: 'Other',
  gap: 'Unmapped',
  mixed: 'Several regions'
}

/** A kind name that has a colour; unknown kinds fall back to 'other'. */
export function fieldKind(kind) {
  return FIELD_KINDS[kind] ? kind : 'other'
}

export function regionKind(kind) {
  return REGION_KINDS[kind] ? kind : 'other'
}

export function fieldKindLabel(kind) {
  return FIELD_KINDS[kind] ? FIELD_KINDS[kind][0] : 'Other'
}

export function fieldKindMeaning(kind) {
  return FIELD_KINDS[kind] ? FIELD_KINDS[kind][1] : null
}

export function regionKindLabel(kind) {
  return REGION_KINDS[kind] || 'Other'
}

/** CSS colour for a field kind, usable as a hex-view highlight colour. */
export function fieldKindColor(kind) {
  return `var(--sx-field-${fieldKind(kind)})`
}

export const FIELD_KIND_ORDER = Object.keys(FIELD_KINDS)
