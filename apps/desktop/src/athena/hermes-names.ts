/**
 * F14: which "Hermes" a user may still read in the Athena build, and which one names the product.
 *
 * The rule (F14 decision 3): "Athena" for the product and the agent, "SickKids" only for the maker or publisher.
 * "Hermes Agent" stays where it truthfully names the engine. A name the rule does not settle is pending: it is
 * left as written until the owner decides (F14 slice 07), and the inventory lists it as `flag`.
 *
 * The inventory (`scripts/hermes-inventory.ts`) classifies every mention with these lists. Pure data and pure
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
