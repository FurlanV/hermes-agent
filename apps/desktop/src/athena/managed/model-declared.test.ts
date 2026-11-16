// F13 slice 18: the renderer's pickers list a Model gateway model only once hermes managed scope declares it. Main
// puts what the managed file declares in each snapshot (`managedScope`); a config that offers a model before the
// Shipper has declared it lists it from the first snapshot that declares it, a removed model leaves with the config,
// and a snapshot without the managed file lists the config's models.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { queryClient } from '@/lib/query-client'

import type { ManagedScopeModels } from '../../../electron/athena/client-config-types'

import { type ClientConfigSnapshot, setClientConfigSnapshot } from './client-config'
import { LUNA, managedSnapshot, MOCK, type ModelEntryFixture, SOL } from './managed-models-fixture'
import { $managedModels, installModelPolicy, modelRpcAllowed } from './model-policy'
import { switchTarget } from './model-switch'
import { isModelSelectable, modelPickerProviders } from './models'

const GATEWAY = 'custom:athena-gateway'

const NEXT: ModelEntryFixture = {
  id: 'acme-next-1',
  label: 'Acme Next',
  reasoning: { default: 'low', levels: ['none', 'low'] }
}

const declaring = (ids: string[], hermesDefault = 'gpt-6-sol'): ManagedScopeModels => ({
  declared: { 'athena-gateway': ids },
  default: hermesDefault
})

const snapshot = (allowed: ModelEntryFixture[], scope: ManagedScopeModels | null, defaultId = 'acme-next-1') => {
  const base = managedSnapshot(allowed, { configVersion: 43, default: defaultId })

  return (scope ? { ...base, managedScope: scope } : base) satisfies ClientConfigSnapshot
}

const listed = () => modelPickerProviders([], []).flatMap(row => row.models ?? [])

let uninstall: () => void

beforeEach(() => {
  uninstall = installModelPolicy()
})

afterEach(() => {
  uninstall()
  setClientConfigSnapshot(managedSnapshot([SOL, LUNA, MOCK]))
  vi.restoreAllMocks()
})

describe('a gateway model the config offers before managed scope declares it', () => {
  test('is not listed or selectable until a snapshot declares it, and then is at once', () => {
    setClientConfigSnapshot(snapshot([SOL, LUNA, NEXT, MOCK], declaring(['gpt-6-sol', 'gpt-6-luna'])))

    expect(listed()).toEqual(['gpt-6-sol', 'gpt-6-luna'])
    expect(isModelSelectable({ model: 'acme-next-1', provider: GATEWAY })).toBe(false)
    // The config's new default is not declared yet: sessions moved off a removed model go to hermes's default.
    expect(switchTarget($managedModels.get()!)).toBe('gpt-6-sol')

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    setClientConfigSnapshot(snapshot([SOL, LUNA, NEXT, MOCK], declaring(['gpt-6-sol', 'gpt-6-luna', 'acme-next-1'])))

    expect(listed()).toEqual(['gpt-6-sol', 'gpt-6-luna', 'acme-next-1'])
    expect(isModelSelectable({ model: 'acme-next-1', provider: GATEWAY })).toBe(true)
    // The pick the picker sends goes through the JSON-RPC seam.
    expect(
      modelRpcAllowed($managedModels.get(), 'config.set', { key: 'model', value: `acme-next-1 --provider ${GATEWAY}` })
    ).toBe(true)
    expect(switchTarget($managedModels.get()!)).toBe('acme-next-1')
    // What hermes offers changed with the declaration: the cached model options are dropped.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['model-options'] })
  })

  test('a removed model leaves with the config, whatever managed scope still declares', () => {
    setClientConfigSnapshot(
      snapshot([SOL, LUNA, MOCK], declaring(['gpt-6-sol', 'gpt-6-luna', 'acme-next-1']), 'gpt-6-sol')
    )

    expect(listed()).toEqual(['gpt-6-sol', 'gpt-6-luna'])
    expect(isModelSelectable({ model: 'acme-next-1', provider: GATEWAY })).toBe(false)
  })

  test("without the managed file the config's list stands", () => {
    setClientConfigSnapshot(snapshot([SOL, LUNA, NEXT, MOCK], null))

    expect(listed()).toEqual(['gpt-6-sol', 'gpt-6-luna', 'acme-next-1'])
    expect(switchTarget($managedModels.get()!)).toBe('acme-next-1')
  })
})
