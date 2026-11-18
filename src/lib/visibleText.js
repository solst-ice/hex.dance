// Makes characters a reader cannot see, or that change how the text around
// them is displayed, visible as markers such as ⟨U+202E⟩. Names and text
// taken from a file are shown through this, so 'invoice<U+202E>fdp.exe' does
// not read as ending in 'exe.pdf', and zero-width characters do not hide.
//
// What is marked:
// - C0 controls except tab, line feed and carriage return; DEL and C1 controls
// - bidirectional controls: the embeddings, overrides and isolates, and the
//   left-to-right, right-to-left and Arabic letter marks
// - zero-width and other invisible format characters: zero-width space, word
//   joiner, invisible operators, byte order mark, soft hyphen, combining
//   grapheme joiner, Hangul fillers, Mongolian vowel separator, interlinear
//   annotation marks, tag characters, line and paragraph separators
// - lone surrogates and the noncharacters U+FFFE and U+FFFF
// - '⟨' itself, so that every '⟨' on the screen starts a marker
//
// Some invisible characters are part of ordinary writing, and are left alone
// where they do that job: the zero-width joiner and non-joiner between two
// letters or marks (Persian, Arabic and Indic words need them) and the joiner
// inside an emoji sequence; variation selectors right after a visible
// character (emoji, CJK and Mongolian use them). Anywhere else they are marked.
// Ordinary text in any script, right-to-left scripts included, needs no
// control characters: the browser orders it correctly by itself.

const OPEN = '\u27E8'
const CLOSE = '\u27E9'

// Each character is tested on its own, so combining characters in the class are meant
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const ALWAYS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B\u200E\u200F\u2028-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\uFFFE\uFFFF\u{E0000}-\u{E007F}]|\p{Cs}/u
// Control bytes, lone surrogates and noncharacters: binary data rather than
// an attempt to disguise text, so they are marked without being called deceptive
// eslint-disable-next-line no-control-regex
const BINARY = /^(?:[\u0000-\u001F\u007F-\u009F\uFFFE\uFFFF]|\p{Cs})$/u
const JOINER = /^[\u200C\u200D]$/
const SELECTOR = /^[\u180B-\u180D\u180F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u
// A quick test for whether a string needs the slower walk at all
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const ANY = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u27E8\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\uFFFE\uFFFF\u{E0000}-\u{E01EF}]|\p{Cs}/u

const LETTER = /^[\p{L}\p{M}]$/u
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u
const MODIFIER = /^\p{Emoji_Modifier}$/u

const marker = ch => `${OPEN}U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}${CLOSE}`

function joinerIsWanted(ch, before, after) {
  if (LETTER.test(before) && LETTER.test(after)) return true
  // Emoji sequences such as woman + joiner + laptop, where a variation selector or skin tone may come before the joiner
  return ch === '\u200D' && (PICTOGRAPH.test(before) || before === '\uFE0F' || MODIFIER.test(before)) && PICTOGRAPH.test(after)
}

/**
 * Text with hidden and direction-changing characters replaced by markers.
 * @param {string} text
 * @param {{ keepMarkers?: boolean }} [options]  keepMarkers leaves text that
 *   already reads as a marker alone, for code that cleans the same text more
 *   than once; text straight from a file must not use it
 * @returns {{ text: string, hidden: number, deceptive: number }} `hidden`
 *   counts the characters marked because a reader could not see them (a
 *   literal '⟨' is not counted); `deceptive` those of them that are invisible
 *   formatting or direction controls rather than control bytes
 */
export function revealText(text, { keepMarkers = false } = {}) {
  if (typeof text !== 'string' || !ANY.test(text)) return { text, hidden: 0, deceptive: 0 }
  // Code points, so emoji stay whole; a lone surrogate comes out on its own
  const chars = Array.from(text)
  let out = ''
  let hidden = 0
  let deceptive = 0
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    const before = i > 0 ? chars[i - 1] : ''
    const after = i + 1 < chars.length ? chars[i + 1] : ''
    if (ch === OPEN) {
      if (keepMarkers && /^U\+[0-9A-F]{4,6}\u27E9/.test(chars.slice(i + 1, i + 10).join(''))) out += ch
      else out += marker(ch)
    } else if (ALWAYS.test(ch)) {
      hidden++
      if (!BINARY.test(ch)) deceptive++
      out += marker(ch)
    } else if (JOINER.test(ch) && !joinerIsWanted(ch, before, after)) {
      hidden++
      deceptive++
      out += marker(ch)
    } else if (SELECTOR.test(ch) && (!before || /^\s$/u.test(before) || ALWAYS.test(before) || JOINER.test(before) || SELECTOR.test(before))) {
      hidden++
      deceptive++
      out += marker(ch)
    } else {
      out += ch
    }
  }
  return { text: out, hidden, deceptive }
}

/**
 * Text with hidden and direction-changing characters made visible as markers
 * such as ⟨U+202E⟩. Anything that is not a string is returned as it is.
 * @param {string} text
 * @param {{ keepMarkers?: boolean }} [options]  see revealText
 */
export function visibleText(text, options) {
  return revealText(text, options).text
}

/** True when `text` holds invisible formatting or direction controls. */
export function hasDeceptiveCharacters(text) {
  return revealText(text).deceptive > 0
}
