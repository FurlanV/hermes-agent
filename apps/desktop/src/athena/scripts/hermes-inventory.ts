/**
 * F14: write `src/athena/hermes-inventory.md`, every "Hermes" a user can read in the desktop app, each marked
 * replace, keep or flag under the naming rules in `../hermes-names.ts`.
 *
 *   pnpm exec tsx --tsconfig tsconfig.json src/athena/scripts/hermes-inventory.ts           rewrite the inventory
 *   pnpm exec tsx --tsconfig tsconfig.json src/athena/scripts/hermes-inventory.ts --check   fail if it is stale
 *
 * Run from `apps/desktop`, and again after every upstream merge. `hermes-inventory.test.ts` runs the check.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { TRANSLATIONS } from '../../i18n/catalog'
import { classifyMentions, KEEP_KEYS, type MentionAction, sampleMessage } from '../hermes-names'

import { scanSources, type SourceRow } from './hermes-scan'

export const DESKTOP = path.resolve(import.meta.dirname, '../../..')
export const INVENTORY = path.join(DESKTOP, 'src/athena/hermes-inventory.md')

export interface TranslationRow {
  action: MentionAction
  /** A function message, listed by its output for placeholder arguments (‹1›, ‹2›, …). */
  function: boolean
  key: string
  locale: string
  text: string
  why: string
}

/**
 * Grammar the mechanical swap does not fix (F14 decision 4): an article or contraction that agrees with a
 * masculine "Hermes" stays in front of "Athena".
 */
const GAPS: Array<{ locale: string; pattern: RegExp; what: string }> = [
  { locale: 'de', pattern: /\b(der|den|dem|des) Hermes\b/i, what: 'masculine article (der, den, dem, des)' },
  { locale: 'es', pattern: /\b(el|del|al) Hermes\b/i, what: 'masculine article or contraction (el, del, al)' },
  { locale: 'fr', pattern: /\b(du|au) Hermes\b/i, what: 'masculine contraction (du, au)' }
]

/** Leaves of a message tree as [key, text], function messages by their placeholder output. */
function leavesOf(tree: unknown, key = ''): Array<[string, string]> {
  if (typeof tree === 'string') {
    return [[key, tree]]
  }

  if (typeof tree === 'function') {
    return [[key, sampleMessage(tree as (...args: unknown[]) => unknown)]]
  }

  if (tree && typeof tree === 'object') {
    return Object.entries(tree).flatMap(([child, next]) => leavesOf(next, key ? `${key}.${child}` : child))
  }

  return []
}

/** Known gaps per language: app catalog keys, and plugin bundle lines as `file:line`. */
export function grammarGaps(plugin: SourceRow[]): Array<{ keys: string[]; locale: string; what: string }> {
  return GAPS.map(({ locale, pattern, what }) => ({
    keys: [
      ...leavesOf((TRANSLATIONS as Record<string, unknown>)[locale])
        .filter(([, text]) => pattern.test(text))
        .map(([key]) => key),
      ...plugin.filter(row => pattern.test(row.text)).map(row => `${row.file}:${row.line}`)
    ],
    locale,
    what
  }))
}

/** Every leaf of every bundled catalog that mentions the bare word. */
export function translationRows(): TranslationRow[] {
  const rows: TranslationRow[] = []

  const walk = (value: unknown, key: string, locale: string): void => {
    if (typeof value === 'string' || typeof value === 'function') {
      const text = typeof value === 'string' ? value : sampleMessage(value as (...args: unknown[]) => unknown)
      const named = classifyMentions(text)

      if (named === null) {
        return
      }

      const kept = KEEP_KEYS[key]
      const action: MentionAction = kept ? 'keep' : named

      rows.push({
        action,
        function: typeof value === 'function',
        key,
        locale,
        text,
        why:
          kept ??
          (action === 'flag'
            ? 'a pending name: the owner decides (F14 slice 07)'
            : action === 'keep'
              ? 'names the engine (Hermes Agent)'
              : '')
      })

      return
    }

    if (value && typeof value === 'object') {
      for (const [child, next] of Object.entries(value)) {
        walk(next, key ? `${key}.${child}` : child, locale)
      }
    }
  }

  for (const [locale, catalog] of Object.entries(TRANSLATIONS)) {
    walk(catalog, '', locale)
  }

  return rows
}

const cell = (text: string, max = 110): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const short = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat

  return short.replace(/\|/g, '\\|')
}

const count = <T>(items: T[], pick: (item: T) => string): Map<string, number> => {
  const out = new Map<string, number>()

  for (const item of items) {
    out.set(pick(item), (out.get(pick(item)) ?? 0) + 1)
  }

  return out
}

function sourceTable(rows: SourceRow[]): string[] {
  const grouped = new Map<string, { n: number; row: SourceRow }>()

  for (const row of rows) {
    const id = `${row.file}\u0000${row.text}`
    const seen = grouped.get(id)

    if (seen) {
      seen.n += 1
    } else {
      grouped.set(id, { n: 1, row })
    }
  }

  return [
    '| File | Text | Kind | Action | Route | Status |',
    '|---|---|---|---|---|---|',
    ...[...grouped.values()].map(({ n, row }) => {
      const status =
        row.action !== 'replace'
          ? 'n/a'
          : row.route === 'direct'
            ? row.done
              ? 'done'
              : 'open'
            : row.route === 'deferred'
              ? 'deferred'
              : 'pass'

      return `| ${row.file} | ${cell(row.text)}${n > 1 ? ` (×${n})` : ''} | ${row.kind} | ${row.action} | ${row.route} | ${status} |`
    })
  ]
}

/** The inventory document. */
export function renderInventory(): string {
  const translations = translationRows()
  const english = translations.filter(row => row.locale === 'en')
  const others = translations.filter(row => row.locale !== 'en')
  const englishKeys = new Set(english.map(row => row.key))
  const otherCount = count(others, row => row.key)
  const sources = scanSources(DESKTOP)
  const plugin = sources.filter(row => row.route === 'plugin' || row.kind === 'plugin translations')
  const renderer = sources.filter(row => row.surface === 'renderer' && !plugin.includes(row))
  const main = sources.filter(row => row.surface === 'main')

  const summaryRow = (label: string, rows: Array<{ action: MentionAction }>): string => {
    const by = count(rows, row => row.action)

    return `| ${label} | ${by.get('replace') ?? 0} | ${by.get('keep') ?? 0} | ${by.get('flag') ?? 0} |`
  }

  const onlyElsewhere = [...new Set(others.filter(row => !englishKeys.has(row.key)).map(row => row.key))].sort()

  const pluginFiles = [...count(plugin, row => row.file).entries()].sort(([a], [b]) => a.localeCompare(b))

  return [
    '# Hermes inventory (generated)',
    '',
    'Every "Hermes" a user can read in the desktop app, classified under F14 decision 3',
    '(`src/athena/hermes-names.ts`): **replace** with Athena, **keep** (names the engine, a',
    'literal command, licence text, or is not text a user reads), **flag** (a pending name the',
    'owner decides in F14 slice 07). Comments, tests, fixtures, identifiers and the Athena folders',
    'are not listed.',
    '',
    'Generated by `src/athena/scripts/hermes-inventory.ts`; do not edit by hand. Regenerate after',
    'every upstream merge:',
    '',
    '```sh',
    'pnpm exec tsx --tsconfig tsconfig.json src/athena/scripts/hermes-inventory.ts          # rewrite',
    'pnpm exec tsx --tsconfig tsconfig.json src/athena/scripts/hermes-inventory.ts --check  # fail if stale',
    '```',
    '',
    'Route (source rows): **direct** is wrapped in `brandText` on its own line; **error** is branded',
    'where the app shows errors; **plugin** is branded by the plugin translation pass; **deferred** is',
    'left as written for now (Bot Mode code, see the F14 open questions). Status: **open**',
    '(still says Hermes in Athena), **done** (wrapped), **pass** (left to a pass), **n/a** (kept or flagged).',
    '',
    '## Summary',
    '',
    '| Surface | replace | keep | flag |',
    '|---|---|---|---|',
    summaryRow('Translations, English (keys)', english),
    summaryRow('Translations, other languages (keys × languages)', others),
    summaryRow('Renderer source (lines)', renderer),
    summaryRow('Main-process source (lines)', main),
    summaryRow('Plugin translations (lines)', plugin),
    '',
    '## Translations (English)',
    '',
    'One row per key. "Other languages" counts the other bundled languages whose message at that key',
    'also says Hermes; they follow the English action.',
    '',
    '| Key | English | Action | Why | Other languages |',
    '|---|---|---|---|---|',
    ...english.map(
      row =>
        `| ${row.key} | ${row.function ? '(function) ' : ''}${cell(row.text)} | ${row.action} | ${row.why} | ${otherCount.get(row.key) ?? 0} |`
    ),
    '',
    '## Translations only in other languages',
    '',
    onlyElsewhere.length
      ? onlyElsewhere.map(key => `- ${key}`).join('\n')
      : 'None: every key that says Hermes in another language says it in English too.',
    '',
    '## Known gaps (other languages)',
    '',
    'The other languages get the name swap only (F14 decision 4). Possessives (English, German) and French',
    'elisions (de, que, le, la) are fixed; these forms are not, and read with a masculine article before',
    '"Athena". They are listed, not fixed.',
    '',
    '| Language | Form | Messages | Examples |',
    '|---|---|---|---|',
    ...grammarGaps(plugin).map(
      gap => `| ${gap.locale} | ${gap.what} | ${gap.keys.length} | ${cell(gap.keys.slice(0, 4).join(', '), 200)} |`
    ),
    '',
    '## Renderer source',
    '',
    ...sourceTable(renderer),
    '',
    '## Main-process source',
    '',
    ...sourceTable(main),
    '',
    '## Plugin translations',
    '',
    'Message bundles bundled plugins register with plugin i18n; branded by the plugin pass.',
    '',
    '| File | Mentions | replace | keep | flag |',
    '|---|---|---|---|---|',
    ...pluginFiles.map(([file, n]) => {
      const by = count(
        plugin.filter(row => row.file === file),
        row => row.action
      )

      return `| ${file} | ${n} | ${by.get('replace') ?? 0} | ${by.get('keep') ?? 0} | ${by.get('flag') ?? 0} |`
    }),
    ''
  ].join('\n')
}

/** `null` when the inventory on disk is current, else what is wrong. */
export function inventoryProblem(): null | string {
  let current = ''

  try {
    current = readFileSync(INVENTORY, 'utf8')
  } catch {
    return 'src/athena/hermes-inventory.md is missing'
  }

  return current === renderInventory()
    ? null
    : 'src/athena/hermes-inventory.md is stale: run src/athena/scripts/hermes-inventory.ts'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const problem = inventoryProblem()

    if (problem) {
      console.error(problem)
      process.exit(1)
    }

    console.log('hermes-inventory.md is current')
  } else {
    writeFileSync(INVENTORY, renderInventory())
    console.log(`wrote ${path.relative(DESKTOP, INVENTORY)}`)
  }
}
