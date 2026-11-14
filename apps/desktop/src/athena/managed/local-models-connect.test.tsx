// F05 slice 07: connecting the HPC bridge from the Desktop window. With local models on, a local model is in the
// pickers while the bridge is down; a pick of it is not sent to hermes but opens the sign-in dialog (what the bridge
// is for, the HPC user name and password, and that the password is kept only while Athena is open). The dialog hands
// the password to Electron main once and keeps it nowhere; once the model's server is up the pick is made for the
// user. Main is a stand-in here (`window.athenaDesktop.hpcBridge`); electron/athena/hpc-bridge-password.test.ts
// covers what main does with the password.
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as ConfigApi from '@/api/config'
import { useModelControls } from '@/app/session/hooks/use-model-controls'
import { queryClient } from '@/lib/query-client'
import type * as NotificationsModule from '@/store/notifications'
import { $notifications, clearNotifications, notify } from '@/store/notifications'
import { $activeSessionId, $currentModel, $currentProvider } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import type { HpcBridgeSignIn, HpcBridgeStatus } from '../../../electron/athena/hpc-bridge-types'

import { $clientConfig, setClientConfigSnapshot } from './client-config'
import {
  $hpcBridge,
  $localModelsDialog,
  LOCAL_MODELS_CONNECTING,
  LOCAL_MODELS_NOT_IN_BUILD,
  offerLocalModelConnect,
  pendingLocalModelPick,
  setLocalModelSelector,
  setPendingPickDelay
} from './local-models'
import {
  AthenaLocalModelsDialog,
  LOCAL_MODELS_CONNECTED,
  LOCAL_MODELS_DIALOG,
  MODEL_SERVER_DOWN,
  SIGN_IN_ERRORS
} from './local-models-dialog'
import { BRIDGE_PROVIDER, LUNA, managedSnapshot, QWEN, QWEN_NAME, SOL } from './managed-models-fixture'
import { installModelPolicy } from './model-policy'
import { resetModelSwitches } from './model-switch'

const GATEWAY = 'custom:athena-gateway'
const USER = 'researcher1'
const MARKER = 'M4rk3r-p@ss w0rd 7f3a9c'

vi.mock('@/hermes', async () => ({
  ...(await vi.importActual<typeof ConfigApi>('@/api/config')),
  getApiRequestProfile: () => 'default',
  getGlobalModelInfo: vi.fn(async () => ({ model: 'gpt-6-sol', provider: 'custom:athena-gateway' })),
  profileScopeKey: (scope?: null | string) => (scope ?? '').trim() || 'default',
  setApiRequestProfile: () => {}
}))
vi.mock('@/store/notifications', async importOriginal => {
  const actual = await importOriginal<typeof NotificationsModule>()

  return { ...actual, notify: vi.fn(actual.notify) }
})

const snapshot = (options: { bridge?: boolean; feature?: 'off' | 'on'; switchOn?: boolean } = {}) =>
  managedSnapshot([SOL, LUNA, QWEN], {
    bridge: options.bridge ?? false,
    configVersion: 5,
    default: 'gpt-6-sol',
    localModelsFeature: options.feature ?? 'on',
    localModelsSwitch: options.switchOn ?? true
  })

const status = (patch: Partial<HpcBridgeStatus> = {}): HpcBridgeStatus => ({
  credential: 'none',
  since: '2026-11-13T20:00:00.000Z',
  state: 'no_key',
  ...patch
})

const CONNECTED = status({
  credential: 'password',
  port: 49731,
  servers: { default: { port: 49731, state: 'up' } },
  state: 'connected',
  username: USER
})

/** Electron main's side of `window.athenaDesktop.hpcBridge`. */
function fakeBridge(initial: HpcBridgeStatus) {
  const listeners = new Set<(next: HpcBridgeStatus) => void>()

  const bridge = {
    connect: vi.fn(async (_signIn?: HpcBridgeSignIn): Promise<HpcBridgeStatus> => bridge.current),
    current: initial,
    disconnect: vi.fn(async () => bridge.current),
    forgetUser: vi.fn(async () => bridge.current),
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

/** The window as the app wires it: the dialog mounted, and the app's own model pick. */
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
    pick: (sessionId: null | string = 'rt-1') =>
      act(async () => result.current.selectModel({ model: QWEN_NAME, provider: 'athena-vllm', sessionId }))
  }
}

const field = (name: 'password' | 'username') =>
  document.querySelector<HTMLInputElement>(`input[name="athena-hpc-${name}"]`)!

function fill(username: string, password: string) {
  fireEvent.change(field('username'), { target: { value: username } })
  fireEvent.change(field('password'), { target: { value: password } })
}

const submit = () => act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Connect' })))

async function start(initial: HpcBridgeStatus = status(), config = snapshot()) {
  bridge = fakeBridge(initial)
  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { hpcBridge: bridge, policy: { record: vi.fn() } }
  uninstall = installModelPolicy()
  setClientConfigSnapshot(config)
  await flush()
}

beforeEach(() => {
  requests = []
  queryClient.clear()
  window.localStorage.clear()
  window.sessionStorage.clear()
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

describe('the first pick of a local model with no bridge open', () => {
  test('the pick is not sent to hermes: the dialog opens and says what it is for', async () => {
    await start()
    const app = mountApp()

    expect($hpcBridge.get()).toMatchObject({ state: 'no_key' })
    expect(await app.pick()).toBe(false)

    expect(requests).toEqual([])
    // The composer still names the model the session is on.
    expect($currentModel.get()).toBe('gpt-6-sol')

    const dialog = await screen.findByTestId('athena-local-models-dialog')

    expect(dialog.textContent).toContain(LOCAL_MODELS_DIALOG.title)
    expect(dialog.textContent).toContain(
      'Local models run on the HPC. To use them, Athena signs in to the HPC from this computer with your HPC account.'
    )
    expect(dialog.textContent).toContain('Your password is kept only while Athena is open and is never saved.')
    expect(screen.getByLabelText('HPC username')).toBe(field('username'))
    expect(screen.getByLabelText('HPC password')).toBe(field('password'))
    expect(field('password').type).toBe('password')
    expect(field('password').autocomplete).toBe('off')
    expect(field('username').value).toBe('')
    // Nothing to send yet.
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', true)
    expect(bridge.connect).not.toHaveBeenCalled()
  })

  test('user name and password connect the bridge, and the pick is then made for the user', async () => {
    await start()
    const app = mountApp()
    await app.pick()
    await screen.findByTestId('athena-local-models-dialog')

    let answer: (next: HpcBridgeStatus) => void = () => {}
    bridge.connect.mockImplementationOnce(() => new Promise<HpcBridgeStatus>(resolve => (answer = resolve)))
    fill(` ${USER} `, MARKER)
    await submit()

    // Handed to main once, as typed (the user name trimmed). From this moment the field is empty.
    expect(bridge.connect.mock.calls).toEqual([[{ password: MARKER, username: USER }]])
    expect(field('password').value).toBe('')
    expect(screen.getByRole('button', { name: 'Connecting…' })).toHaveProperty('disabled', true)

    await act(async () => {
      bridge.push(CONNECTED)
      answer(CONNECTED)
    })

    await waitFor(() => expect(screen.queryByTestId('athena-local-models-dialog')).toBeNull())
    expect(toasts()).toContain(LOCAL_MODELS_CONNECTED)
    // Not yet picked: the model is callable only once main reports its server's forward (the snapshot).
    expect(requests).toEqual([])
    expect(pendingLocalModelPick()).toMatchObject({ model: QWEN_NAME, sessionId: 'rt-1' })

    act(() => setClientConfigSnapshot(snapshot({ bridge: true })))
    await waitFor(() =>
      expect(requests).toEqual([
        ['config.set', { key: 'model', session_id: 'rt-1', value: `${QWEN_NAME} --provider athena-vllm` }]
      ])
    )
    expect($currentModel.get()).toBe(QWEN_NAME)
    expect(pendingLocalModelPick()).toBeNull()
  })

  test('after the dialog closes the password is nowhere in the window', async () => {
    await start()
    const app = mountApp()
    await app.pick()
    await screen.findByTestId('athena-local-models-dialog')
    fill(USER, MARKER)
    bridge.connect.mockImplementationOnce(async () => {
      bridge.push(CONNECTED)

      return CONNECTED
    })
    await submit()
    await waitFor(() => expect(screen.queryByTestId('athena-local-models-dialog')).toBeNull())
    act(() => setClientConfigSnapshot(snapshot({ bridge: true })))
    await waitFor(() => expect(requests).toHaveLength(1))

    const places: Record<string, string> = {
      'the bridge status store': JSON.stringify($hpcBridge.get()),
      'the client config store': JSON.stringify($clientConfig.get()),
      'the dialog store': JSON.stringify($localModelsDialog.get()),
      'the notifications': JSON.stringify($notifications.get()),
      'the page': document.documentElement.outerHTML,
      'the requests to hermes': JSON.stringify(requests),
      'the session stores': JSON.stringify([$sessionStates.get(), $currentModel.get(), $currentProvider.get()]),
      'the toasts': JSON.stringify(vi.mocked(notify).mock.calls),
      'window.localStorage': JSON.stringify({ ...window.localStorage }),
      'window.sessionStorage': JSON.stringify({ ...window.sessionStorage })
    }

    for (const [place, text] of Object.entries(places)) {
      expect(text.includes(MARKER), `${place} holds the password`).toBe(false)
    }

    for (const input of document.querySelectorAll('input')) {
      expect(input.value).not.toContain(MARKER)
    }

    // It crossed to main exactly once, and no other call to main carried it.
    expect(bridge.connect).toHaveBeenCalledTimes(1)
    expect(
      JSON.stringify([bridge.status.mock.calls, bridge.disconnect.mock.calls, bridge.forgetUser.mock.calls])
    ).not.toContain(MARKER)
  })

  test('after a relaunch the dialog shows the remembered user name and asks for the password again', async () => {
    await start(status({ username: USER }))
    const app = mountApp()
    await app.pick()
    await screen.findByTestId('athena-local-models-dialog')

    expect(field('username').value).toBe(USER)
    expect(field('password').value).toBe('')
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', true)
    await waitFor(() => expect(document.activeElement).toBe(field('password')))
  })
})

describe('a sign-in that does not go through', () => {
  test('a wrong password: a clear message, the dialog stays, the field is empty and nothing is picked', async () => {
    await start()
    const app = mountApp()
    await app.pick()
    await screen.findByTestId('athena-local-models-dialog')

    const refused = status({ reason: 'auth_failed', state: 'down' })
    bridge.connect.mockImplementationOnce(async () => {
      bridge.push(refused)

      return refused
    })
    fill(USER, MARKER)
    await submit()

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The HPC did not accept that username and password. Check them and try again.'
    )
    expect(field('password').value).toBe('')
    expect(field('username').value).toBe(USER)
    expect(document.documentElement.outerHTML).not.toContain(MARKER)
    expect(requests).toEqual([])
    expect($currentModel.get()).toBe('gpt-6-sol')

    // A second try with the right one goes through.
    bridge.connect.mockImplementationOnce(async () => CONNECTED)
    fireEvent.change(field('password'), { target: { value: 'the right one' } })
    await submit()
    await waitFor(() => expect(screen.queryByTestId('athena-local-models-dialog')).toBeNull())
    expect(bridge.connect).toHaveBeenCalledTimes(2)
  })

  test.each([
    ['unreachable', 'Athena could not reach the HPC login node. Check your network connection and try again.'],
    ['timeout', SIGN_IN_ERRORS.unreachable],
    [
      'host_key_mismatch',
      'Athena could not confirm it was talking to the HPC login node, so your password was not sent. Contact your administrator.'
    ],
    [
      'auth_unsupported',
      'The HPC asked for more than a password, which Athena cannot answer. Contact your administrator.'
    ],
    ['something_new', 'Athena could not connect. Try again.']
  ])('%s: the dialog says why', async (reason, message) => {
    await start()
    const app = mountApp()
    await app.pick()
    await screen.findByTestId('athena-local-models-dialog')
    bridge.connect.mockImplementationOnce(async () => status({ reason, state: 'down' }))
    fill(USER, 'a password')
    await submit()

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(field('password').value).toBe('')
  })

  test('main does not answer (the row went off meanwhile): a plain message', async () => {
    await start()
    const app = mountApp()
    await app.pick()
    await screen.findByTestId('athena-local-models-dialog')
    bridge.connect.mockRejectedValueOnce(new Error('refused_by_policy: ipc athena:hpc-bridge:connect'))
    fill(USER, MARKER)
    await submit()

    expect((await screen.findByRole('alert')).textContent).toBe('Athena could not connect. Try again.')
    expect(document.documentElement.outerHTML).not.toContain(MARKER)
  })

  test('signed in, but the model server is not answering: the dialog closes and says so', async () => {
    await start()
    const app = mountApp()
    await app.pick()
    await screen.findByTestId('athena-local-models-dialog')
    bridge.connect.mockImplementationOnce(async () => ({
      ...CONNECTED,
      port: undefined,
      servers: { default: { reason: 'target_unreachable', state: 'down' as const } }
    }))
    fill(USER, 'a password')
    await submit()

    await waitFor(() => expect(screen.queryByTestId('athena-local-models-dialog')).toBeNull())
    expect(toasts()).toContain(MODEL_SERVER_DOWN)
    expect(requests).toEqual([])
  })

  test('Cancel closes the dialog and drops the pick: a bridge that comes up later picks nothing', async () => {
    await start()
    const app = mountApp()
    await app.pick()
    await screen.findByTestId('athena-local-models-dialog')
    fill(USER, MARKER)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByTestId('athena-local-models-dialog')).toBeNull())
    expect(bridge.connect).not.toHaveBeenCalled()
    expect(pendingLocalModelPick()).toBeNull()
    expect(document.documentElement.outerHTML).not.toContain(MARKER)

    act(() => setClientConfigSnapshot(snapshot({ bridge: true })))
    await flush()
    expect(requests).toEqual([])

    // Opened again: the form is new, the password field empty.
    act(() => setClientConfigSnapshot(snapshot()))
    await app.pick()
    await screen.findByTestId('athena-local-models-dialog')
    expect(field('password').value).toBe('')
  })
})

describe('when the dialog is not what a pick needs', () => {
  test('main still holds the password (the bridge dropped): the pick reconnects with no dialog', async () => {
    await start(status({ credential: 'password', reason: 'unreachable', state: 'down', username: USER }))
    const app = mountApp()

    expect(await app.pick()).toBe(false)

    expect(screen.queryByTestId('athena-local-models-dialog')).toBeNull()
    expect(bridge.connect.mock.calls).toEqual([[]])
    expect(toasts()).toEqual([LOCAL_MODELS_CONNECTING])
    expect(requests).toEqual([])

    // Back: the pick is made.
    act(() => setClientConfigSnapshot(snapshot({ bridge: true })))
    await waitFor(() => expect(requests).toHaveLength(1))
  })

  test('a configured key (slice 06) connects without the dialog too', async () => {
    await start(status({ credential: 'key', reason: 'disconnected', state: 'off' }))
    const app = mountApp()
    await app.pick()

    expect(screen.queryByTestId('athena-local-models-dialog')).toBeNull()
    expect(bridge.connect.mock.calls).toEqual([[]])
  })

  test('the HPC refused the password earlier: the dialog again', async () => {
    await start(status({ reason: 'auth_failed', state: 'down', username: USER }))
    const app = mountApp()
    await app.pick()

    await screen.findByTestId('athena-local-models-dialog')
    expect(field('username').value).toBe(USER)
    expect(bridge.connect).not.toHaveBeenCalled()
  })

  test('a build that cannot check the login node never asks for a password', async () => {
    await start(status({ state: 'host_key_unknown' }))
    const app = mountApp()
    await app.pick()

    expect(screen.queryByTestId('athena-local-models-dialog')).toBeNull()
    expect(toasts()).toEqual([LOCAL_MODELS_NOT_IN_BUILD])
    expect(pendingLocalModelPick()).toBeNull()
  })

  test('the primary composer moved to another chat before the bridge came up: the pick is dropped', async () => {
    await start(status({ credential: 'password', reason: 'unreachable', state: 'down' }))
    const app = mountApp()
    await app.pick(null)
    $activeSessionId.set('rt-other')

    act(() => setClientConfigSnapshot(snapshot({ bridge: true })))
    await flush()
    expect(requests).toEqual([])
    expect(pendingLocalModelPick()).toBeNull()
  })

  test('a connected local model, a gateway model, and local models off: the pick goes straight through', async () => {
    await start(CONNECTED, snapshot({ bridge: true }))
    const app = mountApp()

    expect(await app.pick()).toBe(true)
    expect(requests).toHaveLength(1)
    expect(offerLocalModelConnect({ model: 'gpt-6-luna', provider: GATEWAY })).toBe(false)
    expect(screen.queryByTestId('athena-local-models-dialog')).toBeNull()

    for (const config of [snapshot({ feature: 'off' }), snapshot({ switchOn: false })]) {
      act(() => setClientConfigSnapshot(config))
      // Not on the list at all then: nothing is offered, and the model gate refuses the pick as before.
      expect(offerLocalModelConnect({ model: QWEN_NAME, provider: BRIDGE_PROVIDER })).toBe(false)
      expect($hpcBridge.get()).toBeNull()
    }

    expect(screen.queryByTestId('athena-local-models-dialog')).toBeNull()
  })

  test('with local models off main is never asked for the bridge, and nothing new shows', async () => {
    await start(status(), snapshot({ feature: 'off' }))
    mountApp()

    expect(bridge.status).not.toHaveBeenCalled()
    expect($hpcBridge.get()).toBeNull()
    expect(document.body.textContent).toBe('')
  })
})
