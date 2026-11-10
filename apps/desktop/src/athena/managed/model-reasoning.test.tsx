// F02 slice 23: reasoning effort per model. With Sol at none/low/medium/high and Luna at none/low/medium, the composer
// reasoning pill (its options content, shared with each model row's submenu), Settings › Model's reasoning select and
// /reasoning offer exactly those levels; switching from Sol at high to Luna resets to Luna's default; a model with
// only `none` reads "Not available for this model yet"; `models.reasoning_control: off` turns the control off.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as ConfigApi from '@/api/config'
import { ReasoningPill } from '@/app/chat/composer/reasoning-pill'
import type { ChatBarState } from '@/app/chat/composer/types'
import {
  actRender,
  Harness,
  type HarnessHandle,
  RUNTIME_SESSION_ID
} from '@/app/session/hooks/use-prompt-actions/index-test-utils'
import { clearSingleFlightSessionResumeState } from '@/app/session/hooks/use-prompt-actions/single-flight-resume'
import { ModelSettings } from '@/app/settings/model-settings'
import { ModelOptionsContent } from '@/app/shell/model-edit-submenu'
import type { ClientSessionState } from '@/app/types'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { getGlobalModelInfo } from '@/hermes'
import { clearNotifications } from '@/store/notifications'
import { $activeSessionId, $connection, $currentModel, $currentReasoningEffort } from '@/store/session'
import { $sessionStates, dropSessionState } from '@/store/session-states'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { $clientConfig, setClientConfigSnapshot } from './client-config'
import { LUNA, managedSnapshot, MOCK, SOL } from './managed-models-fixture'
import { installModelPolicy } from './model-policy'
import {
  managedReasoning,
  REASONING_CONTROL_OFF,
  REASONING_UNAVAILABLE,
  reasoningSlashRefusal
} from './model-reasoning'
import { reconcileReasoningLevels, resetReasoningResets } from './model-reasoning-reset'

const CATALOG = {
  model: 'gpt-6-sol',
  provider: 'custom:athena-gateway',
  providers: [
    { authenticated: true, models: ['gpt-6-sol', 'gpt-6-luna'], name: 'Athena gateway', slug: 'custom:athena-gateway' }
  ]
}

vi.mock('@/hermes', async () => ({
  ...(await vi.importActual<typeof ConfigApi>('@/api/config')),
  getApiRequestProfile: () => 'default',
  getAuxiliaryModels: vi.fn(async () => ({ main: { model: 'gpt-6-sol', provider: 'custom:athena-gateway' }, tasks: [] })),
  getGlobalModelInfo: vi.fn(async () => ({ model: 'gpt-6-sol', provider: 'custom:athena-gateway' })),
  getGlobalModelOptions: vi.fn(async () => CATALOG),
  getHermesConfig: vi.fn(async () => ({ display: { timestamps: false } })),
  getHermesConfigDefaults: vi.fn(async () => ({})),
  getHermesConfigRecord: vi.fn(async () => ({ agent: { reasoning_effort: 'medium' } })),
  getLatestSessionMessages: vi.fn(async () => ({ messages: [], session_id: 'session' })),
  getMoaModels: vi.fn(async () => null),
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  getRecommendedDefaultModel: vi.fn(async () => null),
  getSession: vi.fn(),
  profileScopeKey: (scope?: null | string) => (scope ?? '').trim() || 'default',
  PROMPT_SUBMIT_REQUEST_TIMEOUT_MS: 1_800_000,
  saveHermesConfig: vi.fn(async () => ({ ok: true })),
  setApiRequestProfile: () => {},
  transcribeAudio: vi.fn()
}))
vi.mock('@/app/hooks/use-on-profile-switch', () => ({ useOnProfileSwitch: () => {} }))
vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn()
}))

stubResizeObserver()
stubMenuDomApis()

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

let uninstall: () => void

beforeEach(() => {
  uninstall = installModelPolicy()
  setClientConfigSnapshot(managedSnapshot([SOL, LUNA, { ...MOCK, hidden: false }]))
})

afterEach(() => {
  cleanup()
  uninstall()
  resetReasoningResets()
  $clientConfig.set(null)
  $sessionStates.set({})
  $activeSessionId.set(null)
  $currentModel.set('')
  $currentReasoningEffort.set('')
  clearNotifications()
})

/** The options the pill (and each row's submenu) shows for a model: the Thinking toggle and the effort radio. */
function renderOptions(model: string) {
  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <ModelOptionsContent
          defaultEffort="medium"
          effort="medium"
          fastControl={{ kind: 'none' }}
          isActive
          model={model}
          onSelectModel={vi.fn()}
          onSetOptions={vi.fn()}
          provider="custom:athena-gateway"
          reasoning
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return {
    efforts: screen.queryAllByRole('menuitemradio').map(item => item.textContent?.trim()),
    thinking: screen.queryByText('Thinking') !== null
  }
}

const pillModel = (model: string): ChatBarState['model'] => ({
  canSwitch: true,
  model,
  provider: 'custom:athena-gateway',
  reasoningMenuContent: <div>menu</div>
})

describe('the composer reasoning pill', () => {
  test("offers exactly each model's levels: Sol none..high, Luna none..medium", () => {
    expect(renderOptions('gpt-6-sol')).toEqual({ efforts: ['Low', 'Medium', 'High'], thinking: true })
    cleanup()
    expect(renderOptions('gpt-6-luna')).toEqual({ efforts: ['Low', 'Medium'], thinking: true })
  })

  test('a model with only `none` reads "Not available for this model yet"', () => {
    expect(renderOptions('mock')).toEqual({ efforts: [], thinking: false })
    expect(screen.getByText(REASONING_UNAVAILABLE)).toBeTruthy()
    cleanup()
    render(<ReasoningPill disabled={false} model={pillModel('mock')} />)
    expect(screen.getByTestId('reasoning-pill').textContent).toBe('Off')
  })

  test('models.reasoning_control: off hides the pill and the options', () => {
    render(<ReasoningPill disabled={false} model={pillModel('gpt-6-sol')} />)
    expect(screen.getByTestId('reasoning-pill')).toBeTruthy()

    act(() => setClientConfigSnapshot(managedSnapshot([SOL, LUNA], { reasoningControl: 'off' })))
    expect(screen.queryByTestId('reasoning-pill')).toBeNull()
    cleanup()
    expect(renderOptions('gpt-6-sol')).toEqual({ efforts: [], thinking: false })
  })

  test('without the managed list (report) the stock levels stand', () => {
    setClientConfigSnapshot(managedSnapshot([SOL, LUNA], { mode: 'report' }))
    expect(managedReasoning('gpt-6-luna')).toBeNull()
    expect(renderOptions('gpt-6-luna').efforts).toEqual(['Minimal', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultra'])
  })
})

describe('Settings › Model › Reasoning', () => {
  async function settingsOptions(): Promise<null | string[]> {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ModelSettings />
        </QueryClientProvider>
      </MemoryRouter>
    )
    await screen.findByRole('combobox', { name: 'Model' })
    const select = screen.queryByRole('combobox', { name: 'Reasoning' })

    if (!select) {
      return null
    }

    fireEvent.click(select)

    return (await screen.findAllByRole('option')).map(option => option.textContent?.trim() ?? '')
  }

  test("offers the main model's levels (Sol, then Luna)", async () => {
    expect(await settingsOptions()).toEqual(['Off', 'Low', 'Medium', 'High'])
    cleanup()
    vi.mocked(getGlobalModelInfo).mockResolvedValueOnce({ model: 'gpt-6-luna', provider: 'custom:athena-gateway' })
    expect(await settingsOptions()).toEqual(['Off', 'Low', 'Medium'])
  })

  test('reasoning_control off hides the row; a none-only model says it is not available', async () => {
    setClientConfigSnapshot(managedSnapshot([SOL, LUNA], { reasoningControl: 'off' }))
    expect(await settingsOptions()).toBeNull()
    cleanup()
    setClientConfigSnapshot(managedSnapshot([{ ...SOL, reasoning: { default: 'none', levels: ['none'] } }, LUNA]))
    expect(await settingsOptions()).toBeNull()
    expect(within(document.body).getByText(REASONING_UNAVAILABLE)).toBeTruthy()
  })
})

describe('/reasoning', () => {
  const requestGateway = () =>
    vi.fn(async (method: string, _params?: Record<string, unknown>) =>
      (method === 'config.set' ? { value: 'medium' } : { display: 'hide', value: 'low' }) as never
    )

  async function mount(gateway: ReturnType<typeof requestGateway>): Promise<HarnessHandle> {
    let handle: HarnessHandle | null = null
    await actRender(
      <Harness onReady={h => (handle = h)} refreshSessions={async () => undefined} requestGateway={gateway} />
    )

    return handle!
  }

  const text = (handle: HarnessHandle) =>
    handle
      .state()
      .messages.flatMap(message => message.parts.map(part => ('text' in part ? String(part.text) : '')))
      .join('\n')

  const sets = (gateway: ReturnType<typeof requestGateway>) =>
    gateway.mock.calls.filter(([method]) => method === 'config.set').map(([, params]) => params?.value)

  beforeEach(() => {
    clearSingleFlightSessionResumeState()
    $connection.set({ mode: 'local', wsUrl: 'ws://localhost/api/ws?native_dial=unminted' } as never)
  })

  afterEach(() => {
    $connection.set(null)
    dropSessionState(RUNTIME_SESSION_ID)
  })

  test("`/reasoning high` on Luna answers that the level isn't available; a listed level runs", async () => {
    $currentModel.set('gpt-6-luna')
    const gateway = requestGateway()
    const handle = await mount(gateway)

    await handle.submitText('/reasoning high')
    expect(sets(gateway)).toEqual([])
    expect(text(handle)).toContain("high isn't available for GPT-6 Luna. Choose none, low, medium.")

    await handle.submitText('/reasoning medium')
    expect(sets(gateway)).toEqual(['medium'])
  })

  test('reasoning_control off: /reasoning says it is not available; display words still run', async () => {
    setClientConfigSnapshot(managedSnapshot([SOL, LUNA], { reasoningControl: 'off' }))
    $currentModel.set('gpt-6-sol')
    const gateway = requestGateway()
    const handle = await mount(gateway)

    await handle.submitText('/reasoning high')
    await handle.submitText('/reasoning')
    expect(text(handle).split(REASONING_CONTROL_OFF)).toHaveLength(3)
    expect(gateway.mock.calls.filter(([method]) => method.startsWith('config.'))).toEqual([])
    expect(reasoningSlashRefusal('show', 'gpt-6-sol')).toBeNull()
  })
})

describe('switching model resets an unsupported level', () => {
  const tile = (model: string, reasoningEffort: string) =>
    ({ busy: false, model, provider: 'custom:athena-gateway', reasoningEffort }) as unknown as ClientSessionState

  test("from Sol at high to Luna: the level becomes Luna's default (low), on the session", async () => {
    const request = vi.fn(async () => ({}) as never)
    $activeSessionId.set('rt-1')
    $currentModel.set('gpt-6-sol')
    $currentReasoningEffort.set('high')
    $sessionStates.set({ 'rt-1': tile('gpt-6-sol', 'high') })

    reconcileReasoningLevels(request)
    expect(request).not.toHaveBeenCalled() // Sol takes high

    $currentModel.set('gpt-6-luna')
    $sessionStates.set({ 'rt-1': tile('gpt-6-luna', 'high') })
    reconcileReasoningLevels(request)
    await act(async () => await Promise.resolve())

    expect(request).toHaveBeenCalledWith('config.set', { key: 'reasoning', session_id: 'rt-1', value: 'low' })
    expect($currentReasoningEffort.get()).toBe('low')

    // Once per (session, model, level): no second write.
    reconcileReasoningLevels(request)
    expect(request).toHaveBeenCalledTimes(1)
  })

  test('a tile keeps a level its model offers and resets one it does not', async () => {
    const request = vi.fn(async () => ({}) as never)
    $currentModel.set('gpt-6-luna')
    $currentReasoningEffort.set('medium')
    $sessionStates.set({ 'rt-2': tile('gpt-6-luna', 'high'), 'rt-3': tile('gpt-6-sol', 'high') })

    reconcileReasoningLevels(request)
    await act(async () => await Promise.resolve())

    expect(request.mock.calls).toEqual([['config.set', { key: 'reasoning', session_id: 'rt-2', value: 'low' }]])
  })
})
