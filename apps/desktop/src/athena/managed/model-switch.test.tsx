// F02 slice 21: when a new config drops the model an open session uses, the session switches to the role default
// between turns, through the app's own pick (recorded here: the config.set the canonical protocol sends as slice 08's
// fenced session.mutate), with one toast per session. With no model left, or a failed switch, the composer says
// "No model available. Contact your administrator" and cancels sends.
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { CanonicalDesktopProtocol } from '@/api/canonical-protocol'
import { runComposerMiddleware } from '@/app/chat/composer/contrib'
import { useModelControls } from '@/app/session/hooks/use-model-controls'
import type { ClientSessionState } from '@/app/types'
import { Slot } from '@/contrib/react/slot'
import type * as NotificationsModule from '@/store/notifications'
import { clearNotifications, notify } from '@/store/notifications'
import { $activeSessionId, $currentModel, $currentProvider } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { $clientConfig, setClientConfigSnapshot } from './client-config'
import { LUNA, managedSnapshot, MOCK, SOL } from './managed-models-fixture'
import { installModelPolicy } from './model-policy'
import {
  $noModelAvailable,
  installNoModelGate,
  NO_MODEL_MESSAGE,
  reconcileModelSessions,
  resetModelSwitches,
  type SelectModel,
  useManagedModelSwitch
} from './model-switch'

vi.mock('@/store/notifications', async importOriginal => {
  const actual = await importOriginal<typeof NotificationsModule>()

  return { ...actual, notify: vi.fn(actual.notify) }
})

const state = (model: string, busy = false) =>
  ({ busy, model, provider: 'custom:athena-gateway', reasoningEffort: '' }) as unknown as ClientSessionState

const flush = () => act(async () => await new Promise(resolve => setTimeout(resolve, 0)))

const toasts = () => vi.mocked(notify).mock.calls.map(([input]) => input.message)

const REMOVED = 'GPT-6 Sol is no longer available. Switched to GPT-6 Luna.'

let uninstall: () => void

beforeEach(() => {
  uninstall = installModelPolicy()
  setClientConfigSnapshot(managedSnapshot([SOL, LUNA, MOCK], { default: 'gpt-6-sol' }))
  $activeSessionId.set('rt-1')
  $currentModel.set('gpt-6-sol')
  $currentProvider.set('custom:athena-gateway')
  $sessionStates.set({ 'rt-1': state('gpt-6-sol'), 'rt-2': state('gpt-6-sol'), 'rt-3': state('gpt-6-luna') })
})

afterEach(() => {
  cleanup()
  uninstall()
  resetModelSwitches()
  $clientConfig.set(null)
  $sessionStates.set({})
  $activeSessionId.set(null)
  clearNotifications()
  vi.mocked(notify).mockClear()
})

describe('switching open sessions off a removed model', () => {
  test('each session on the removed model moves to the default once, with one toast per session', async () => {
    const select = vi.fn<SelectModel>(async () => true)

    reconcileModelSessions(select)
    expect(select).not.toHaveBeenCalled() // everything is still allowed

    // The admin removes Sol; the next poll brings the new config.
    setClientConfigSnapshot(managedSnapshot([LUNA, MOCK], { configVersion: 6, default: 'gpt-6-luna' }))
    reconcileModelSessions(select)
    await flush()

    expect(select.mock.calls.map(([selection]) => selection)).toEqual([
      { model: 'gpt-6-luna', provider: 'custom:athena-gateway' }, // the primary composer (rt-1)
      { model: 'gpt-6-luna', provider: 'custom:athena-gateway', sessionId: 'rt-2' }
    ])
    expect(toasts()).toEqual([REMOVED, REMOVED])

    // The same config again, a later version, other store churn: no second switch, no second toast.
    reconcileModelSessions(select)
    setClientConfigSnapshot(managedSnapshot([LUNA, MOCK], { configVersion: 7, default: 'gpt-6-luna' }))
    reconcileModelSessions(select)
    await flush()
    expect(select).toHaveBeenCalledTimes(2)
    expect(toasts()).toEqual([REMOVED, REMOVED])
  })

  test('the controller hook follows the config and the sessions, and installs the composer gate', async () => {
    const select = vi.fn<SelectModel>(async () => true)
    const { unmount } = renderHook(() => useManagedModelSwitch(select))

    act(() => setClientConfigSnapshot(managedSnapshot([LUNA, MOCK], { configVersion: 6 })))
    await flush()
    expect(select).toHaveBeenCalledTimes(2)

    act(() => $sessionStates.set({ ...$sessionStates.get(), 'rt-5': state('gpt-6-sol') }))
    await flush()
    expect(select.mock.calls.at(-1)?.[0]).toMatchObject({ model: 'gpt-6-luna', sessionId: 'rt-5' })

    act(() => setClientConfigSnapshot(managedSnapshot([MOCK], { configVersion: 7 })))
    expect(await runComposerMiddleware({ text: 'Hello' })).toBeNull()
    unmount()
    expect(await runComposerMiddleware({ text: 'Hello' })).toEqual({ text: 'Hello' })
  })

  test('a session mid-turn keeps its turn and switches when the turn ends', async () => {
    const select = vi.fn<SelectModel>(async () => true)
    $sessionStates.set({ ...$sessionStates.get(), 'rt-2': state('gpt-6-sol', true) })
    setClientConfigSnapshot(managedSnapshot([LUNA], { configVersion: 6 }))

    reconcileModelSessions(select)
    await flush()
    expect(select.mock.calls.map(([selection]) => selection.sessionId)).toEqual([undefined])

    $sessionStates.set({ ...$sessionStates.get(), 'rt-2': state('gpt-6-sol', false) })
    reconcileModelSessions(select)
    await flush()
    expect(select.mock.calls.map(([selection]) => selection.sessionId)).toEqual([undefined, 'rt-2'])
  })

  test('the pick on the wire is the slice 08 call shape: session.mutate model with the gateway provider', async () => {
    const requests: [string, Record<string, unknown>][] = []

    const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      requests.push([method, params ?? {}])

      return {} as never
    })

    const { result } = renderHook(() =>
      useModelControls({ queryClient: new QueryClient(), requestGateway: requestGateway as never })
    )

    setClientConfigSnapshot(managedSnapshot([LUNA], { configVersion: 6 }))
    $activeSessionId.set('rt-9') // the primary is a different session: rt-2 is a tile
    $sessionStates.set({ 'rt-2': state('gpt-6-sol') })
    $currentModel.set('gpt-6-luna')
    reconcileModelSessions(selection => result.current.selectModel(selection))
    await flush()

    expect(requests).toEqual([
      ['config.set', { key: 'model', session_id: 'rt-2', value: 'gpt-6-luna --provider custom:athena-gateway --session' }]
    ])

    // What the canonical protocol makes of it: the fenced model mutation, with the provider always sent.
    const protocol = new CanonicalDesktopProtocol()
    protocol.result('session.resume', { session_id: 'rt-2' }, { execution_generation: 4, revision: 7, session_id: 'rt-2' })
    const wire = protocol.prepare(...requests[0])
    expect(protocol.wire('config.set', wire)).toBe('session.mutate')
    expect(wire).toEqual({
      expected_generation: 4,
      expected_revision: 7,
      operation: 'model',
      payload: { model: 'gpt-6-luna', provider: 'custom:athena-gateway' },
      request_id: expect.any(String),
      session_id: 'rt-2'
    })
    // A fence refusal naming fresh fences is retried once (slice 08).
    expect(
      protocol.retryableFence(wire, { data: { reason: 'revision_conflict', revision: 8 } })
    ).toBe(true)
  })
})

describe('no model available', () => {
  test('an empty list blocks sends and shows the message; slash commands still go through', async () => {
    const removeGate = installNoModelGate()
    render(<Slot area="composer.top" />)
    expect(screen.queryByText(NO_MODEL_MESSAGE)).toBeNull()

    act(() => setClientConfigSnapshot(managedSnapshot([MOCK], { configVersion: 8, default: 'mock' })))

    expect($noModelAvailable.get()).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe(NO_MODEL_MESSAGE)
    expect(await runComposerMiddleware({ text: 'Summarise the study design.' })).toBeNull()
    expect(toasts()).toEqual([NO_MODEL_MESSAGE])
    expect(await runComposerMiddleware({ text: '/help' })).toEqual({ text: '/help' })

    // The admin restores a model: sends go through again.
    act(() => setClientConfigSnapshot(managedSnapshot([LUNA], { configVersion: 9 })))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(await runComposerMiddleware({ text: 'Hello' })).toEqual({ text: 'Hello' })
    removeGate()
  })

  test('a failed switch blocks that session until it is on an allowed model', async () => {
    const removeGate = installNoModelGate()
    const select = vi.fn<SelectModel>(async () => false)
    setClientConfigSnapshot(managedSnapshot([LUNA], { configVersion: 6 }))

    reconcileModelSessions(select)
    await flush()

    expect($noModelAvailable.get()).toBe(true) // the active session rt-1 is still on Sol
    expect(await runComposerMiddleware({ text: 'Hello' })).toBeNull()
    expect(toasts()).toEqual([NO_MODEL_MESSAGE]) // no "switched" toast for a switch that failed

    // The session reaches an allowed model (the user picked one): unblocked.
    $currentModel.set('gpt-6-luna')
    reconcileModelSessions(select)
    expect($noModelAvailable.get()).toBe(false)
    removeGate()
  })

  test('report and off never switch or block', async () => {
    const select = vi.fn<SelectModel>(async () => true)

    for (const mode of ['report', 'off'] as const) {
      setClientConfigSnapshot(managedSnapshot([MOCK], { configVersion: 10, mode }))
      reconcileModelSessions(select)
      expect($noModelAvailable.get()).toBe(false)
    }

    await flush()
    expect(select).not.toHaveBeenCalled()
  })
})
