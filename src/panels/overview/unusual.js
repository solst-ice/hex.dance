// The analysis's "unusual" notes as the Overview lists them: text only, at
// most UNUSUAL_SHOWN, with a usable offset or none.

export const UNUSUAL_SHOWN = 50

/** @param {import('../../analysis/types.js').Analysis|null} analysis */
export function unusualNotes(analysis) {
  const list = Array.isArray(analysis?.unusual) ? analysis.unusual : []
  return list
    .slice(0, UNUSUAL_SHOWN * 4)
    .filter(note => note && typeof note.text === 'string' && note.text.trim() !== '')
    .slice(0, UNUSUAL_SHOWN)
    .map(note => ({
      text: note.text,
      offset: Number.isSafeInteger(note.offset) && note.offset >= 0 ? note.offset : null,
      length: Number.isSafeInteger(note.length) && note.length > 0 ? note.length : 1
    }))
}
