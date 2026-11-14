// F05 slice 05: a local model (a bridge model, reached through the HPC bridge on hermes's second provider) in the
// Desktop. With local models on (the config's switch and feature row F05) and the bridge up, every picker lists
// it under the admin's label on a "Local models" row, a pick of it passes the JSON-RPC seam, and its reasoning
// levels are its entry's. With the switch or the row off, or the bridge down, it is in no picker and a pick by
// name is refused and recorded. An open session on it then moves to an allowed model, as for a removed gateway
// model (slice 21), through the app's own pick.
import type { ModelOptionsResult } from '@hermes/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { CanonicalDesktopProtocol } from '@/api/canonical-protocol'
import type * as ConfigApi from '@/api/config'
import { useModelControls } from '@/app/session/hooks/use-model-controls'
import { ModelSettings } from '@/app/settings/model-settings'
import { ModelCatalogMenu, ModelMenuCloseContext, type ModelMenuController } from '@/app/shell/model-catalog-menu'
import type { ClientSessionState } from '@/app/types'
import { ModelPickerDialog } from '@/components/model-picker'
import { ModelVisibilityDialog } from '@/components/model-visibility-dialog'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { I18nProvider } from '@/i18n'
import { requestModelOptions } from '@/lib/model-options'
import { displayModelName } from '@/lib/model-status-label'
import { queryClient } from '@/lib/query-client'
import { $customModels } from '@/store/custom-models'
import { $favoriteModels } from '@/store/favorite-models'
import { $localModelsEnabled } from '@/store/local-models-flag'
import { $visibleModels, setModelVisibilityOpen } from '@/store/model-visibility'
import type * as NotificationsModule from '@/store/notifications'
import { clearNotifications, notify } from '@/store/notifications'
import { $activeSessionId, $currentModel, $currentProvider } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { $clientConfig, setClientConfigSnapshot } from './client-config'
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
import { managedReasoning, reasoningSlashRefusal } from './model-reasoning'
import { MODEL_CATALOG } from './model-rows-fixture'
import { reconcileModelSessions, resetModelSwitches, type SelectModel } from './model-switch'
import { isModelSelectable, modelPickerProviders } from './models'

const GATEWAY = 'custom:athena-gateway'

// What hermes's `model.options` answers while managed scope pins the second provider: the gateway's row, and
// `athena-vllm` with the model under the server's name.
const CATALOG: ModelOptionsResult = {
  ...MODEL_CATALOG,
  providers: [
    ...(MODEL_CATALOG.providers ?? []),
    { authenticated: true, models: [QWEN_NAME], name: 'Athena vLLM', slug: 'athena-vllm' }
  ]
}

vi.mock('@/hermes', async () => ({
  ...(await vi.importActual<typeof ConfigApi>('@/api/config')),
  getApiRequestProfile: () => 'default',
  getAuxiliaryModels: vi.fn(async () => ({
    main: { model: 'gpt-6-sol', provider: 'custom:athena-gateway' },
    tasks: []
  })),
  getGlobalModelInfo: vi.fn(async () => ({ model: 'gpt-6-sol', provider: 'custom:athena-gateway' })),
  getGlobalModelOptions: vi.fn(async () => CATALOG),
  getHermesConfigRecord: vi.fn(async () => ({ agent: { reasoning_effort: 'medium' } })),
  getLocalModelsJobs: vi.fn(async () => ({ jobs: [] })),
  getLocalModelsStatus: vi.fn().mockResolvedValue({ loading: {} }),
  getMoaModels: vi.fn(async () => null),
  getRecommendedDefaultModel: vi.fn(async () => null),
  profileScopeKey: (scope?: null | string) => (scope ?? '').trim() || 'default',
  saveHermesConfig: vi.fn(async () => ({ ok: true })),
  setApiRequestProfile: () => {}
}))
vi.mock('@/lib/model-options', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestModelOptions: vi.fn()
}))
vi.mock('@/app/hooks/use-on-profile-switch', () => ({ useOnProfileSwitch: () => {} }))
vi.mock('@/store/notifications', async importOriginal => {
  const actual = await importOriginal<typeof NotificationsModule>()

  return { ...actual, notify: vi.fn(actual.notify) }
})

stubResizeObserver()
stubMenuDomApis()

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const ROLE: ModelEntryFixture[] = [SOL, LUNA, QWEN]

/** Local models on and the bridge up, unless an option says otherwise. */
const snapshot = (
  options: { bridge?: boolean; configVersion?: number; feature?: 'off' | 'on'; switchOn?: boolean } = {},
  allowed = ROLE
) =>
  managedSnapshot(allowed, {
    bridge: options.bridge ?? true,
    configVersion: options.configVersion ?? 5,
    default: allowed.find(entry => entry.provider !== 'bridge')?.id ?? 'gpt-6-sol',
    localModelsFeature: options.feature ?? 'on',
    localModelsSwitch: options.switchOn ?? true
  })

const record = vi.fn()
let uninstall: () => void

beforeEach(() => {
  vi.mocked(requestModelOptions).mockResolvedValue(CATALOG)
  queryClient.clear()
  window.localStorage.clear()
  $visibleModels.set(null)
  $favoriteModels.set([])
  $customModels.set([])
  $localModelsEnabled.set(false)
  setModelVisibilityOpen(false)
  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { policy: { record } }
  uninstall = installModelPolicy()
  setClientConfigSnapshot(snapshot())
})

afterEach(() => {
  cleanup()
  uninstall()
  resetModelSwitches()
  $clientConfig.set(null)
  $sessionStates.set({})
  $activeSessionId.set(null)
  clearNotifications()
  vi.clearAllMocks()
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

const controller = (): ModelMenuController => ({
  applyPreset: vi.fn(),
  current: { effort: '', fast: false, model: 'gpt-6-sol', provider: GATEWAY },
  presetFor: () => ({}),
  select: vi.fn(),
  setOptions: vi.fn()
})

function renderMenu(menu: ModelMenuController = controller()) {
  render(
    <QueryClientProvider client={queryClient}>
      <ModelMenuCloseContext.Provider value={vi.fn()}>
        <DropdownMenu open>
          <DropdownMenuContent>
            <ModelCatalogMenu controller={menu} />
          </DropdownMenuContent>
        </DropdownMenu>
      </ModelMenuCloseContext.Provider>
    </QueryClientProvider>
  )

  return menu
}

const menuRows = () => screen.getAllByRole('menuitem').map(item => item.textContent?.trim() ?? '')
const rows = () => modelPickerProviders(CATALOG.providers ?? [], []).map(row => [row.slug, row.models])

const recorded = () =>
  record.mock.calls.map(([line]) => [line.kind, line.id, line.action, line.mode, line.surface, line.target])

const pick = (model: string, provider: string) => ({ key: 'model', value: `${model} --provider ${provider} --session` })

describe('local models on and the bridge up: every picker lists the local model', () => {
  test('the selector: the gateway row, then the second provider with the model under the name hermes knows', () => {
    expect(rows()).toEqual([
      [GATEWAY, ['gpt-6-sol', 'gpt-6-luna']],
      ['athena-vllm', [QWEN_NAME]]
    ])
    // No catalog yet (or a Profile whose hermes has not seen the second provider): the row is made up.
    expect(modelPickerProviders([], []).map(row => [row.name, row.slug, row.models])).toEqual([
      ['Athena gateway', GATEWAY, ['gpt-6-sol', 'gpt-6-luna']],
      ['Local models', BRIDGE_PROVIDER, [QWEN_NAME]]
    ])
    expect(displayModelName(QWEN_NAME)).toBe('Qwen 3.8 27B (local)')
  })

  test('composer model menu: listed with its label and note, and a click picks it on the second provider', async () => {
    const menu = renderMenu()
    await waitFor(() => expect(menuRows().join('\n')).toContain('Qwen 3.8 27B (local)'))

    expect(menuRows()).toEqual([
      'Athena gateway',
      expect.stringMatching(/^GPT-6 SolMost capable/),
      expect.stringMatching(/^GPT-6 LunaFaster/),
      'Athena vLLM',
      // Its row says the admin's note and, since slice 08, whether it is connected.
      expect.stringMatching(/^Qwen 3\.8 27B \(local\)On the HPC · Connected/),
      'Edit models…'
    ])

    fireEvent.click(screen.getByRole('menuitem', { name: /Qwen 3\.8 27B \(local\)/ }))
    expect(vi.mocked(menu.select).mock.calls[0].slice(0, 2)).toEqual([QWEN_NAME, 'athena-vllm'])
  })

  test('the picker dialog and Edit Models list it', async () => {
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider>
          <ModelPickerDialog
            currentModel="gpt-6-sol"
            currentProvider={GATEWAY}
            onOpenChange={() => undefined}
            onSelect={() => undefined}
            open
          />
        </I18nProvider>
      </QueryClientProvider>
    )

    await screen.findByText('Qwen 3.8 27B (local)')
    expect(screen.getAllByRole('option').map(item => item.textContent?.trim())).toEqual([
      expect.stringMatching(/^GPT-6 Sol/),
      'GPT-6 Luna',
      'Qwen 3.8 27B (local)Connected'
    ])
    unmount()

    render(
      <QueryClientProvider client={queryClient}>
        <ModelVisibilityDialog onOpenChange={() => undefined} onOpenProviders={() => undefined} open />
      </QueryClientProvider>
    )
    await screen.findByText('Qwen 3.8 27B (local)')
    expect(
      within(screen.getByRole('dialog'))
        .getAllByRole('switch')
        .map(row => row.closest('label')?.textContent?.trim())
    ).toEqual(['GPT-6 Sol', 'GPT-6 Luna', 'Qwen 3.8 27B (local)'])
  })

  test('Settings default model: a local model is never a default, and the select does not offer one', async () => {
    // The select lists the models of the main model's own provider (the Model gateway; the role has no Provider
    // row), so the second provider's models are not in it. Managed scope pins the default to a gateway model anyway.
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ModelSettings />
        </QueryClientProvider>
      </MemoryRouter>
    )
    const model = await screen.findByRole('combobox', { name: 'Model' })
    await within(model).findByText('GPT-6 Sol')
    fireEvent.click(model)
    expect((await screen.findAllByRole('option')).map(option => option.textContent?.trim())).toEqual([
      'GPT-6 Sol',
      'GPT-6 Luna'
    ])
  })

  test('a pick passes the JSON-RPC seam on its own provider, and only there; nothing is recorded for it', () => {
    const allowed = rpcPolicyForSnapshot($clientConfig.get())

    expect(allowed('config.set', pick(QWEN_NAME, BRIDGE_PROVIDER))).toBe(true)
    expect(allowed('config.set', pick(QWEN_NAME, 'athena-vllm'))).toBe(true)
    expect(allowed('session.model', { model: QWEN_NAME, provider: BRIDGE_PROVIDER })).toBe(true)
    expect(isModelSelectable({ model: QWEN_NAME, provider: BRIDGE_PROVIDER })).toBe(true)
    expect(isModelSelectable({ model: QWEN_NAME })).toBe(true)
    expect(record).not.toHaveBeenCalled()

    // The local model through the gateway, a gateway model through the bridge, anything else on the bridge.
    expect(allowed('config.set', pick(QWEN_NAME, GATEWAY))).toBe(false)
    expect(allowed('config.set', pick('gpt-6-sol', BRIDGE_PROVIDER))).toBe(false)
    expect(allowed('config.set', pick('some-other-model', BRIDGE_PROVIDER))).toBe(false)
    expect(recorded().map(line => [line[1], line[2]])).toEqual([
      [QWEN_NAME, 'refused'],
      ['gpt-6-sol', 'refused'],
      ['some-other-model', 'refused']
    ])
  })

  test("reasoning levels follow the local model's entry", () => {
    expect(managedReasoning(QWEN_NAME)).toEqual({
      defaultLevel: 'low',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      state: 'levels',
      thinkingToggle: true
    })
    expect(reasoningSlashRefusal('xhigh', QWEN_NAME)).toBeNull()
    expect(reasoningSlashRefusal('max', QWEN_NAME)).toBe(
      "max isn't available for Qwen 3.8 27B (local). Choose none, low, medium, high, xhigh."
    )
  })
})

describe('local models off: the local model is in no picker and a pick is refused and recorded', () => {
  test.each([
    ['the config switch off', { switchOn: false }],
    ['feature row F05 off', { feature: 'off' as const }]
  ])('%s', async (_name, options) => {
    setClientConfigSnapshot(snapshot({ ...options, configVersion: 6 }))

    expect(rows()).toEqual([[GATEWAY, ['gpt-6-sol', 'gpt-6-luna']]])
    expect(isModelSelectable({ model: QWEN_NAME, provider: BRIDGE_PROVIDER })).toBe(false)
    expect(isModelSelectable({ model: QWEN.id })).toBe(false)

    renderMenu()
    await waitFor(() => expect(menuRows().join('\n')).toContain('GPT-6 Luna'))
    expect(menuRows().join('\n')).not.toMatch(/Qwen|vLLM|Local models/)

    const allowed = rpcPolicyForSnapshot($clientConfig.get())
    expect(allowed('config.set', pick(QWEN_NAME, BRIDGE_PROVIDER))).toBe(false)
    expect(allowed('slash.exec', { command: `/model ${QWEN_NAME}` })).toBe(false)
    expect(allowed('command.dispatch', { arg: QWEN.id, name: 'model' })).toBe(false)
    expect(recorded()).toEqual([
      ['model', QWEN_NAME, 'refused', 'enforce', 'rpc', 'config.set'],
      ['model', QWEN_NAME, 'refused', 'enforce', 'rpc', 'slash.exec'],
      ['model', QWEN.id, 'refused', 'enforce', 'rpc', 'command.dispatch']
    ])
  })

  // F05 slice 07: with local models on, the model stays in the pickers while the bridge is down (so a pick can
  // offer the connection, local-models-connect.test.tsx); what may be called does not change.
  test('the bridge down: still listed, and a pick by name is refused and recorded at the seams', async () => {
    setClientConfigSnapshot(snapshot({ bridge: false, configVersion: 6 }))

    expect(rows()).toEqual([
      [GATEWAY, ['gpt-6-sol', 'gpt-6-luna']],
      ['athena-vllm', [QWEN_NAME]]
    ])
    expect($managedModels.get()?.entries.map(entry => entry.id)).toEqual(['gpt-6-sol', 'gpt-6-luna'])
    expect(isModelSelectable({ model: QWEN_NAME, provider: BRIDGE_PROVIDER })).toBe(false)
    expect(isModelSelectable({ model: QWEN.id })).toBe(false)

    renderMenu()
    await waitFor(() => expect(menuRows().join('\n')).toContain('Qwen 3.8 27B (local)'))

    const allowed = rpcPolicyForSnapshot($clientConfig.get())
    expect(allowed('config.set', pick(QWEN_NAME, BRIDGE_PROVIDER))).toBe(false)
    expect(allowed('slash.exec', { command: `/model ${QWEN_NAME}` })).toBe(false)
    expect(allowed('command.dispatch', { arg: QWEN.id, name: 'model' })).toBe(false)
    expect(recorded()).toEqual([
      ['model', QWEN_NAME, 'refused', 'enforce', 'rpc', 'config.set'],
      ['model', QWEN_NAME, 'refused', 'enforce', 'rpc', 'slash.exec'],
      ['model', QWEN.id, 'refused', 'enforce', 'rpc', 'command.dispatch']
    ])
  })

  test('the bridge coming and going drops the cached model options, and the model keeps its row and label', async () => {
    setClientConfigSnapshot(snapshot({ bridge: false }))
    renderMenu()
    await waitFor(() => expect(menuRows().join('\n')).toContain('Qwen 3.8 27B (local)'))
    const invalidated = vi.spyOn(queryClient, 'invalidateQueries')

    act(() => setClientConfigSnapshot(snapshot({ bridge: true })))
    await waitFor(() => expect(isModelSelectable({ model: QWEN_NAME, provider: BRIDGE_PROVIDER })).toBe(true))
    expect(invalidated).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['model-options'] }))

    act(() => setClientConfigSnapshot(snapshot({ bridge: false })))
    expect(isModelSelectable({ model: QWEN_NAME, provider: BRIDGE_PROVIDER })).toBe(false)
    expect(menuRows().join('\n')).toContain('Qwen 3.8 27B (local)')
    // An old session still shows the admin's label, not the server's name.
    expect(displayModelName(QWEN_NAME)).toBe('Qwen 3.8 27B (local)')
  })
})

describe('open sessions and the second provider', () => {
  const state = (model: string, provider: string, busy = false) =>
    ({ busy, model, provider, reasoningEffort: '' }) as unknown as ClientSessionState

  const flush = () => act(async () => await new Promise(resolve => setTimeout(resolve, 0)))
  const toasts = () => vi.mocked(notify).mock.calls.map(([input]) => input.message)
  const MOVED = 'Qwen 3.8 27B (local) is no longer available. Switched to GPT-6 Sol.'
  // Since slice 08: with local models still on, the model is not gone, only not connected.
  const NOT_CONNECTED = 'Qwen 3.8 27B (local) is not connected. Switched to GPT-6 Sol.'

  beforeEach(() => {
    $activeSessionId.set('rt-1')
    $currentModel.set(QWEN_NAME)
    $currentProvider.set(BRIDGE_PROVIDER)
    $sessionStates.set({
      'rt-1': state(QWEN_NAME, BRIDGE_PROVIDER),
      'rt-2': state(QWEN_NAME, BRIDGE_PROVIDER),
      'rt-3': state('gpt-6-luna', GATEWAY)
    })
  })

  test('a session on the local model stays on it while local models are on and the bridge is up', async () => {
    const select = vi.fn<SelectModel>(async () => true)

    reconcileModelSessions(select)
    await flush()

    expect(select).not.toHaveBeenCalled()
    expect(toasts()).toEqual([])
  })

  test.each([
    ['the switch goes off', { switchOn: false }, MOVED],
    ['feature row F05 goes off', { feature: 'off' as const }, MOVED],
    ['the bridge closes', { bridge: false }, NOT_CONNECTED]
  ])('%s: each session on the local model moves to the role default, with one toast', async (_name, options, toast) => {
    const select = vi.fn<SelectModel>(async () => true)
    reconcileModelSessions(select) // seen while it was still listed: its label is known

    setClientConfigSnapshot(snapshot({ ...options, configVersion: 6 }))
    reconcileModelSessions(select)
    await flush()

    expect(select.mock.calls.map(([selection]) => selection)).toEqual([
      { model: 'gpt-6-sol', provider: GATEWAY },
      { model: 'gpt-6-sol', provider: GATEWAY, sessionId: 'rt-2' }
    ])
    expect(toasts()).toEqual([toast, toast])

    reconcileModelSessions(select)
    await flush()
    expect(select).toHaveBeenCalledTimes(2)
  })

  test('a session mid-turn on the local model keeps its turn and moves when the turn ends', async () => {
    const select = vi.fn<SelectModel>(async () => true)
    $sessionStates.set({ ...$sessionStates.get(), 'rt-2': state(QWEN_NAME, BRIDGE_PROVIDER, true) })
    setClientConfigSnapshot(snapshot({ bridge: false }))

    reconcileModelSessions(select)
    await flush()
    expect(select.mock.calls.map(([selection]) => selection.sessionId)).toEqual([undefined])

    $sessionStates.set({ ...$sessionStates.get(), 'rt-2': state(QWEN_NAME, BRIDGE_PROVIDER) })
    reconcileModelSessions(select)
    await flush()
    expect(select.mock.calls.map(([selection]) => selection.sessionId)).toEqual([undefined, 'rt-2'])
  })

  test('the target is picked on the provider its own entry names: a role with only a local model left', async () => {
    // Slice 02 left this untested: the switch reads the target's provider from the entry, never a constant.
    const select = vi.fn<SelectModel>(async () => true)
    $currentModel.set('gpt-6-sol')
    $currentProvider.set(GATEWAY)
    $sessionStates.set({ 'rt-1': state('gpt-6-sol', GATEWAY) })
    setClientConfigSnapshot(snapshot({}, [SOL, QWEN]))
    reconcileModelSessions(select)

    setClientConfigSnapshot(snapshot({ configVersion: 6 }, [QWEN]))
    expect($managedModels.get()?.default).toBe(QWEN_NAME)
    reconcileModelSessions(select)
    await flush()

    expect(select.mock.calls.map(([selection]) => selection)).toEqual([{ model: QWEN_NAME, provider: BRIDGE_PROVIDER }])
    expect(toasts()).toEqual(['GPT-6 Sol is no longer available. Switched to Qwen 3.8 27B (local).'])
  })

  test('on the wire: the move off the local model, and a pick of it, are the fenced session.mutate', async () => {
    const requests: [string, Record<string, unknown>][] = []

    const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      requests.push([method, params ?? {}])

      return {} as never
    })

    const { result } = renderHook(() =>
      useModelControls({ queryClient: new QueryClient(), requestGateway: requestGateway as never })
    )

    $activeSessionId.set('rt-9')
    $currentModel.set('gpt-6-luna')
    $currentProvider.set(GATEWAY)
    $sessionStates.set({ 'rt-2': state(QWEN_NAME, BRIDGE_PROVIDER) })
    setClientConfigSnapshot(snapshot({ switchOn: false, configVersion: 6 }))
    reconcileModelSessions(selection => result.current.selectModel(selection))
    await flush()

    expect(requests).toEqual([
      ['config.set', { key: 'model', session_id: 'rt-2', value: `gpt-6-sol --provider ${GATEWAY} --session` }]
    ])

    // And the other way, a pick of the local model from a picker row, once it is back.
    setClientConfigSnapshot(snapshot({ configVersion: 7 }))
    requests.length = 0
    await act(async () => {
      await result.current.selectModel({ model: QWEN_NAME, provider: BRIDGE_PROVIDER, sessionId: 'rt-2' })
    })
    expect(requests).toEqual([
      [
        'config.set',
        { key: 'model', session_id: 'rt-2', value: `${QWEN_NAME} --provider ${BRIDGE_PROVIDER} --session` }
      ]
    ])
    expect(rpcPolicyForSnapshot($clientConfig.get())(...requests[0])).toBe(true)

    const protocol = new CanonicalDesktopProtocol()
    protocol.result(
      'session.resume',
      { session_id: 'rt-2' },
      { execution_generation: 4, revision: 7, session_id: 'rt-2' }
    )
    const wire = protocol.prepare(...requests[0])
    expect(protocol.wire('config.set', wire)).toBe('session.mutate')
    expect(wire).toMatchObject({
      operation: 'model',
      payload: { model: QWEN_NAME, provider: BRIDGE_PROVIDER },
      session_id: 'rt-2'
    })
  })
})
