import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FORMAT_CARDS, GENERIC_CARD, formatCardFor } from './index.js'
import { FORMATS } from '../formats/index.js'

const CARDS = [...Object.entries(FORMAT_CARDS), ['generic', GENERIC_CARD]]

const CORE_FORMATS = ['png', 'jpeg', 'gif', 'zip', 'pdf', 'java-class', 'elf', 'pe', 'macho']

test('core formats have their own card and any other format gets a usable one', () => {
  for (const id of CORE_FORMATS) assert.ok(FORMAT_CARDS[id], id)
  // Formats registered later have no dedicated card yet and fall back to the generic one
  for (const format of FORMATS) {
    const card = formatCardFor({ formatId: format.id, formatName: format.name })
    assert.ok(card && card.title && card.walk.length > 0, format.id)
  }
})

test('cards are complete, plain text and link only to https specifications', () => {
  for (const [id, card] of CARDS) {
    for (const key of ['title', 'tagline', 'walkTitle', 'gotchasTitle']) assert.ok(card[key] && typeof card[key] === 'string', `${id}.${key}`)
    assert.ok(card.walk.length >= 3 && card.gotchas.length >= 2, id)
    const texts = [card.tagline, card.origin, ...card.walk, ...card.gotchas, card.story?.text].filter(Boolean)
    for (const text of texts) {
      assert.doesNotMatch(text, /<[a-z]/i, `${id}: no markup`)
      assert.match(text, /[.!?)"]$/, `${id}: sentences end with punctuation: ${text.slice(-30)}`)
    }
    assert.match(card.spec.url, /^https:\/\/[^\s]+$/, id)
  }
})

test('the CAFEBABE story appears for Java class files and Mach-O', () => {
  assert.match(FORMAT_CARDS['java-class'].story.text, /CAFEBABE/)
  assert.equal(FORMAT_CARDS.macho.story, FORMAT_CARDS['java-class'].story)
})

test('picks a card for an analysis', () => {
  assert.equal(formatCardFor(null), GENERIC_CARD)
  assert.equal(formatCardFor({ formatId: 'unknown', formatName: 'Unknown format', summary: [] }), GENERIC_CARD)
  assert.equal(formatCardFor({ formatId: 'png', formatName: 'PNG Image', summary: [] }), FORMAT_CARDS.png)
  const later = formatCardFor({ formatId: 'webp', formatName: 'WebP Image', summary: [] })
  assert.equal(later.title, 'WebP Image')
  assert.match(later.tagline, /no guide/)
  const docx = formatCardFor({ formatId: 'zip', formatName: 'Word document (DOCX)', summary: [{ label: 'Container', value: 'An Office Open XML document' }] })
  assert.equal(docx.note, 'Word document (DOCX): An Office Open XML document.')
})
