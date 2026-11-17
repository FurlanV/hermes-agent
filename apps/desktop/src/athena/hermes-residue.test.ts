// F14 residue test: in the Athena build no text a user reads says "Hermes", except kept phrases ("Hermes Agent"),
// pending names (hermes-names.ts PENDING_PHRASES, emptied by F14 slice 08) and kept keys (KEEP_KEYS).
import { afterEach, describe, expect, test } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'
import { registerPluginLocales, translatePlugin } from '@/i18n/plugin-i18n'
import { registerAppLocale, resetAppLocaleRegistry, resolveTranslations } from '@/i18n/registry'
import { BOTS_LOCALES } from '@/plugins/hermes-bots/i18n'
import { KANBAN_LOCALES } from '@/plugins/kanban/i18n'
import { $notifications, clearNotifications, notify } from '@/store/notifications'

import { classifyMentions, KEEP_KEYS, renameHermes, sampleMessage } from '../../electron/athena/hermes-names'

import { brandCatalog, brandText, setAthenaBrandForTests } from './brand-text'
import { DESKTOP } from './scripts/hermes-inventory'
import { scanSources } from './scripts/hermes-scan'

type Tree = Record<string, unknown>

/** Every leaf of `tree` with its key: strings as they are, function messages by their placeholder output. */
function leaves(tree: unknown, key = ''): Array<[string, string]> {
  if (typeof tree === 'string') {
    return [[key, tree]]
  }

  if (typeof tree === 'function') {
    return [[key, sampleMessage(tree as (...args: unknown[]) => unknown)]]
  }

  if (tree && typeof tree === 'object') {
    return Object.entries(tree).flatMap(([child, next]) => leaves(next, key ? `${key}.${child}` : child))
  }

  return []
}

/** Keys whose message still says Hermes outside kept and pending phrases. */
function residue(tree: unknown): string[] {
  return leaves(tree)
    .filter(([key, text]) => !KEEP_KEYS[key] && classifyMentions(text) === 'replace')
    .map(([key]) => key)
}

const at = (tree: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Tree | undefined)?.[part], tree)

afterEach(() => {
  setAthenaBrandForTests(null)
  resetAppLocaleRegistry()
})

describe('renameHermes', () => {
  const rename = (text: string, locale = 'en') => renameHermes(text, 'Athena', locale)

  test('the product and the agent become Athena', () => {
    expect(rename('Hermes is working')).toBe('Athena is working')
    expect(rename('Restart Hermes Desktop to save images')).toBe('Restart Athena to save images')
  })

  test('English grammar: article and possessive', () => {
    expect(rename('Connect to a Hermes gateway. A Hermes install')).toBe(
      'Connect to an Athena gateway. An Athena install'
    )
    expect(rename("Part of Hermes' installation; Hermes’s own memory")).toBe(
      "Part of Athena's installation; Athena’s own memory"
    )
    expect(rename("The app called 'Hermes', and more")).toBe("The app called 'Athena', and more")
  })

  test('kept phrases, pending names, commands and protected text stay', () => {
    expect(rename('Show Hermes Agent version')).toBe('Show Hermes Agent version')
    expect(rename('Sign in to Hermes Cloud, then Hermes connects')).toBe(
      'Sign in to Hermes Cloud, then Athena connects'
    )
    expect(rename('Run `Hermes setup` so Hermes can start')).toBe('Run `Hermes setup` so Athena can start')
    expect(renameHermes('Hermes can use Hermes Mail', 'Athena', 'en', ['Hermes Mail'])).toBe(
      'Athena can use Hermes Mail'
    )
  })

  test('other languages: mechanical swap, with German and French grammar', () => {
    expect(rename('Hermes が自動で再試行します', 'ja')).toBe('Athena が自動で再試行します')
    expect(rename('a Hermes', 'es')).toBe('a Athena')
    expect(rename('Hermes’ eigener Speicher', 'de')).toBe('Athenas eigener Speicher')
    expect(rename('la version de Hermes', 'fr')).toBe('la version d’Athena')
  })
})

describe('English interface text in the Athena build', () => {
  test('the About heading says Athena', () => {
    setAthenaBrandForTests(true)

    expect(resolveTranslations('en').updates.appName).toBe('Athena')
  })

  test('messages name Athena, and nothing says Hermes outside kept and pending names', () => {
    setAthenaBrandForTests(true)
    const t = resolveTranslations('en')
    const bring = leaves(TRANSLATIONS.en).find(([, text]) => text.startsWith('Bring a conversation into Hermes'))

    expect(bring).toBeDefined()
    expect(at(t, bring![0])).toBe('Bring a conversation into Athena and pick up where you left off.')
    expect(residue(t)).toEqual([])
  })

  test('a function message is renamed but its arguments are not', () => {
    setAthenaBrandForTests(true)
    const appSwitch = resolveTranslations('en').connectorsPage.dialog.appSwitch as (name: string) => string

    expect(appSwitch('Hermes Mail')).toBe('Athena can use Hermes Mail')
  })

  test('kept keys and kept phrases are unchanged', () => {
    setAthenaBrandForTests(true)
    const t = resolveTranslations('en')

    for (const key of Object.keys(KEEP_KEYS)) {
      expect(at(t, key)).toBe(at(TRANSLATIONS.en, key))
    }

    expect(at(t, 'composer.commandDescs./version')).toBe('Show Hermes Agent version')
  })

  test('the residue check fails on a new message that says Hermes', () => {
    expect(residue({ fresh: { title: 'Hermes has something new' } })).toEqual(['fresh.title'])
  })
})

describe('other languages, language packs and plugins in the Athena build (F14 slice 04)', () => {
  const locales = Object.keys(TRANSLATIONS) as Array<keyof typeof TRANSLATIONS>

  test.each(locales)('bundled language %s says Hermes only in kept and pending names', locale => {
    setAthenaBrandForTests(true)

    expect(residue(resolveTranslations(locale))).toEqual([])
  })

  test('a backend language pack is renamed too', () => {
    setAthenaBrandForTests(true)
    registerAppLocale('pl', { translations: { 'updates.appName': 'Hermes po polsku' } }, 'backend')

    expect(resolveTranslations('pl').updates.appName).toBe('Athena po polsku')
  })

  test("a plugin's bundle is renamed, its message arguments are not", () => {
    setAthenaBrandForTests(true)

    const dispose = registerPluginLocales('f14-test', {
      en: { greet: (name: string) => `Hermes greets ${name}`, hello: 'Hermes says hello' },
      ja: { hello: 'Hermes がこんにちはと言います' }
    })

    try {
      expect(translatePlugin('f14-test', 'en', 'hello', [])).toBe('Athena says hello')
      expect(translatePlugin('f14-test', 'en', 'greet', ['Hermes Fan'])).toBe('Athena greets Hermes Fan')
      expect(translatePlugin('f14-test', 'ja', 'hello', [])).toBe('Athena がこんにちはと言います')
    } finally {
      dispose()
    }
  })

  test.each([
    ['hermes-bots', BOTS_LOCALES],
    ['kanban', KANBAN_LOCALES]
  ] as const)('the bundled %s plugin says Hermes only in kept and pending names', (_id, bundles) => {
    setAthenaBrandForTests(true)

    for (const [locale, messages] of Object.entries(bundles)) {
      expect({ locale, residue: residue(brandCatalog(messages, locale)) }).toEqual({ locale, residue: [] })
    }
  })

  test('a stock build registers plugin bundles unchanged', () => {
    setAthenaBrandForTests(false)
    const dispose = registerPluginLocales('f14-stock', { en: { hello: 'Hermes says hello' } })

    try {
      expect(translatePlugin('f14-stock', 'en', 'hello', [])).toBe('Hermes says hello')
    } finally {
      dispose()
    }
  })
})

describe('hard-coded renderer text (F14 slice 05)', () => {
  test('every renderer and main-process line marked replace is wrapped in brandText or left to a pass', () => {
    const open = scanSources(DESKTOP).filter(row => row.action === 'replace' && row.route === 'direct' && !row.done)

    expect(open.map(row => `${row.file}:${row.line} ${row.text}`)).toEqual([])
  }, 60_000)

  test('the chat status and the quick-entry placeholder name Athena', () => {
    setAthenaBrandForTests(true)

    expect(brandText('Hermes is working')).toBe('Athena is working')
    expect(brandText('Ask Hermes…')).toBe('Ask Athena…')
    expect(brandText('Run `hermes gateway setup`, then Hermes connects')).toBe(
      'Run `hermes gateway setup`, then Athena connects'
    )
  })

  test('toasts, error toasts included, name Athena', () => {
    setAthenaBrandForTests(true)
    notify({ detail: 'Hermes gateway unavailable', kind: 'error', message: 'Hermes could not save', title: 'Hermes' })

    expect($notifications.get()[0]).toMatchObject({
      detail: 'Athena gateway unavailable',
      message: 'Athena could not save',
      title: 'Athena'
    })
    clearNotifications()
  })

  test('a stock build shows toasts as written', () => {
    setAthenaBrandForTests(false)
    notify({ kind: 'info', message: 'Hermes could not save' })

    expect($notifications.get()[0]).toMatchObject({ message: 'Hermes could not save' })
    clearNotifications()
  })
})

describe('stock build', () => {
  test('every catalog resolves exactly as before', () => {
    setAthenaBrandForTests(false)

    for (const locale of Object.keys(TRANSLATIONS) as Array<keyof typeof TRANSLATIONS>) {
      expect(resolveTranslations(locale)).toBe(TRANSLATIONS[locale])
    }

    expect(brandText('Hermes is working')).toBe('Hermes is working')
  })

  test('with no Athena snapshot on the bridge the pass is off', () => {
    expect(resolveTranslations('en')).toBe(TRANSLATIONS.en)
  })
})

describe('reading the variant from the bridge', () => {
  const withSnapshot = (snapshot: unknown, run: () => void) => {
    const bridge = window as { athenaDesktop?: unknown }
    const before = bridge.athenaDesktop
    bridge.athenaDesktop = { clientConfig: { snapshot } }

    try {
      run()
    } finally {
      bridge.athenaDesktop = before
    }
  }

  test.each([
    ['an Athena snapshot', { variant: 'athena' }, 'Athena is working'],
    ['a snapshot with no variant (older builds)', {}, 'Athena is working'],
    ['a stock snapshot', { variant: 'stock' }, 'Hermes is working']
  ])('%s', (_label, snapshot, expected) => {
    withSnapshot(snapshot, () => expect(brandText('Hermes is working')).toBe(expected))
  })
})
