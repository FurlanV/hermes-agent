// F05 slice 02: every allowed model carries the provider that serves it. The Model gateway is the default, and the
// list, the picker rows and the gate read the provider from the model, never from a constant.
import { describe, expect, test } from 'vitest'

import { BUNDLED_DEFAULT_CONFIG } from './bundled-config-data'
import {
  ATHENA_GATEWAY_PROVIDER,
  DEFAULT_MODEL_PROVIDER,
  findModelEntry,
  type ManagedModels,
  managedModels,
  managedPickerRows,
  MODEL_PROVIDERS,
  modelUseDecision,
  type PickerRow
} from './model-policy'

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

const SOL = { id: 'gpt-6-sol', label: 'GPT-6 Sol' }
const LUNA = { id: 'gpt-6-luna', label: 'GPT-6 Luna' }

const config = (allowed: unknown[]) => ({
  ...bundled,
  models: { allowed, default: 'gpt-6-sol', max_turns_limit: 90 }
})

describe('the provider of an allowed model', () => {
  test('a model that names none is on the Model gateway, and naming it changes nothing', () => {
    const plain = managedModels(config([SOL, LUNA]))
    const named = managedModels(config([{ ...SOL, provider: DEFAULT_MODEL_PROVIDER }, LUNA]))

    expect(MODEL_PROVIDERS[DEFAULT_MODEL_PROVIDER].slug).toBe(ATHENA_GATEWAY_PROVIDER)
    expect(plain.entries.map(entry => entry.provider)).toEqual([ATHENA_GATEWAY_PROVIDER, ATHENA_GATEWAY_PROVIDER])
    expect(named).toEqual(plain)
    expect(managedModels(bundled).entries.every(entry => entry.provider === ATHENA_GATEWAY_PROVIDER)).toBe(true)
  })

  test('a model on a provider this build does not know is not on the list: never shown, a pick refused', () => {
    const models = managedModels(config([SOL, { id: 'from-later', label: 'Later', provider: 'something-new' }, LUNA]))

    expect(models.entries.map(entry => entry.id)).toEqual(['gpt-6-sol', 'gpt-6-luna'])
    expect(findModelEntry(models, 'from-later')).toBeUndefined()
    expect(managedPickerRows(models, []).flatMap(row => row.models)).toEqual(['gpt-6-sol', 'gpt-6-luna'])
    expect(modelUseDecision(models, { model: 'from-later' }, 'rpc', 'config.set')).toMatchObject({
      allowed: false,
      record: { action: 'refused', id: 'from-later' }
    })
    // A default that is not on the list falls back to the first visible model.
    expect(
      managedModels({ models: { allowed: [{ ...SOL, provider: 'something-new' }, LUNA], default: 'gpt-6-sol' } })
        .default
    ).toBe('gpt-6-luna')
  })

  test('picker rows follow each entry: one row per provider, its own ids in config order', () => {
    const base = managedModels(config([SOL, LUNA]))
    const elsewhere = { ...base.entries[1], id: 'local-one', label: 'Local one', provider: 'custom:athena-elsewhere' }
    const entries = [base.entries[0], elsewhere, base.entries[1]]
    const models: ManagedModels = { ...base, entries, visible: entries }

    const catalog: PickerRow[] = [
      { models: ['gpt-4.1'], slug: 'custom:athena-gateway' },
      { models: ['other'], slug: 'openrouter' },
      { aliases: ['athena-elsewhere'], models: [], slug: 'custom:Athena-Elsewhere' }
    ]

    expect(managedPickerRows(models, catalog).map(row => [row.slug, row.models])).toEqual([
      ['custom:athena-gateway', ['gpt-6-sol', 'gpt-6-luna']],
      ['custom:Athena-Elsewhere', ['local-one']]
    ])
    // No catalog row for a provider: one is made up under the entry's provider, so the model still lists.
    expect(managedPickerRows(models, []).map(row => [row.slug, row.models])).toEqual([
      ['custom:athena-gateway', ['gpt-6-sol', 'gpt-6-luna']],
      ['custom:athena-elsewhere', ['local-one']]
    ])
  })
})
