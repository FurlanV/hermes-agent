// @vitest-environment node
// F03 slice 01: the catalog's package fields. Every bundled entry is a built-in, the page ignores fields it does not
// use (so a newer catalog with more fields shows the same cards), and a withdrawn entry is listed but never on.
import { describe, expect, test } from 'vitest'

import { BUNDLED_CATALOG, type Catalog, catalogCards, type CatalogEntry } from './catalog'

const ALL = Object.keys(BUNDLED_CATALOG.entries)

const config = (tools: Record<string, string[]>) => ({ managed: { tools: 'enforce' }, tools })

const withEntries = (change: (entries: Record<string, CatalogEntry>) => void): Catalog => {
  const entries = structuredClone(BUNDLED_CATALOG.entries)
  change(entries)

  return { ...BUNDLED_CATALOG, entries }
}

describe('package fields', () => {
  test('the 13 bundled built-ins keep their category; every other entry is a gateway package', () => {
    const entries = Object.values(BUNDLED_CATALOG.entries)

    expect(entries.filter(entry => entry.category === 'built-in')).toHaveLength(13)
    expect(entries.filter(entry => entry.category !== 'built-in').map(entry => entry.kind)).toEqual(
      entries.filter(entry => entry.category !== 'built-in').map(() => 'gateway')
    )
  })

  test('fields the page does not use change no card', () => {
    const tools = { available: ALL, default_on: ['files', 'python'], locked_on: ['files'] }

    const richer = withEntries(entries => {
      for (const entry of Object.values(entries)) {
        Object.assign(entry, {
          publisher: { contact: 'it@example.org', name: 'Research IT', team: 'Athena' },
          requires_athena: '>=0.1.0',
          surprise: { from: 'a newer catalog' }
        })
      }
    })

    const strip = (cards: ReturnType<typeof catalogCards>) =>
      cards.map(card => ({ experimental: card.experimental, id: card.entry.id, managed: card.managed, on: card.on }))

    expect(strip(catalogCards(config(tools), {}, richer))).toEqual(strip(catalogCards(config(tools), {})))
  })

  test('a withdrawn entry is listed, off and has no switch, even when locked on', () => {
    const catalog = withEntries(entries => {
      entries.python = {
        ...entries.python!,
        status: 'withdrawn',
        status_note: { by: 'athena-admins', reason: 'Replaced.' }
      }
    })

    const cards = catalogCards(config({ available: ['python'], default_on: ['python'], locked_on: ['python'] }), { python: true }, catalog)

    expect(cards.map(card => [card.entry.id, card.on, card.managed])).toEqual([['python', false, true]])
  })
})
