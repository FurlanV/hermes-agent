// F05 slice 08: the status of local models in the Desktop window. Next to each local model the pickers say
// connected, connecting, or not connected with the reason; a pick of one that is not connected offers to connect;
// Settings › Model has the place to disconnect (which forgets the password) and to forget the remembered user name;
// and a session on a local model waits a moment for a bridge that is on its way instead of being moved at once.
// Main is a stand-in (`window.athenaDesktop.hpcBridge`); electron/athena/hpc-bridge-password.test.ts covers main.
import type { ModelOptionsResult } from '@hermes/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as ConfigApi from '@/api/config'
import { useModelControls } from '@/app/session/hooks/use-model-controls'
import { ModelSettings } from '@/app/settings/model-settings'
import { ModelCatalogMenu, ModelMenuCloseContext, type ModelMenuController } from '@/app/shell/model-catalog-menu'
import type { ClientSessionState } from '@/app/types'
import { ModelPickerDialog } from '@/components/model-picker'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { I18nProvider } from '@/i18n'
import { requestModelOptions } from '@/lib/model-options'
import { queryClient } from '@/lib/query-client'
import { $customModels } from '@/store/custom-models'
import { $favoriteModels } from '@/store/favorite-models'
import { $visibleModels } from '@/store/model-visibility'
import type * as NotificationsModule from '@/store/notifications'
import { $notifications, clearNotifications, notify } from '@/store/notifications'
import { $activeSessionId, $currentModel, $currentProvider } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import type { HpcBridgeSignIn, HpcBridgeStatus } from '../../../electron/athena/hpc-bridge-types'

import { $clientConfig, setClientConfigSnapshot } from './client-config'
import {
  $hpcBridge,
  LOCAL_MODEL_GRACE_MS,
  localModelGrace,
  modelServerDownMessage,
  pendingLocalModelPick,
  setLocalModelSelector,
  setPendingPickDelay
} from './local-models'
import { AthenaLocalModelsDialog } from './local-models-dialog'
import { AthenaLocalModelsSettings } from './local-models-settings'
import { bridgeStatus, canDisconnect, localModelStatus, statusLine, statusTag } from './local-models-status'
import { BRIDGE_PROVIDER, LUNA, managedSnapshot, QWEN, QWEN_NAME, SOL } from './managed-models-fixture'
import { $managedModels, installModelPolicy } from './model-policy'
import { MODEL_CATALOG } from './model-rows-fixture'
import { reconcileModelSessions, resetModelSwitches, type SelectModel, switchTarget } from './model-switch'
import { modelPickerProviders } from './models'

const GATEWAY = 'custom:athena-gateway'
const USER = 'researcher1'

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

const snapshot = (options: { bridge?: boolean; feature?: 'off' | 'on'; switchOn?: boolean } = {}) =>
  managedSnapshot([SOL, LUNA, QWEN], {
    bridge: options.bridge ?? false,
    configVersion: 5,
    default: 'gpt-6-sol',
    localModelsFeature: options.feature ?? 'on',
    localModelsSwitch: options.switchOn ?? true
  })

const NOW = () => new Date().toISOString()

const status = (patch: Partial<HpcBridgeStatus> = {}): HpcBridgeStatus => ({
  credential: 'none',
  since: NOW(),
  state: 'no_key',
  ...patch
})

const connected = (patch: Partial<HpcBridgeStatus> = {}): HpcBridgeStatus =>
  status({
    credential: 'password',
    port: 49731,
    servers: { default: { port: 49731, state: 'up' } },
    state: 'connected',
    username: USER,
    ...patch
  })

const down = (reason: string, patch: Partial<HpcBridgeStatus> = {}): HpcBridgeStatus =>
  status({ credential: 'password', reason, state: 'down', username: USER, ...patch })

const serverDown = () =>
  connected({ port: undefined, servers: { default: { reason: 'target_unreachable', state: 'down' } } })

function fakeBridge(initial: HpcBridgeStatus) {
  const listeners = new Set<(next: HpcBridgeStatus) => void>()

  const bridge = {
    connect: vi.fn(async (_signIn?: HpcBridgeSignIn): Promise<HpcBridgeStatus> => bridge.current),
    current: initial,
    disconnect: vi.fn(async (): Promise<HpcBridgeStatus> => bridge.current),
    forgetUser: vi.fn(async (): Promise<HpcBridgeStatus> => bridge.current),
    onChanged: (callback: (next: HpcBridgeStatus) => void) => {
      listeners.add(callback)

      return () => listeners.delete(callback)
    },
    push: (next: HpcBridgeStatus) => {
      bridge.current = next
      listeners.forEach(listener => listener(next))
    },
    status: vi.fn(async () => bridge.current)
  }

  return bridge
}

let bridge: ReturnType<typeof fakeBridge>
let uninstall: () => void
let requests: [string, Record<string, unknown>][]

const flush = () => act(async () => await new Promise(resolve => setTimeout(resolve, 0)))
const toasts = () => vi.mocked(notify).mock.calls.map(([input]) => input.message)
const rows = () => modelPickerProviders(CATALOG.providers ?? [], []).map(row => [row.slug, row.models])

async function start(initial: HpcBridgeStatus, config = snapshot()) {
  bridge = fakeBridge(initial)
  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { hpcBridge: bridge, policy: { record: vi.fn() } }
  uninstall = installModelPolicy()
  setClientConfigSnapshot(config)
  await flush()
}

/** Main says something new: the status, and (as main does) the snapshot that goes with it. */
const push = (next: HpcBridgeStatus, bridgeUp = false) =>
  act(() => {
    bridge.push(next)
    setClientConfigSnapshot(snapshot({ bridge: bridgeUp }))
  })

const controller = (): ModelMenuController => ({
  applyPreset: vi.fn(),
  current: { effort: '', fast: false, model: 'gpt-6-sol', provider: GATEWAY },
  presetFor: () => ({}),
  select: vi.fn(),
  setOptions: vi.fn()
})

function renderMenu() {
  render(
    <QueryClientProvider client={queryClient}>
      <ModelMenuCloseContext.Provider value={vi.fn()}>
        <DropdownMenu open>
          <DropdownMenuContent>
            <ModelCatalogMenu controller={controller()} />
          </DropdownMenuContent>
        </DropdownMenu>
      </ModelMenuCloseContext.Provider>
    </QueryClientProvider>
  )
}

const qwenRow = () => screen.getByRole('menuitem', { name: /Qwen 3\.8 27B \(local\)/ }).textContent?.trim()

/** The app's own pick, with the dialog mounted, as wiring.tsx has them. */
function mountApp() {
  render(<AthenaLocalModelsDialog />)

  const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    requests.push([method, params ?? {}])

    return {} as never
  })

  const { result } = renderHook(() =>
    useModelControls({ queryClient: new QueryClient(), requestGateway: requestGateway as never })
  )

  setLocalModelSelector(selection => result.current.selectModel(selection as never))

  return {
    pick: (model = QWEN_NAME, provider = 'athena-vllm') =>
      act(async () => result.current.selectModel({ model, provider, sessionId: 'rt-1' }))
  }
}

beforeEach(() => {
  requests = []
  vi.mocked(requestModelOptions).mockResolvedValue(CATALOG)
  queryClient.clear()
  window.localStorage.clear()
  $visibleModels.set(null)
  $favoriteModels.set([])
  $customModels.set([])
  setPendingPickDelay(0)
  $activeSessionId.set('rt-1')
  $currentModel.set('gpt-6-sol')
  $currentProvider.set(GATEWAY)
})

afterEach(() => {
  cleanup()
  uninstall?.()
  setLocalModelSelector(null)
  setPendingPickDelay(1500)
  resetModelSwitches()
  $clientConfig.set(null)
  $sessionStates.set({})
  $activeSessionId.set(null)
  clearNotifications()
  vi.clearAllMocks()
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

describe('the words', () => {
  test('the connection: connected, connecting, or not connected with the reason', () => {
    const line = (value: HpcBridgeStatus | null) => statusLine(bridgeStatus(value))

    expect(line(connected())).toBe('Connected')
    expect(line(status({ state: 'connecting' }))).toBe('Connecting…')
    expect(line(down('unreachable'))).toBe('Not connected: login node unreachable')
    expect(line(down('timeout'))).toBe('Not connected: login node unreachable')
    expect(line(down('connection_lost'))).toBe('Not connected: login node unreachable')
    expect(line(down('auth_failed'))).toBe('Not connected: password refused')
    expect(line(down('host_key_mismatch'))).toBe('Not connected: host key mismatch')
    expect(line(down('auth_unsupported'))).toBe('Not connected: the HPC asked for more than a password')
    expect(line(status({ state: 'host_key_unknown' }))).toBe('Not connected: not available in this version of Athena')
    // Nothing to add: the user has not signed in yet, or disconnected.
    expect(line(status())).toBe('Not connected')
    expect(line(status({ reason: 'disconnected', state: 'off' }))).toBe('Not connected')
    expect(line(down('something_new'))).toBe('Not connected')
    expect(line(null)).toBe('Not connected')
  })

  test('one model: its own model server narrows the connection`s status', () => {
    const model = { server: 'default' }

    const line = (value: HpcBridgeStatus | null, callable = false) =>
      statusLine(localModelStatus(model, value, callable))

    expect(line(connected(), true)).toBe('Connected')
    expect(line(serverDown())).toBe('Not connected: model server not answering')
    expect(line(connected({ servers: { default: { state: 'checking' } } }))).toBe('Connecting…')
    expect(line(connected({ servers: { other: { port: 1, state: 'up' } } }))).toBe('Not connected')
    expect(line(down('auth_failed'))).toBe('Not connected: password refused')
    // A model on another server is not touched by this one.
    expect(
      statusLine(
        localModelStatus(
          { server: 'hpc-llm' },
          connected({ servers: { default: { state: 'down' }, 'hpc-llm': { port: 2, state: 'up' } } }),
          true
        )
      )
    ).toBe('Connected')
    // Main has not answered (or an older main): the role's list decides.
    expect(line(null, true)).toBe('Connected')
    expect(line(null, false)).toBe('Not connected')
  })

  test('beside a picker row: the reason alone when there is one', () => {
    expect(statusTag(localModelStatus({}, connected(), true))).toBe('Connected')
    expect(statusTag(localModelStatus({}, status({ state: 'connecting' }), false))).toBe('Connecting…')
    expect(statusTag(localModelStatus({}, status(), false))).toBe('Not connected')
    expect(statusTag(localModelStatus({}, down('unreachable'), false))).toBe('Login node unreachable')
    expect(statusTag(localModelStatus({}, down('auth_failed'), false))).toBe('Password refused')
    expect(statusTag(localModelStatus({}, serverDown(), false))).toBe('Model server not answering')
    expect(statusTag(localModelStatus({}, down('host_key_mismatch'), false))).toBe('Host key mismatch')
  })
})

describe('next to each local model in the pickers', () => {
  test('the composer menu row follows the bridge as it goes down and comes back', async () => {
    await start(connected(), snapshot({ bridge: true }))
    renderMenu()
    await waitFor(() => expect(qwenRow()).toBe('Qwen 3.8 27B (local)On the HPC · Connected'))

    // The bridge goes down: main pushes the status and the snapshot without the record. No reload, no reopen.
    push(down('connection_lost'))
    await waitFor(() => expect(qwenRow()).toBe('Qwen 3.8 27B (local)Login node unreachable'))
    // The other models are as they were.
    expect(screen.getByRole('menuitem', { name: /GPT-6 Sol/ }).textContent).toMatch(/^GPT-6 SolMost capable/)

    push(status({ credential: 'password', state: 'connecting' }))
    await waitFor(() => expect(qwenRow()).toBe('Qwen 3.8 27B (local)Connecting…'))

    push(connected(), true)
    await waitFor(() => expect(qwenRow()).toBe('Qwen 3.8 27B (local)On the HPC · Connected'))

    push(down('auth_failed', { credential: 'none' }))
    await waitFor(() => expect(qwenRow()).toBe('Qwen 3.8 27B (local)Password refused'))

    push(serverDown())
    await waitFor(() => expect(qwenRow()).toBe('Qwen 3.8 27B (local)Model server not answering'))

    push(down('host_key_mismatch'))
    await waitFor(() => expect(qwenRow()).toBe('Qwen 3.8 27B (local)Host key mismatch'))

    push(status({ reason: 'disconnected', state: 'off' }))
    await waitFor(() => expect(qwenRow()).toBe('Qwen 3.8 27B (local)Not connected'))
  })

  test('the picker dialog row says it too', async () => {
    await start(down('auth_failed', { credential: 'none' }))
    render(
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
    const options = () => screen.getAllByRole('option').map(item => item.textContent?.trim())

    expect(options()).toEqual([
      expect.stringMatching(/^GPT-6 Sol/),
      'GPT-6 Luna',
      'Qwen 3.8 27B (local)Password refused'
    ])

    push(connected(), true)
    await waitFor(() => expect(options()[2]).toBe('Qwen 3.8 27B (local)Connected'))
  })

  test('with local models off there is no local model and no status anywhere', async () => {
    await start(connected(), snapshot({ bridge: true, feature: 'off' }))
    renderMenu()
    await waitFor(() => expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(2))

    expect(document.body.textContent).not.toMatch(/Qwen|Connected|Not connected|Local models/)
    expect(bridge.status).not.toHaveBeenCalled()
    cleanup()

    render(<AthenaLocalModelsSettings />)
    expect(document.body.textContent).toBe('')
  })
})

describe('the model server down', () => {
  test('the status says so, the other models work, and a pick of the local model says why', async () => {
    await start(serverDown())
    const app = mountApp()
    renderMenu()
    await waitFor(() => expect(qwenRow()).toBe('Qwen 3.8 27B (local)Model server not answering'))

    // Another model is picked as always.
    expect(await app.pick('gpt-6-luna', GATEWAY)).toBe(true)
    expect(requests).toEqual([
      ['config.set', { key: 'model', session_id: 'rt-1', value: `gpt-6-luna --provider ${GATEWAY}` }]
    ])
    expect($currentModel.get()).toBe('gpt-6-luna')

    // The local model: not picked, no dialog (there is nothing to sign in to), and a plain reason.
    requests.length = 0
    expect(await app.pick()).toBe(false)
    expect(screen.queryByTestId('athena-local-models-dialog')).toBeNull()
    expect(toasts()).toEqual([
      'Qwen 3.8 27B (local) is not connected: model server not answering. Athena keeps trying.'
    ])
    expect(modelServerDownMessage()).toBe(
      'This local model is not connected: model server not answering. Athena keeps trying.'
    )
    expect(bridge.connect).not.toHaveBeenCalled()
    expect(requests).toEqual([])

    // The server answers again: main says so, and the pick that waited is made.
    push(connected(), true)
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0][1].value).toBe(`${QWEN_NAME} --provider athena-vllm`)
  })
})

describe('the password refused', () => {
  test('the status says so and a pick offers the dialog again, with the user name filled in', async () => {
    await start(connected(), snapshot({ bridge: true }))
    const app = mountApp()
    renderMenu()
    await waitFor(() => expect(qwenRow()).toContain('Connected'))

    // The password changed on the HPC: the reconnect was refused and main forgot the password.
    push(down('auth_failed', { credential: 'none' }))
    await waitFor(() => expect(qwenRow()).toBe('Qwen 3.8 27B (local)Password refused'))

    expect(await app.pick()).toBe(false)
    await screen.findByTestId('athena-local-models-dialog')
    expect(document.querySelector<HTMLInputElement>('input[name="athena-hpc-username"]')!.value).toBe(USER)
    expect(document.querySelector<HTMLInputElement>('input[name="athena-hpc-password"]')!.value).toBe('')
    expect(bridge.connect).not.toHaveBeenCalled()
  })
})

describe('Settings › Model: Local models', () => {
  const line = () => screen.getByTestId('athena-local-models-connection').textContent
  const modelLine = () => screen.getByTestId(`athena-local-model-${QWEN.id}`).textContent

  test('connected: who is signed in, each model, and Disconnect', async () => {
    await start(connected(), snapshot({ bridge: true }))
    render(<AthenaLocalModelsSettings />)

    const section = screen.getByTestId('athena-local-models-settings')

    expect(section.textContent).toContain('Local models')
    expect(section.textContent).toContain(
      'Local models run on the HPC. Athena connects to them from this computer while it is open. Disconnecting also forgets your password; Athena never saves it.'
    )
    expect(line()).toBe(`Connected as ${USER}`)
    expect(section.textContent).toContain('Qwen 3.8 27B (local)')
    expect(modelLine()).toBe('Connected')
    expect(screen.getByTestId('athena-local-models-username').textContent).toBe(USER)
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Forget' })).toBeTruthy()
  })

  test('Disconnect closes the bridge; the model stays listed as not connected, and the next pick shows the dialog', async () => {
    await start(connected(), snapshot({ bridge: true }))
    const app = mountApp()
    render(<AthenaLocalModelsSettings />)

    const off = status({ reason: 'disconnected', state: 'off', username: USER })
    bridge.disconnect.mockImplementationOnce(async () => {
      // As main does: the forward closes (the record goes), then the status.
      push(off)

      return off
    })
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(line()).toBe('Not connected'))

    expect(bridge.disconnect).toHaveBeenCalledTimes(1)
    expect(modelLine()).toBe('Not connected')
    // Still in the pickers, and no longer callable.
    expect(rows()).toEqual([
      [GATEWAY, ['gpt-6-sol', 'gpt-6-luna']],
      ['athena-vllm', [QWEN_NAME]]
    ])
    expect($managedModels.get()?.entries.map(entry => entry.id)).toEqual(['gpt-6-sol', 'gpt-6-luna'])
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()

    // Main holds no password now: a pick asks for it again, and does not connect by itself.
    expect(await app.pick()).toBe(false)
    await screen.findByTestId('athena-local-models-dialog')
    expect(bridge.connect).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  test('Connect in Settings opens the dialog when nothing is held, and reconnects when something is', async () => {
    await start(status({ username: USER }))
    render(
      <>
        <AthenaLocalModelsDialog />
        <AthenaLocalModelsSettings />
      </>
    )

    expect(line()).toBe('Not connected')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByTestId('athena-local-models-dialog')
    expect(bridge.connect).not.toHaveBeenCalled()
    // No pick is waiting: the button only connects.
    expect(pendingLocalModelPick()).toBeNull()
    cleanup()

    await act(async () => bridge.push(status({ credential: 'key', reason: 'disconnected', state: 'off' })))
    render(<AthenaLocalModelsSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await flush()
    expect(bridge.connect.mock.calls).toEqual([[]])
  })

  test('each reason is spelled out, and a held password can be dropped while the bridge is down', async () => {
    await start(down('unreachable'))
    render(<AthenaLocalModelsSettings />)

    expect(line()).toBe('Not connected: login node unreachable')
    expect(modelLine()).toBe('Not connected: login node unreachable')
    // Main keeps trying with the password it holds: Disconnect stops that and forgets it.
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
    expect(canDisconnect(down('unreachable'))).toBe(true)

    await act(async () => bridge.push(down('auth_failed', { credential: 'none' })))
    expect(line()).toBe('Not connected: password refused')
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()

    await act(async () => bridge.push(serverDown()))
    expect(line()).toBe(`Connected as ${USER}`)
    expect(modelLine()).toBe('Not connected: model server not answering')

    await act(async () => bridge.push(down('host_key_mismatch')))
    expect(line()).toBe('Not connected: host key mismatch')

    await act(async () => bridge.push(status({ state: 'host_key_unknown' })))
    expect(line()).toBe('Not connected: not available in this version of Athena')
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', true)

    await act(async () => bridge.push(status({ credential: 'password', state: 'connecting' })))
    expect(line()).toBe('Connecting…')
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()

    for (const value of [
      null,
      status(),
      status({ reason: 'disconnected', state: 'off' }),
      status({ state: 'host_key_unknown' }),
      down('auth_failed', { credential: 'none' })
    ]) {
      expect(canDisconnect(value)).toBe(false)
    }
  })

  test('Forget removes the remembered user name', async () => {
    await start(status({ username: USER }))
    render(<AthenaLocalModelsSettings />)

    expect(screen.getByTestId('athena-local-models-username').textContent).toBe(USER)
    expect(screen.getByTestId('athena-local-models-settings').textContent).toContain(
      'Filled in for you the next time you connect. Forgetting it also disconnects.'
    )

    bridge.forgetUser.mockImplementationOnce(async () => status())
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }))

    await waitFor(() => expect(screen.queryByTestId('athena-local-models-username')).toBeNull())
    expect(bridge.forgetUser).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Forget' })).toBeNull()
    expect($hpcBridge.get()?.username).toBeUndefined()
  })

  test('the section is on the Settings › Model page, after the main model', async () => {
    await start(connected(), snapshot({ bridge: true }))
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ModelSettings />
        </QueryClientProvider>
      </MemoryRouter>
    )

    expect((await screen.findByTestId('athena-local-models-connection')).textContent).toBe(`Connected as ${USER}`)
  })
})

describe('a session on a local model while the bridge is not up', () => {
  const state = (model: string, provider: string) =>
    ({ busy: false, model, provider, reasoningEffort: '' }) as unknown as ClientSessionState

  const NOT_CONNECTED = 'Qwen 3.8 27B (local) is not connected. Switched to GPT-6 Sol.'
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  beforeEach(() => {
    $activeSessionId.set('rt-1')
    $currentModel.set('gpt-6-sol')
    $currentProvider.set(GATEWAY)
    $sessionStates.set({ 'rt-2': state(QWEN_NAME, BRIDGE_PROVIDER) })
  })

  test('a new launch, before the user has signed in: it moves to the default with a note and a way back', async () => {
    // Main holds no password after a launch, so the bridge cannot come up by itself: no point in waiting.
    await start(status({ username: USER }))
    const app = mountApp()
    const select = vi.fn<SelectModel>(async () => true)

    expect(localModelGrace({ server: 'default' })).toBe(0)
    reconcileModelSessions(select)
    await flush()

    expect(select.mock.calls.map(([selection]) => selection)).toEqual([
      { model: 'gpt-6-sol', provider: GATEWAY, sessionId: 'rt-2' }
    ])
    expect(toasts()).toEqual([NOT_CONNECTED])

    const note = $notifications.get().find(entry => entry.message === NOT_CONNECTED)!

    expect(note.action?.label).toBe('Connect')

    // Connect: the dialog (nothing is held); once the bridge is up the session goes back to the local model.
    act(() => note.action!.onClick())
    await screen.findByTestId('athena-local-models-dialog')
    expect(pendingLocalModelPick()).toEqual({ model: QWEN_NAME, provider: BRIDGE_PROVIDER, sessionId: 'rt-2' })

    fireEvent.change(document.querySelector('input[name="athena-hpc-password"]')!, { target: { value: 'a password' } })
    bridge.connect.mockImplementationOnce(async () => connected())
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Connect' })))
    push(connected(), true)

    await waitFor(() =>
      expect(requests).toEqual([
        [
          'config.set',
          { key: 'model', session_id: 'rt-2', value: `${QWEN_NAME} --provider ${BRIDGE_PROVIDER} --session` }
        ]
      ])
    )
    void app
  })

  test('the bridge is on its way: the session waits, and stays when the bridge is back', async () => {
    await start(connected(), snapshot({ bridge: true }))
    const select = vi.fn<SelectModel>(async () => true)
    reconcileModelSessions(select)

    for (const next of [
      down('connection_lost'),
      status({ credential: 'password', state: 'connecting' }),
      status({ credential: 'key', state: 'connecting' }),
      connected({ servers: { default: { state: 'checking' } } }),
      // Main already says the server is up; the list follows with the next snapshot.
      connected()
    ]) {
      push(next)
      expect(localModelGrace({ server: 'default' })).toBeGreaterThan(LOCAL_MODEL_GRACE_MS - 5000)
      reconcileModelSessions(select)
      await flush()
    }

    push(connected(), true)
    reconcileModelSessions(select)
    await flush()

    expect(select).not.toHaveBeenCalled()
    expect(toasts()).toEqual([])
  })

  test('a bridge that is not back within 30 seconds: the session moves, with the note', async () => {
    await start(connected(), snapshot({ bridge: true }))
    const select = vi.fn<SelectModel>(async () => true)
    reconcileModelSessions(select)

    // 60 ms of the 30 s are left.
    push(down('unreachable', { since: ago(LOCAL_MODEL_GRACE_MS - 60) }))
    reconcileModelSessions(select)
    await flush()
    expect(select).not.toHaveBeenCalled()

    // Nobody calls again: the pass runs by itself when the wait is over.
    await waitFor(() => expect(select).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await flush()
    expect(select.mock.calls[0][0]).toEqual({ model: 'gpt-6-sol', provider: GATEWAY, sessionId: 'rt-2' })
    expect(toasts()).toEqual([NOT_CONNECTED])
  })

  test.each([
    ['the password was refused', () => down('auth_failed', { credential: 'none' })],
    ['the user disconnected', () => status({ reason: 'disconnected', state: 'off' })],
    ['the host key does not match', () => down('host_key_mismatch')],
    ['the model server is not answering', () => serverDown()],
    ['this build cannot check the login node', () => status({ state: 'host_key_unknown' })]
  ])('%s: nothing is on its way, so the session moves at once', async (_name, next) => {
    await start(connected(), snapshot({ bridge: true }))
    const select = vi.fn<SelectModel>(async () => true)
    reconcileModelSessions(select)

    push(next())
    expect(localModelGrace({ server: 'default' })).toBe(0)
    reconcileModelSessions(select)
    await flush()

    expect(select).toHaveBeenCalledTimes(1)
    expect(toasts()).toEqual([NOT_CONNECTED])
  })

  test('before main has said anything the session waits; a local model is never what a session moves to', async () => {
    bridge = fakeBridge(status())
    // Main answers late.
    bridge.status.mockImplementation(() => new Promise(() => {}))
    ;(window as { athenaDesktop?: unknown }).athenaDesktop = { hpcBridge: bridge, policy: { record: vi.fn() } }
    uninstall = installModelPolicy()
    setClientConfigSnapshot(snapshot())
    await flush()
    const select = vi.fn<SelectModel>(async () => true)

    expect($hpcBridge.get()).toBeNull()
    expect(localModelGrace({ server: 'default' })).toBeGreaterThan(LOCAL_MODEL_GRACE_MS - 5000)
    reconcileModelSessions(select)
    await flush()
    expect(select).not.toHaveBeenCalled()

    // The target of a move is the role default, also when the local model is listed (connected or not).
    for (const up of [true, false]) {
      setClientConfigSnapshot(snapshot({ bridge: up }))
      expect(switchTarget($managedModels.get()!)).toBe('gpt-6-sol')
      expect($managedModels.get()!.default).toBe('gpt-6-sol')
    }
  })
})
