// F05 slice 12: local models on more than one model server, in the Desktop's windows. Each model server has its own
// hermes provider (`athena-vllm` for the default one, `athena-local-<id>` for another); a local model is listed and
// accepted only on its own server's provider, and only while main reports that server's forward up. A session on a
// model whose server went away moves to the role default through the existing auto-switch; a session on the other
// server's model stays. The snapshot a window gets carries no model server key.
import type { ModelOptionsResult } from '@hermes/shared'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as ConfigApi from '@/api/config'
import type { ClientSessionState } from '@/app/types'
import { requestModelOptions } from '@/lib/model-options'
import { displayModelName } from '@/lib/model-status-label'
import { queryClient } from '@/lib/query-client'
import type * as NotificationsModule from '@/store/notifications'
import { clearNotifications, notify } from '@/store/notifications'
import { $activeSessionId, $currentModel, $currentProvider } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { withoutModelServerKeys } from '../../../electron/athena/client-config'

import { $clientConfig, type ClientConfigSnapshot, setClientConfigSnapshot } from './client-config'
import { rpcPolicyForSnapshot } from './feature-policy'
import {
  BRIDGE_PROVIDER,
  LUNA,
  managedSnapshot,
  type ModelEntryFixture,
  QWEN,
  QWEN_NAME,
  SOL
} from './managed-models-fixture'
import { $managedModels, installModelPolicy } from './model-policy'
import { managedReasoning } from './model-reasoning'
import { MODEL_CATALOG } from './model-rows-fixture'
import { reconcileModelSessions, resetModelSwitches, type SelectModel } from './model-switch'
import { isModelSelectable, modelPickerProviders } from './models'

const GATEWAY = 'custom:athena-gateway'
const MARKER = 'sk-MARKER-model-server-key-7f3a9c'
const SERVER = 'hpc-llm'
const KEYED_PROVIDER = 'custom:athena-local-hpc-llm'

/** The friends seed's second local model: on the keyed server, known to it under its own id. */
const DEEPSEEK: ModelEntryFixture = {
  id: 'deepseek-v4f-moe',
  label: 'deepseek-v4f-moe',
  note: 'On the HPC',
  provider: 'bridge',
  reasoning: { default: 'medium', levels: ['medium'] }
}

// What hermes's `model.options` answers once managed scope pins a provider per model server.
const CATALOG: ModelOptionsResult = {
  ...MODEL_CATALOG,
  providers: [
    ...(MODEL_CATALOG.providers ?? []),
    { authenticated: true, models: [QWEN_NAME], name: 'Athena vLLM', slug: 'athena-vllm' },
    { authenticated: true, models: [DEEPSEEK.id], name: 'athena-local-hpc-llm', slug: 'athena-local-hpc-llm' }
  ]
}

vi.mock('@/hermes', async () => ({
  ...(await vi.importActual<typeof ConfigApi>('@/api/config')),
  getApiRequestProfile: () => 'default',
  getGlobalModelOptions: vi.fn(async () => CATALOG),
  profileScopeKey: (scope?: null | string) => (scope ?? '').trim() || 'default',
  setApiRequestProfile: () => {}
}))
vi.mock('@/lib/model-options', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestModelOptions: vi.fn()
}))
vi.mock('@/store/notifications', async importOriginal => {
  const actual = await importOriginal<typeof NotificationsModule>()

  return { ...actual, notify: vi.fn(actual.notify) }
})

/**
 * A snapshot as main sends it: local models on, the two servers in the config, and the forwards of `up` open. The
 * config goes through main's own strip (`withoutModelServerKeys`), as every snapshot does.
 */
function snapshot(up: readonly string[], configVersion = 5): ClientConfigSnapshot {
  const base = managedSnapshot([SOL, LUNA, QWEN, DEEPSEEK], {
    configVersion,
    default: 'gpt-6-sol',
    localModelsFeature: 'on',
    localModelsSwitch: true
  })

  const local = base.config.local_models as Record<string, unknown>

  const config = withoutModelServerKeys({
    ...base.config,
    local_models: {
      ...local,
      models: { ...(local.models as object), [DEEPSEEK.id]: { name: DEEPSEEK.id, server: SERVER } },
      servers: { [SERVER]: { host: '172.20.22.0', key: { type: 'shared', value: MARKER }, port: 9071 } }
    }
  })

  const ports: Record<string, number> = {}

  for (const [index, id] of up.entries()) {
    ports[id] = 49731 + index
  }

  return {
    ...base,
    config,
    ...(up.length > 0
      ? {
          hpcBridge: {
            address: '127.0.0.1',
            connectedAt: null,
            ...(ports.default === undefined ? {} : { port: ports.default }),
            servers: ports
          }
        }
      : {})
  }
}

const BOTH = ['default', SERVER]
const record = vi.fn()
let uninstall: () => void

beforeEach(() => {
  vi.mocked(requestModelOptions).mockResolvedValue(CATALOG)
  queryClient.clear()
  window.localStorage.clear()
  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { policy: { record } }
  uninstall = installModelPolicy()
  setClientConfigSnapshot(snapshot(BOTH))
})

afterEach(() => {
  uninstall()
  resetModelSwitches()
  $clientConfig.set(null)
  $sessionStates.set({})
  $activeSessionId.set(null)
  clearNotifications()
  vi.clearAllMocks()
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

const rows = () => modelPickerProviders(CATALOG.providers ?? [], []).map(row => [row.slug, row.models])
const pick = (model: string, provider: string) => ({ key: 'model', value: `${model} --provider ${provider} --session` })

describe('two model servers, both up', () => {
  test('the selector lists each local model on its own server row', () => {
    expect(rows()).toEqual([
      [GATEWAY, ['gpt-6-sol', 'gpt-6-luna']],
      ['athena-vllm', [QWEN_NAME]],
      ['athena-local-hpc-llm', [DEEPSEEK.id]]
    ])
    // Before hermes lists the providers (or on a Profile that has not applied yet) the rows are made up.
    expect(modelPickerProviders([], []).map(row => [row.name, row.slug, row.models])).toEqual([
      ['Athena gateway', GATEWAY, ['gpt-6-sol', 'gpt-6-luna']],
      ['Local models', BRIDGE_PROVIDER, [QWEN_NAME]],
      ['Local models (hpc-llm)', KEYED_PROVIDER, [DEEPSEEK.id]]
    ])
    expect(displayModelName(DEEPSEEK.id)).toBe('deepseek-v4f-moe')
    expect($managedModels.get()?.default).toBe('gpt-6-sol')
  })

  test('a pick passes the JSON-RPC seam on its own server provider, and only there', () => {
    const allowed = rpcPolicyForSnapshot($clientConfig.get())

    expect(allowed('config.set', pick(DEEPSEEK.id, KEYED_PROVIDER))).toBe(true)
    expect(allowed('config.set', pick(DEEPSEEK.id, 'athena-local-hpc-llm'))).toBe(true)
    expect(allowed('session.model', { model: DEEPSEEK.id, provider: KEYED_PROVIDER })).toBe(true)
    expect(allowed('config.set', pick(QWEN_NAME, BRIDGE_PROVIDER))).toBe(true)
    expect(isModelSelectable({ model: DEEPSEEK.id, provider: KEYED_PROVIDER })).toBe(true)
    expect(record).not.toHaveBeenCalled()

    // A model of one server on the other server's provider, or on the gateway; another model of the keyed server.
    expect(allowed('config.set', pick(DEEPSEEK.id, BRIDGE_PROVIDER))).toBe(false)
    expect(allowed('config.set', pick(QWEN_NAME, KEYED_PROVIDER))).toBe(false)
    expect(allowed('config.set', pick(DEEPSEEK.id, GATEWAY))).toBe(false)
    expect(allowed('config.set', pick('another-of-its-54', KEYED_PROVIDER))).toBe(false)
    expect(record.mock.calls.map(([line]) => [line.id, line.action])).toEqual([
      [DEEPSEEK.id, 'refused'],
      [QWEN_NAME, 'refused'],
      [DEEPSEEK.id, 'refused'],
      ['another-of-its-54', 'refused']
    ])
  })

  test("the keyed server's model offers its one reasoning level", () => {
    expect(managedReasoning(DEEPSEEK.id)).toMatchObject({ defaultLevel: 'medium', efforts: ['medium'] })
  })

  test('what a window holds has no model server key in it', () => {
    const held = $clientConfig.get()

    expect(JSON.stringify(held)).not.toContain(MARKER)
    expect((held?.config.local_models as { servers: Record<string, unknown> }).servers[SERVER]).toEqual({
      host: '172.20.22.0',
      key: { type: 'shared' },
      port: 9071
    })
    // Nor do the refusals a window records.
    rpcPolicyForSnapshot(held)('config.set', pick(DEEPSEEK.id, GATEWAY))
    expect(JSON.stringify(record.mock.calls)).not.toContain(MARKER)
  })
})

describe('one model server down', () => {
  test.each([
    ['the keyed server', ['default'], ['athena-vllm', [QWEN_NAME]], DEEPSEEK.id, KEYED_PROVIDER],
    ['the default server', [SERVER], ['athena-local-hpc-llm', [DEEPSEEK.id]], QWEN_NAME, BRIDGE_PROVIDER]
  ])('%s: the other server model stays listed and accepted', (_name, up, row, gone, goneProvider) => {
    setClientConfigSnapshot(snapshot(up, 6))

    expect(rows()).toEqual([[GATEWAY, ['gpt-6-sol', 'gpt-6-luna']], row])
    expect(isModelSelectable({ model: gone, provider: goneProvider })).toBe(false)

    const allowed = rpcPolicyForSnapshot($clientConfig.get())
    expect(allowed('config.set', pick(gone, goneProvider))).toBe(false)
    expect(allowed('config.set', pick((row[1] as string[])[0], row[0] as string))).toBe(true)
    expect(record.mock.calls.map(([line]) => [line.id, line.action])).toEqual([[gone, 'refused']])
  })

  test('with no forward up there is no local model at all', () => {
    setClientConfigSnapshot(snapshot([], 6))

    expect(rows()).toEqual([[GATEWAY, ['gpt-6-sol', 'gpt-6-luna']]])
  })
})

describe('open sessions follow their own model server', () => {
  const state = (model: string, provider: string) =>
    ({ busy: false, model, provider, reasoningEffort: '' }) as unknown as ClientSessionState

  const flush = () => act(async () => await new Promise(resolve => setTimeout(resolve, 0)))

  beforeEach(() => {
    $activeSessionId.set('rt-1')
    $currentModel.set(DEEPSEEK.id)
    $currentProvider.set(KEYED_PROVIDER)
    $sessionStates.set({
      'rt-1': state(DEEPSEEK.id, KEYED_PROVIDER),
      'rt-2': state(QWEN_NAME, BRIDGE_PROVIDER),
      'rt-3': state('gpt-6-luna', GATEWAY)
    })
  })

  test('both servers up: nobody moves', async () => {
    const select = vi.fn<SelectModel>(async () => true)

    reconcileModelSessions(select)
    await flush()

    expect(select).not.toHaveBeenCalled()
  })

  test('the keyed server goes away: its session moves to the role default, the other server session stays', async () => {
    const select = vi.fn<SelectModel>(async () => true)
    reconcileModelSessions(select) // seen while listed: its label is known

    setClientConfigSnapshot(snapshot(['default'], 6))
    reconcileModelSessions(select)
    await flush()

    expect(select.mock.calls.map(([selection]) => selection)).toEqual([{ model: 'gpt-6-sol', provider: GATEWAY }])
    expect(vi.mocked(notify).mock.calls.map(([input]) => input.message)).toEqual([
      'deepseek-v4f-moe is no longer available. Switched to GPT-6 Sol.'
    ])
  })

  test('the default server goes away: only the session on its model moves', async () => {
    const select = vi.fn<SelectModel>(async () => true)
    reconcileModelSessions(select)

    setClientConfigSnapshot(snapshot([SERVER], 6))
    reconcileModelSessions(select)
    await flush()

    expect(select.mock.calls.map(([selection]) => selection)).toEqual([
      { model: 'gpt-6-sol', provider: GATEWAY, sessionId: 'rt-2' }
    ])
  })
})
