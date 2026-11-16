import { FORMAT_CARDS, GENERIC_CARD } from './formats.js'

export { FORMAT_CARDS, GENERIC_CARD }

/**
 * The explainer for an analysed file. Formats without a card of their own get
 * the generic guide to reading bytes, titled with the format's name.
 * @param {import('../analysis/types.js').Analysis|null} analysis
 * @returns {import('./formats.js').FormatCard & { note?: string }}
 */
export function formatCardFor(analysis) {
  if (!analysis || analysis.formatId === 'unknown') return GENERIC_CARD
  const card = FORMAT_CARDS[analysis.formatId]
  if (!card) {
    return {
      ...GENERIC_CARD,
      title: analysis.formatName,
      tagline: `hex.dance recognises this file as ${analysis.formatName}, but there is no guide for the format yet. Here is how to read the bytes yourself.`,
      origin: undefined
    }
  }
  // ZIP-based formats say what they are in the summary
  const container = analysis.summary.find(entry => entry.label === 'Container')
  if (container && analysis.formatName !== card.title) {
    return { ...card, note: `${analysis.formatName}: ${container.value}.` }
  }
  return card
}
