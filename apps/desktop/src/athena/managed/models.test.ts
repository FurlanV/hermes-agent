import type { ModelOptionProvider } from '@hermes/shared'
import { afterEach, describe, expect, test } from 'vitest'

import { withCustomModels } from '@/store/custom-models'

import { REMEMBERED_CUSTOM_MODELS, TYPED_CUSTOM_ID } from './model-rows-fixture'
import {
  ALLOW_ALL_MODELS,
  allowsCustomModelIds,
  isModelSelectable,
  modelPickerCustomCandidate,
  modelPickerProviders,
  modelSlashChoice,
  setModelPolicy
} from './models'

const catalog: ModelOptionProvider[] = [
  { models: ['gpt-6-sol', 'gpt-6-luna'], name: 'Athena gateway', slug: 'custom:athena-gateway' },
  { models: ['claude-opus-4.8'], name: 'Anthropic', slug: 'anthropic' }
]

afterEach(() => setModelPolicy(null))

describe('model-options selector', () => {
  test('allows everything by default: catalog plus remembered custom ids, as before', () => {
    expect(isModelSelectable({ model: 'anything' })).toBe(true)
    expect(allowsCustomModelIds()).toBe(true)
    expect(modelPickerProviders(catalog, REMEMBERED_CUSTOM_MODELS)).toEqual(
      withCustomModels(catalog, REMEMBERED_CUSTOM_MODELS)
    )
    // Same reference when nothing applies, so memoized pickers keep theirs.
    expect(modelPickerProviders(catalog, [])).toBe(catalog)
    expect(modelPickerCustomCandidate(TYPED_CUSTOM_ID, catalog)).toBe(TYPED_CUSTOM_ID)
    expect(modelPickerCustomCandidate('gpt-6-sol', catalog)).toBeNull()
  })

  test('one policy narrows every row, custom ids included', () => {
    setModelPolicy({ customIds: true, selectable: ({ model }) => model !== 'gpt-6-sol' })

    const rows = modelPickerProviders(catalog, REMEMBERED_CUSTOM_MODELS)

    expect(rows.map(provider => provider.models)).toEqual([
      ['gpt-6-luna', 'gpt-6-custom-preview'],
      ['claude-opus-4.8', 'claude-custom-lab']
    ])
    expect(modelPickerProviders(catalog, [], { ...ALLOW_ALL_MODELS, selectable: () => true })).toBe(catalog)
  })

  test('turning custom ids off drops remembered and typed ids', () => {
    setModelPolicy({ customIds: false, selectable: () => true })

    expect(modelPickerProviders(catalog, REMEMBERED_CUSTOM_MODELS)).toBe(catalog)
    expect(modelPickerCustomCandidate(TYPED_CUSTOM_ID, catalog)).toBeNull()
    expect(allowsCustomModelIds()).toBe(false)
  })
})

describe('/model argument', () => {
  test.each([
    ['gpt-6-luna', { model: 'gpt-6-luna' }],
    ['gpt-6-luna --provider custom:athena-gateway', { model: 'gpt-6-luna', provider: 'custom:athena-gateway' }],
    ['--provider anthropic claude-opus-4.8 --session', { model: 'claude-opus-4.8', provider: 'anthropic' }],
    ['  ', null],
    ['--global', null]
  ])('%j', (arg, choice) => {
    expect(modelSlashChoice(arg)).toEqual(choice)
  })
})
