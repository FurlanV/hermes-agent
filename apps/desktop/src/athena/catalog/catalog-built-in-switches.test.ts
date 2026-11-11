// @vitest-environment node
// F03 slice 05 (decision 1, a testing default): every built-in is on by default for every role, with its own switch.
// An admin lock still wins and shows Managed; an entry taken away from a role is not listed; with Files off, the
// cards that need it say so without turning it on.
import { describe, expect, test } from 'vitest'

import { BUNDLED_CATALOG, catalogCards, worksBestWithLine } from './catalog'

const ALL = Object.keys(BUNDLED_CATALOG.entries)
// Gateway packages (stub-echo, EAGLE) are off by default and live in the catalog beside the built-ins.
const BUILT_INS = Object.values(BUNDLED_CATALOG.entries).filter(entry => entry.category === 'built-in')
const ROLES = ['researcher', 'clinician', 'trainee', 'admin']

// The compose seed's tools section for every role (athena deploy/compose/dev/client-config.roles.yaml).
const SEED = {
  available: ALL,
  default_on: ALL,
  experimental: ['browser', 'summarise-paper', 'data-cleaning-pandas'],
  locked_on: [] as string[]
}

const config = (tools: object) => ({ managed: { tools: 'enforce' }, tools })

describe('built-in switches', () => {
  test('every built-in is on by default, switchable and for every role', () => {
    for (const entry of BUILT_INS) {
      expect([entry.id, entry.default_on, entry.user_toggle, entry.roles]).toEqual([entry.id, true, true, ROLES])
    }

    const cards = catalogCards(config(SEED)).filter(card => card.entry.category === 'built-in')
    expect(cards).toHaveLength(13)
    expect(cards.filter(card => !card.on || card.managed)).toEqual([])
  })

  test.each(ALL)('switching %s off turns off only its card', id => {
    const off = catalogCards(config(SEED), { [id]: false }).filter(card => !card.on)
    expect(off.map(card => card.entry.id)).toEqual([id])
  })

  test('an admin lock ignores the switch and shows Managed; an entry taken away is not listed', () => {
    const locked = catalogCards(config({ ...SEED, locked_on: ['files'] }), { files: false })
    expect(locked.find(card => card.entry.id === 'files')).toMatchObject({ managed: true, on: true })

    const removed = catalogCards(config({ ...SEED, available: ALL.filter(id => id !== 'terminal') }), { terminal: true })
    expect(removed.map(card => card.entry.id)).not.toContain('terminal')
  })

  test('with Files off, python and the curated skills say "Works best with Files" without forcing it on', () => {
    const cards = catalogCards(config(SEED), { files: false })
    const notes = Object.fromEntries(cards.map(card => [card.entry.id, worksBestWithLine(card)]))

    expect(Object.entries(notes).filter(([, note]) => note)).toEqual([
      ['data-cleaning-pandas', 'Works best with Files'],
      ['python', 'Works best with Files'],
      ['summarise-paper', 'Works best with Files']
    ].sort())
    expect(cards.find(card => card.entry.id === 'files')?.on).toBe(false)
    expect(catalogCards(config(SEED)).every(card => worksBestWithLine(card) === null)).toBe(true)

    const noFiles = catalogCards(config({ ...SEED, available: ALL.filter(id => id !== 'files') }))
    expect(worksBestWithLine(noFiles.find(card => card.entry.id === 'python')!)).toBe('Works best with Files')
  })
})
