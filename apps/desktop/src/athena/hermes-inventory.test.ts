// @vitest-environment node
// F14 slice 01: the Hermes inventory is current, and its rules sort mentions the way decision 3 says.
import { describe, expect, test } from 'vitest'

import { classifyMentions } from './hermes-names'
import { inventoryProblem, translationRows } from './scripts/hermes-inventory'
import { codeOf, scanText } from './scripts/hermes-scan'

describe('naming rules', () => {
  test('the product and the agent are replaced', () => {
    expect(classifyMentions('Hermes is working')).toBe('replace')
    expect(classifyMentions('Restart Hermes Desktop')).toBe('replace')
  })

  test('the engine is kept', () => {
    expect(classifyMentions('Show Hermes Agent version')).toBe('keep')
    expect(classifyMentions('Hermes Agent runs, and Hermes answers')).toBe('replace')
  })

  test('a pending name is flagged, in longer forms too', () => {
    expect(classifyMentions('Sign in to Hermes Cloud')).toBe('flag')
    expect(classifyMentions('List Hermes profiles')).toBe('flag')
  })

  test('identifiers and other words are not mentions', () => {
    expect(classifyMentions('HermesGateway, HERMES_HOME, hermes gateway setup')).toBeNull()
  })
})

describe('source scan', () => {
  test('comments are skipped, text a user reads is listed', () => {
    expect(codeOf('  // Hermes owns this')).toBeNull()
    expect(codeOf('      {/* Hermes Cloud panel')).toBeNull()

    const rows = scanText('src/app/example.tsx', "// Hermes\nconst label = 'Ask Hermes…'\n")

    expect(rows).toEqual([
      expect.objectContaining({ action: 'replace', line: 2, route: 'direct', surface: 'renderer' })
    ])
  })

  test('errors, logs, identifiers and plugin bundles are told apart', () => {
    const at = (file: string, line: string) => scanText(file, line)[0]

    expect(at('electron/x.ts', "throw new Error('Hermes backend is gone')")).toMatchObject({ route: 'error' })
    expect(at('electron/x.ts', "rememberLog('Hermes started')")).toMatchObject({
      action: 'keep',
      kind: 'developer log'
    })
    expect(at('electron/x.ts', "headers: { 'X-Hermes-Session-Token': t }")).toMatchObject({ action: 'keep' })
    expect(at('src/plugins/kanban/i18n.ts', "title: 'Hermes will retry'")).toMatchObject({ route: 'plugin' })
  })

  test('a line wrapped in brandText is done', () => {
    expect(scanText('src/app/x.tsx', "label={brandText('Hermes is working')}")[0]).toMatchObject({ done: true })
  })
})

describe('inventory', () => {
  test('every English key that says Hermes is classified', () => {
    const english = translationRows().filter(row => row.locale === 'en')

    expect(english.length).toBeGreaterThan(0)
    expect(english.every(row => ['flag', 'keep', 'replace'].includes(row.action))).toBe(true)
    expect(english.filter(row => row.action === 'keep').every(row => row.why.length > 0)).toBe(true)
  })

  test('hermes-inventory.md is current (regenerate with scripts/hermes-inventory.ts)', () => {
    expect(inventoryProblem()).toBeNull()
  }, 60_000)
})
