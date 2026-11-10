// F02 slice 20: the managed.models master switch in the renderer. `enforce` narrows every picker and refuses a pick
// outside the list at the JSON-RPC seam (recorded); `report` narrows nothing, lets the pick through and records it
// once (an `athena:policy_decision`, kind model); `off` is stock and records nothing. The model gateway refuses the
// call in every mode (athena: tests/platform/e2e_managed_models.py).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { displayModelName } from '@/lib/model-status-label'

import { $clientConfig, setClientConfigSnapshot } from './client-config'
import { installFeaturePolicy } from './feature-policy'
import { LUNA, managedSnapshot, MOCK, SOL } from './managed-models-fixture'
import { installModelPolicy } from './model-policy'
import { MODEL_CATALOG } from './model-rows-fixture'
import { allowsCustomModelIds, modelPickerProviders } from './models'
import { PolicyRefusedError } from './policy-refusal'
import { assertRpcAllowed } from './rpc-seam'

const record = vi.fn()
let uninstall: () => void

beforeEach(() => {
  record.mockReset()
  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { policy: { record } }
  const offFeatures = installFeaturePolicy()
  const offModels = installModelPolicy()

  uninstall = () => {
    offModels()
    offFeatures()
  }
})

afterEach(() => {
  uninstall()
  $clientConfig.set(null)
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

const recorded = () =>
  record.mock.calls.map(([line]) => [line.kind, line.id, line.action, line.mode, line.surface, line.target])

/** A pick outside the list from the composer menu (config.set) and from /model (slash.exec). */
function pickOutside(): { picker: boolean; slash: boolean } {
  const tryRpc = (method: string, params: Record<string, unknown>) => {
    try {
      assertRpcAllowed(method, params)

      return true
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyRefusedError)

      return false
    }
  }

  return {
    picker: tryRpc('config.set', { key: 'model', session_id: 's1', value: 'claude-opus-4.8 --provider anthropic' }),
    slash: tryRpc('slash.exec', { command: 'model claude-opus-4.8', session_id: 's1' })
  }
}

const rowIds = () => modelPickerProviders(MODEL_CATALOG.providers ?? [], []).flatMap(row => row.models ?? [])

describe('managed.models in the renderer', () => {
  test('enforce: pickers narrowed, an outside pick refused at the seam and recorded', () => {
    setClientConfigSnapshot(managedSnapshot([SOL, LUNA, MOCK]))

    expect(rowIds()).toEqual(['gpt-6-sol', 'gpt-6-luna'])
    expect(allowsCustomModelIds()).toBe(false)
    expect(pickOutside()).toEqual({ picker: false, slash: false })
    expect(recorded()).toEqual([
      ['model', 'claude-opus-4.8', 'refused', 'enforce', 'rpc', 'config.set'],
      ['model', 'claude-opus-4.8', 'refused', 'enforce', 'rpc', 'slash.exec']
    ])
    // A listed pick and `/model reset` pass without a record.
    assertRpcAllowed('config.set', { key: 'model', value: 'gpt-6-luna --provider custom:athena-gateway' })
    assertRpcAllowed('slash.exec', { command: 'model reset' })
    expect(record).toHaveBeenCalledTimes(2)
  })

  test('report: pickers unfiltered, the outside pick allowed and recorded once per use', () => {
    setClientConfigSnapshot(managedSnapshot([SOL, LUNA, MOCK], { mode: 'report' }))

    expect(rowIds()).toEqual(['gpt-6-sol', 'gpt-6-luna', 'claude-opus-4.8', 'claude-sonnet-4.8'])
    expect(allowsCustomModelIds()).toBe(true)

    assertRpcAllowed('config.set', { key: 'model', session_id: 's1', value: 'claude-opus-4.8 --provider anthropic' })
    expect(recorded()).toEqual([['model', 'claude-opus-4.8', 'allowed_in_report', 'report', 'rpc', 'config.set']])

    assertRpcAllowed('config.set', { key: 'model', value: 'gpt-6-luna --provider custom:athena-gateway' })
    expect(record).toHaveBeenCalledTimes(1)
  })

  test('off: stock pickers and names, nothing refused or recorded', () => {
    setClientConfigSnapshot(managedSnapshot([SOL, LUNA, MOCK], { mode: 'off' }))

    expect(rowIds()).toEqual(['gpt-6-sol', 'gpt-6-luna', 'claude-opus-4.8', 'claude-sonnet-4.8'])
    expect(displayModelName('gpt-6-sol')).toBe('GPT-6-sol')
    expect(pickOutside()).toEqual({ picker: true, slash: true })
    expect(record).not.toHaveBeenCalled()
  })

  test('the stock variant leaves the pickers alone whatever the config says', () => {
    setClientConfigSnapshot({ ...managedSnapshot([LUNA]), variant: 'stock' })

    expect(rowIds()).toEqual(['gpt-6-sol', 'gpt-6-luna', 'claude-opus-4.8', 'claude-sonnet-4.8'])
    expect(pickOutside()).toEqual({ picker: true, slash: true })
  })
})
