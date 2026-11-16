import { hex, sizeText } from './validate/common.js'

export const CONFIDENCE = {
  high: { label: 'Verified', explain: 'The structure was walked to its end or a checksum matched.' },
  medium: { label: 'Header valid', explain: 'Header fields are consistent, but the whole structure was not confirmed.' },
  low: { label: 'Signature only', explain: 'Only the signature (or a few plausible values) matched; this may be chance.' }
}

export function hitSize(hit) {
  if (hit.end === null) return 'size unknown'
  const text = sizeText(hit.end - hit.start)
  if (hit.claimedEnd !== undefined) return `${text}, truncated`
  return hit.endKind === 'estimated' ? `≈ ${text}` : text
}

export function rangeText(start, end) {
  return `${hex(start)}–${hex(Math.max(start, end - 1))}`
}

export { hex, sizeText }
