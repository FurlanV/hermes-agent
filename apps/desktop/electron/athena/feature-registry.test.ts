import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  buildDefault,
  exportedFeatureRegistry,
  FEATURE_ROWS,
  featureEntryFilter,
  featureMode,
  featureStates,
  rowsForEntry
} from './feature-registry'

const EXPORT_FILE = path.join(import.meta.dirname, 'features.json')
const sickkids = path.join(homedir(), 'Documents/Projects/sickkids')

const ATHENA_COPY = path.join(
  process.env.ATHENA_REPO ?? path.join(sickkids, 'athena'),
  'shared/athena_schemas/src/athena_schemas/data/features.json'
)

const PLAN = path.join(
  process.env.ATHENA_OKF ?? path.join(sickkids, 'okf'),
  'backlog/2026-11-09-managed-client/overview.md'
)

const exported = () => `${JSON.stringify(exportedFeatureRegistry(), null, 2)}\n`

describe('the feature registry', () => {
  test('holds every audit row once: S01–S124 with the a/b splits', () => {
    const ids = FEATURE_ROWS.map(row => row.id)

    const expected = Array.from({ length: 124 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`).flatMap(id =>
      ['S08', 'S70', 'S118'].includes(id) ? [`${id}a`, `${id}b`] : [id]
    )

    expect(ids).toEqual(expected)
  })

  test('has the audit totals: 40 keep, 65 disable, 22 remove', () => {
    const count = (mark: string) => FEATURE_ROWS.filter(row => row.mark === mark).length

    expect([count('keep'), count('disable'), count('remove')]).toEqual([40, 65, 22])
  })

  // The plan's table is the source; this keeps the registry from drifting from it.
  test.skipIf(!existsSync(PLAN))('matches the marks in the plan audit (section A)', () => {
    const audit = new Map<string, string>()
    const MARKS: Record<string, string> = { disable: 'disable', keep: 'keep', remove: 'remove' }

    for (const line of readFileSync(PLAN, 'utf8').split('\n')) {
      const cells = line.split('|').map(cell => cell.trim())
      const id = cells[1]

      if (/^S\d+[ab]?$/.test(id ?? '')) {
        const rec = cells[4].replace(/\*/g, '').toLowerCase().split(/[ (]/)[0]
        audit.set(id, MARKS[rec] ?? rec)
      }
    }

    expect(Object.fromEntries(FEATURE_ROWS.map(row => [row.id, row.mark]))).toEqual(Object.fromEntries(audit))
  })

  test('build defaults: keep on, disable off, remove has no flag', () => {
    expect([buildDefault('keep'), buildDefault('disable'), buildDefault('remove')]).toEqual(['on', 'off', null])
  })

  test('entry ids are unique within a row and well-formed', () => {
    for (const row of FEATURE_ROWS) {
      expect(new Set(row.entries).size, row.id).toBe(row.entries.length)

      for (const entry of row.entries) {
        expect(entry, row.id).toMatch(/^(settings|settings-control|config-field|setting|credential):[^*]*\*?$/)
      }
    }
  })
})

describe('the exported registry (features.json)', () => {
  test('matches the registry (ATHENA_WRITE_FEATURES=1 rewrites it)', () => {
    if (process.env.ATHENA_WRITE_FEATURES === '1') {
      writeFileSync(EXPORT_FILE, exported())
    }

    expect(readFileSync(EXPORT_FILE, 'utf8'), 'features.json is stale: run with ATHENA_WRITE_FEATURES=1').toBe(
      exported()
    )
  })

  test('has ids, marks and build defaults only for the admin API', () => {
    const doc = exportedFeatureRegistry()

    expect(doc.features.find(row => row.id === 'S82')).toEqual({
      id: 'S82',
      mark: 'disable',
      default: 'off',
      area: 'Providers',
      title: 'Local models (Hugging Face downloads, local server)'
    })
    expect(doc.features.find(row => row.id === 'S77')?.default).toBeNull()
  })

  test.skipIf(!existsSync(ATHENA_COPY))('the athena copy is current', () => {
    expect(readFileSync(ATHENA_COPY, 'utf8'), `copy ${EXPORT_FILE} to ${ATHENA_COPY}`).toBe(exported())
  })
})

describe('evaluating flags', () => {
  test('build defaults with no exceptions', () => {
    const states = featureStates({})

    expect(['S06', 'S17', 'S82', 'S77'].map(states.on)).toEqual([true, true, false, false])
  })

  test('config exceptions: "on" opens a disable row, "off" closes a keep row; remove rows stay off', () => {
    const states = featureStates({ features: { S82: 'on', S17: 'off', S77: 'on', S999: 'on', S06: 'maybe' } })

    expect(['S82', 'S17', 'S77', 'S06'].map(states.on)).toEqual([true, false, false, true])
    expect(states.on('S999')).toBe(false)
  })

  test('master switch: off means no filtering (remove rows still off); report reads as enforce for now', () => {
    expect(featureMode({})).toBe('enforce')
    expect(featureMode({ managed: { features: 'nonsense' } })).toBe('enforce')

    const off = featureStates({ managed: { features: 'off' }, features: { S17: 'off' } })
    expect(off.filtering).toBe(false)
    expect(['S82', 'S17', 'S77'].map(off.on)).toEqual([true, true, false])

    const report = featureStates({ managed: { features: 'report' } })
    expect(report.mode).toBe('report')
    expect(report.on('S82')).toBe(false)
  })

  test('entries: exact beats a prefix, the longest prefix wins, unlisted entries are left alone', () => {
    expect(rowsForEntry('config-field:stt.provider')).toEqual(['S61'])
    expect(rowsForEntry('config-field:auxiliary.compression.timeout')).toEqual(['S59'])
    expect(rowsForEntry('credential:API_SERVER_KEY')).toEqual(['S99'])
    expect(rowsForEntry('config-field:terminal.docker_image')).toEqual(['S73'])
    expect(rowsForEntry('settings:config:model')).toBeNull()

    const filter = featureEntryFilter({})
    expect(filter('settings:config:model')).toBe(true)
    expect(filter('settings:billing')).toBe(false)
  })

  test('a shared page stays while any row on it is on', () => {
    // Providers holds S79–S82: hidden by default, back with S82 on, Local models only.
    expect(featureEntryFilter({})('settings:providers')).toBe(false)

    const s82 = featureEntryFilter({ features: { S82: 'on' } })
    expect(s82('settings:providers')).toBe(true)
    expect(s82('settings:providers/local')).toBe(true)
    expect(s82('settings:providers/accounts')).toBe(false)
  })
})
