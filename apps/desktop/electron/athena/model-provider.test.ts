// F05 slice 02: every allowed model carries the provider that serves it. The Model gateway is the default, and the
// list, the picker rows and the gate read the provider from the model, never from a constant.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { BUNDLED_DEFAULT_CONFIG } from './bundled-config-data'
import { applyMainPolicies, configureMainPolicies } from './main-policy'
import {
  ATHENA_BRIDGE_PROVIDER,
  ATHENA_GATEWAY_PROVIDER,
  DEFAULT_MODEL_PROVIDER,
  findModelEntry,
  type ManagedModels,
  managedModels,
  managedPickerRows,
  MODEL_PROVIDERS,
  modelReasoning,
  modelUseDecision,
  type PickerRow,
  rpcModelChoice
} from './model-policy'
import { PolicyDecisionLog } from './policy-decisions'
import { refuseRestRequest, setMainPolicySeams } from './policy-seams'

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

// F05 slices 03 and 05: the client config can carry a bridge model (`provider: bridge`) and a `local_models` section.
// The Desktop lists one, on hermes's second provider and under the name the model server knows, only while local
// models are on (the section's switch AND feature row F05) and this laptop's bridge is up. Otherwise it is on no
// list: no picker shows it and a pick is refused and recorded. The gateway models are what they were either way.
describe('a config that offers a bridge model', () => {
  const NAME = 'DevQuasar/Qwen.Qwen3.8-27B-GGUF'

  const QWEN = {
    id: 'qwen-3.8-27B-GGUF',
    label: 'Qwen 3.8 27B (local)',
    provider: 'bridge',
    reasoning: { default: 'low', levels: ['none', 'low', 'medium', 'high', 'xhigh'] }
  }

  const localModels = (enabled: boolean) => ({
    enabled,
    login_host: 'login5.ccm.sickkids.ca',
    models: { [QWEN.id]: { name: NAME } },
    target_host: 'cn3825.ccm.sickkids.ca',
    target_port: 9931
  })

  const offered = (enabled = true, feature: 'off' | 'on' = 'on', allowed: unknown[] = [SOL, LUNA, QWEN]) => ({
    ...config(allowed),
    features: { ...(bundled.features as object), F05: feature },
    local_models: localModels(enabled)
  })

  const UP = { bridgeUp: true }

  test.each([
    ['the config switch off', offered(false), UP],
    ['feature row F05 off', offered(true, 'off'), UP],
    ['F05 at its build default (off)', { ...config([SOL, LUNA, QWEN]), local_models: localModels(true) }, UP],
    ['no bridge open', offered(), { bridgeUp: false }],
    ['no bridge state at all', offered(), undefined]
  ])('%s: no local model is listed, and a pick is refused and recorded', (_name, document, state) => {
    const models = managedModels(document, state)

    expect(models.visible.map(entry => entry.id)).toEqual(['gpt-6-sol', 'gpt-6-luna'])
    expect(models.default).toBe('gpt-6-sol')
    expect(managedPickerRows(models, []).map(row => [row.slug, row.models])).toEqual([
      [ATHENA_GATEWAY_PROVIDER, ['gpt-6-sol', 'gpt-6-luna']]
    ])
    // The config still says which local models there are (the later slices show them as not connected).
    expect(models.localModels.configured.map(entry => [entry.configId, entry.id])).toEqual([[QWEN.id, NAME]])

    for (const model of [NAME, QWEN.id]) {
      for (const provider of [undefined, ATHENA_BRIDGE_PROVIDER, ATHENA_GATEWAY_PROVIDER]) {
        expect(modelUseDecision(models, { model, provider }, 'rpc', 'config.set')).toEqual({
          allowed: false,
          record: { action: 'refused', id: model, mode: 'enforce', surface: 'rpc', target: 'config.set' }
        })
      }
    }
  })

  test('switch on, F05 on, bridge up: listed on the second provider under the server name, never the default', () => {
    const models = managedModels(offered(), UP)

    expect(models.localModels).toMatchObject({ bridgeUp: true, on: true })
    expect(models.visible.map(entry => entry.id)).toEqual(['gpt-6-sol', 'gpt-6-luna', NAME])
    expect(findModelEntry(models, NAME)).toMatchObject({
      configId: QWEN.id,
      defaultLevel: 'low',
      label: 'Qwen 3.8 27B (local)',
      levels: ['none', 'low', 'medium', 'high', 'xhigh'],
      provider: ATHENA_BRIDGE_PROVIDER
    })
    expect(modelReasoning(models, NAME)).toEqual({
      defaultLevel: 'low',
      levels: ['none', 'low', 'medium', 'high', 'xhigh']
    })
    expect(models.default).toBe('gpt-6-sol')
    // Hermes lists the provider as `athena-vllm`; its row is kept and carries exactly the local model.
    expect(
      managedPickerRows(models, [
        { models: ['gpt-4.1'], slug: 'athena-gateway' },
        { models: [NAME, 'something-else'], slug: 'athena-vllm' }
      ]).map(row => [row.slug, row.models])
    ).toEqual([
      ['athena-gateway', ['gpt-6-sol', 'gpt-6-luna']],
      ['athena-vllm', [NAME]]
    ])
    expect(managedPickerRows(models, [])[1]).toMatchObject({ name: 'Local models', slug: ATHENA_BRIDGE_PROVIDER })
  })

  test('a pick is accepted on its own provider only: a local model on the gateway is refused, and the reverse', () => {
    const models = managedModels(offered(), UP)

    const pick = (model: string, provider?: string) =>
      modelUseDecision(models, { model, provider }, 'rpc', 'config.set').allowed

    expect(pick(NAME, ATHENA_BRIDGE_PROVIDER)).toBe(true)
    expect(pick(NAME, 'athena-vllm')).toBe(true)
    expect(pick(NAME)).toBe(true)
    expect(pick(NAME, ATHENA_GATEWAY_PROVIDER)).toBe(false)
    expect(pick('gpt-6-sol', ATHENA_BRIDGE_PROVIDER)).toBe(false)
    expect(pick('gpt-6-sol', ATHENA_GATEWAY_PROVIDER)).toBe(true)
    // The config's own id is not a name hermes knows on the second provider.
    expect(pick(QWEN.id, ATHENA_BRIDGE_PROVIDER)).toBe(false)
    expect(
      rpcModelChoice('config.set', { key: 'model', value: `${NAME} --provider ${ATHENA_BRIDGE_PROVIDER} --session` })
    ).toEqual({ model: NAME, provider: ATHENA_BRIDGE_PROVIDER })
  })

  test('a bridge model is never the default, whatever the config says; hidden or unnamed ones are never offered', () => {
    const asDefault = { ...offered(), models: { allowed: [SOL, QWEN], default: QWEN.id } }
    expect(managedModels(asDefault, UP).default).toBe('gpt-6-sol')
    // Only local models listed: the first one stands in, so a session still has somewhere to go.
    expect(managedModels(offered(true, 'on', [QWEN]), UP).default).toBe(NAME)

    const hidden = managedModels(offered(true, 'on', [SOL, { ...QWEN, hidden: true }]), UP)
    expect(hidden.entries.map(entry => entry.id)).toEqual(['gpt-6-sol'])
    expect(hidden.localModels.configured).toEqual([])

    const unnamed = managedModels({ ...offered(), local_models: { ...localModels(true), models: {} } }, UP)
    expect(unnamed.entries.map(entry => entry.id)).toEqual(['gpt-6-sol', 'gpt-6-luna'])
  })

  test('a pre-slice reader, which knows no provider, sees the seeded entry as hidden: not in its pickers', () => {
    // What build 0.1.0-friends.1 reads of the friends seed: the entry without the field it does not know.
    const { provider: _unknown, ...seen } = { ...QWEN, hidden: true }
    const models = managedModels(config([SOL, LUNA, seen]))

    expect(models.visible.map(entry => entry.id)).toEqual(['gpt-6-sol', 'gpt-6-luna'])
  })
})

// The Settings default goes through main's REST seam (`POST /api/model/set`): a local model passes it only while
// it is on the list, and a refusal is recorded like any other model refusal.
describe("main's REST seam and a bridge model", () => {
  const NAME = 'DevQuasar/Qwen.Qwen3.8-27B-GGUF'
  const QWEN = { id: 'qwen-3.8-27B-GGUF', label: 'Qwen 3.8 27B (local)', provider: 'bridge' }

  const document = (enabled: boolean) => ({
    ...config([SOL, LUNA, QWEN]),
    features: { ...(bundled.features as object), F05: 'on' },
    local_models: { enabled, models: { [QWEN.id]: { name: NAME } } }
  })

  const setDefault = (provider: string) => ({
    body: { model: NAME, provider, scope: 'main' },
    method: 'POST',
    path: '/api/model/set'
  })

  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'athena-bridge-model-'))
    configureMainPolicies({ decisions: new PolicyDecisionLog({ file: path.join(dir, 'decisions.jsonl') }) })
  })

  afterEach(() => {
    setMainPolicySeams(null)
    configureMainPolicies({})
    rmSync(dir, { force: true, recursive: true })
  })

  const recorded = () => {
    try {
      return readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
    } catch {
      return []
    }
  }

  test('accepted while the switch is on and the bridge is up; nothing recorded', () => {
    applyMainPolicies({ config: document(true), hpcBridge: { address: '127.0.0.1', connectedAt: null, port: 49731 } })

    expect(refuseRestRequest(setDefault(ATHENA_BRIDGE_PROVIDER))).toBeNull()
    expect(refuseRestRequest(setDefault(ATHENA_GATEWAY_PROVIDER))).not.toBeNull()
    expect(recorded().map(row => [row.kind, row.action, row.id])).toEqual([['model', 'refused', NAME]])
  })

  test.each([
    ['the switch off', document(false), { address: '127.0.0.1', connectedAt: null, port: 49731 }],
    ['the bridge down', document(true), undefined]
  ])('%s: refused and recorded', (_name, config, hpcBridge) => {
    applyMainPolicies({ config, hpcBridge })

    expect(refuseRestRequest(setDefault(ATHENA_BRIDGE_PROVIDER))).not.toBeNull()
    expect(recorded()).toEqual([
      expect.objectContaining({
        action: 'refused',
        id: NAME,
        kind: 'model',
        mode: 'enforce',
        surface: 'rest',
        target: 'POST /api/model/set'
      })
    ])
  })
})
