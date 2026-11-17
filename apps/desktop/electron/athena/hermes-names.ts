/**
 * F14: which "Hermes" a user may still read in the Athena build, and which one names the product.
 *
 * The rule (F14 decision 3): "Athena" for the product and the agent, "SickKids" only for the maker or publisher.
 * "Hermes Agent" stays where it truthfully names the engine. A name the rule does not settle is pending: it is
 * left as written until the owner decides (F14 slice 07), and the inventory lists it as `flag`.
 *
 * The inventory (`src/athena/scripts/hermes-inventory.ts`) classifies every mention with these lists. Pure data and pure
 * functions only: the main process, the renderer and the build scripts all read this file.
 */

/** Phrases kept as written: they name the engine, not the product. */
export const KEEP_PHRASES: readonly string[] = ['Hermes Agent']

/**
 * Names the rule does not settle; left as written until the owner decides (F14 slice 07). A phrase also matches
 * its plural or longer forms ("Hermes profiles").
 */
export const PENDING_PHRASES: readonly string[] = [
  'Hermes Cloud',
  'Hermes catalog',
  'Hermes plugin catalog',
  'Hermes profile',
  'Hermes HUD',
  'Classic Hermes',
  'Hermes skin'
]

/** Translation keys whose "Hermes" stays as written, with why. */
export const KEEP_KEYS: Readonly<Record<string, string>> = {
  'sharedMetrics.collectedMachine': '"Hermes version" is the engine version that the metrics collect'
}

/** One mention of the bare word in `text`. */
const NAME = /\bHermes\b/g

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const phrasePattern = (phrases: readonly string[]): RegExp =>
  new RegExp(
    [...phrases]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join('|'),
    'g'
  )

const KEEP_PATTERN = phrasePattern(KEEP_PHRASES)
const PENDING_PATTERN = phrasePattern(PENDING_PHRASES)

/** Character ranges of `text` that `pattern` matches. */
function spans(text: string, pattern: RegExp): Array<[number, number]> {
  return [...text.matchAll(new RegExp(pattern.source, 'g'))].map(match => [match.index, match.index + match[0].length])
}

const inside = (index: number, ranges: Array<[number, number]>): boolean =>
  ranges.some(([start, end]) => index >= start && index < end)

export type MentionAction = 'flag' | 'keep' | 'replace'

/**
 * What to do with the mentions of "Hermes" in one piece of text: `flag` when any is a pending name, `keep` when
 * every one sits inside a kept phrase, otherwise `replace`. `null` when the text does not mention the name.
 */
export function classifyMentions(text: string): MentionAction | null {
  const mentions = [...text.matchAll(NAME)].map(match => match.index)

  if (mentions.length === 0) {
    return null
  }

  const pending = spans(text, PENDING_PATTERN)

  if (mentions.some(index => inside(index, pending))) {
    return 'flag'
  }

  const kept = spans(text, KEEP_PATTERN)

  return mentions.every(index => inside(index, kept)) ? 'keep' : 'replace'
}

/** A function message's output for placeholder arguments (‹1›, ‹2›, …); `''` when it throws or is not text. */
export function sampleMessage(message: (...args: unknown[]) => unknown): string {
  const args = Array.from({ length: Math.max(message.length, 1) }, (_, index) => `‹${index + 1}›`)

  try {
    const out = message(...args)

    return typeof out === 'string' ? out : ''
  } catch {
    return ''
  }
}

/** "Hermes" with what the rename needs around it: a short preceding word, " Desktop", a possessive. */
const RENAME = /(\b\p{L}{1,3} )?\bHermes\b( Desktop\b)?(['’]s?(?=\s\p{L}))?/gu

const startsWithVowel = (word: string): boolean => /^[aeiou]/i.test(word)

/** French elisions before a vowel: "de Hermes" → "d’Athena". */
const FRENCH_ELISION: Readonly<Record<string, string>> = {
  de: 'd’',
  De: 'D’',
  la: 'l’',
  La: 'L’',
  le: 'l’',
  Le: 'L’',
  que: 'qu’',
  Que: 'Qu’'
}

/**
 * `text` with every bare "Hermes" that names the product or the agent renamed to `product` (F14 decision 3).
 *
 * Left as written: kept phrases ("Hermes Agent"), pending names, anything inside `backticks` (a command), and
 * every occurrence of a `protect` string (the arguments a message was built from, such as a user's own names).
 * "Hermes Desktop" becomes the product name alone. English fixes the article ("a Hermes" → "an Athena") and the
 * possessive ("Hermes' files" → "Athena's files"); German writes "Athenas"; French elides ("de" → "d’"). Other
 * grammar is left to the mechanical swap (F14 decision 4).
 */
export function renameHermes(text: string, product: string, locale = 'en', protect: readonly string[] = []): string {
  if (!text.includes('Hermes')) {
    return text
  }

  const kept = [
    ...spans(text, KEEP_PATTERN),
    ...spans(text, PENDING_PATTERN),
    ...spans(text, /`[^`\n]*`/g),
    ...protect.filter(value => value.includes('Hermes')).flatMap(value => spans(text, new RegExp(escape(value), 'g')))
  ]

  const language = locale.split('-')[0]

  return text.replace(
    RENAME,
    (match: string, before: string | undefined, _desktop, possessive: string | undefined, offset: number) => {
      const at = offset + (before?.length ?? 0)

      if (inside(at, kept)) {
        return match
      }

      let lead = before ?? ''
      let name = product

      if (language === 'en' && /^(a|A) $/.test(lead) && startsWithVowel(product)) {
        lead = `${lead[0]}n `
      } else if (language === 'fr' && before && FRENCH_ELISION[before.trim()] && startsWithVowel(product)) {
        lead = FRENCH_ELISION[before.trim()]!
      }

      if (possessive) {
        name =
          language === 'en'
            ? `${product}${possessive[0]}s`
            : language === 'de'
              ? `${product}s`
              : `${product}${possessive}`
      }

      return `${lead}${name}`
    }
  )
}
