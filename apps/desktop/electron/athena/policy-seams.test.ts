// The main-process policy seams (F02): REST, IPC registration and deep links.
// Each allows everything by default; a seam that denies one target blocks it.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { HERMES_API_EXPECTED_404, unwrapExpectedNotFound } from '../api-expected-404'

import {
  ATHENA_POLICY_REFUSED,
  deepLinkAllowed,
  GUARDED_IPC_CHANNELS,
  guardedIpcMain,
  installIpcPolicyGuard,
  policyRefusalMessage,
  refuseRestRequest,
  resetIpcTrackingForTests,
  setMainPolicySeams,
  trackedIpcChannels,
  unwrapPolicyRefusal
} from './policy-seams'

const electronDir = path.resolve(import.meta.dirname, '..')
const source = (file: string) => readFileSync(path.join(electronDir, file), 'utf8')

afterEach(() => {
  setMainPolicySeams(null)
  resetIpcTrackingForTests()
})

describe('REST seam', () => {
  test('forwards every request by default', () => {
    expect(refuseRestRequest({ method: 'PUT', path: '/api/config' })).toBeNull()
    expect(refuseRestRequest(undefined)).toBeNull()
  })

  test('a denied path resolves a refusal the caller sees as a typed rejection', async () => {
    const rest = vi.fn(({ pathname }: { pathname: string }) => pathname !== '/api/config')
    setMainPolicySeams({ rest })

    const refusal = refuseRestRequest({ method: 'put', path: '/api/config?profile=work' })

    expect(rest).toHaveBeenCalledWith({ method: 'PUT', path: '/api/config?profile=work', pathname: '/api/config' })
    expect(refusal).toEqual({ [ATHENA_POLICY_REFUSED]: 'refused_by_policy: rest PUT /api/config' })
    expect(refuseRestRequest({ path: '/api/status' })).toBeNull()

    // What preload does with the handler's answer (electron/preload.ts `api`).
    const invoke = Promise.resolve(refusal).then(unwrapExpectedNotFound).then(unwrapPolicyRefusal)
    await expect(invoke).rejects.toThrow(policyRefusalMessage('rest', 'PUT /api/config'))
  })

  test('preload passes real answers and the expected-404 sentinel through untouched', async () => {
    expect(unwrapPolicyRefusal({ ok: true })).toEqual({ ok: true })
    expect(unwrapPolicyRefusal({ [ATHENA_POLICY_REFUSED]: 'x', other: 1 })).toEqual({
      [ATHENA_POLICY_REFUSED]: 'x',
      other: 1
    })

    const notFound = Promise.resolve({ [HERMES_API_EXPECTED_404]: '404: gone' })
      .then(unwrapExpectedNotFound)
      .then(unwrapPolicyRefusal)

    await expect(notFound).rejects.toThrow('404: gone')
  })
})

describe('IPC seam', () => {
  const fakeIpc = () => ({ handle: vi.fn(), removeHandler: vi.fn() })

  test('registers every guarded channel by default', () => {
    const ipc = fakeIpc()
    const guarded = guardedIpcMain(ipc)
    const channels = Object.values(GUARDED_IPC_CHANNELS).flat()

    for (const channel of channels) {
      expect(guarded.handle(channel, () => null)).toBe(true)
    }

    expect(ipc.handle.mock.calls.map(([channel]) => channel)).toEqual(channels)
  })

  test('a denied channel is not registered', () => {
    setMainPolicySeams({ ipcChannel: channel => channel !== 'hermes:cloud:login' })
    const ipc = fakeIpc()
    const guarded = guardedIpcMain(ipc)

    expect(guarded.handle('hermes:cloud:login', () => null)).toBe(false)
    expect(guarded.handle('hermes:cloud:status', () => null)).toBe(true)
    expect(ipc.handle.mock.calls.map(([channel]) => channel)).toEqual(['hermes:cloud:status'])
  })

  test('a policy change unregisters a refused channel and re-registers it when it is allowed again', () => {
    let refused = true
    setMainPolicySeams({ ipcChannel: channel => !(refused && channel === 'hermes:cloud:login') })
    const ipc = fakeIpc()
    const listener = vi.fn(() => 'ok')
    const guarded = guardedIpcMain(ipc)

    expect(guarded.handle('hermes:cloud:login', listener)).toBe(false)
    expect(guarded.handle('hermes:cloud:status', () => null)).toBe(true)
    expect(ipc.handle).toHaveBeenCalledTimes(1)

    refused = false
    setMainPolicySeams({ ipcChannel: channel => !(refused && channel === 'hermes:cloud:login') })
    expect(ipc.handle.mock.calls.map(([channel]) => channel)).toEqual(['hermes:cloud:status', 'hermes:cloud:login'])
    expect(trackedIpcChannels()).toEqual([
      { channel: 'hermes:cloud:login', registered: true },
      { channel: 'hermes:cloud:status', registered: true }
    ])

    // The handler Electron holds runs the original listener (and tells the policy it was used).
    const ipcUse = vi.fn()
    setMainPolicySeams({ ipcUse })
    const registered = ipc.handle.mock.calls[1][1] as (...args: unknown[]) => unknown
    expect(registered('event', 'arg')).toBe('ok')
    expect(listener).toHaveBeenCalledWith('event', 'arg')
    expect(ipcUse).toHaveBeenCalledWith('hermes:cloud:login')

    refused = true
    setMainPolicySeams({ ipcChannel: channel => !(refused && channel === 'hermes:cloud:login') })
    expect(ipc.removeHandler.mock.calls).toEqual([['hermes:cloud:login']])
    expect(trackedIpcChannels()[0]).toEqual({ channel: 'hermes:cloud:login', registered: false })
  })

  test('installIpcPolicyGuard tracks policy channels registered straight on ipcMain, and passes others through', () => {
    const handle = vi.fn()
    const on = vi.fn()
    const removeHandler = vi.fn()
    const removeListener = vi.fn()
    const ipc = { handle, on, removeHandler, removeListener } as unknown as Parameters<typeof installIpcPolicyGuard>[0]
    installIpcPolicyGuard(ipc, channel => channel.startsWith('hermes:terminal:') || channel === 'hermes:devtools:x')
    setMainPolicySeams({ ipcChannel: channel => channel !== 'hermes:terminal:start' && channel !== 'hermes:devtools:x' })

    ipc.handle('hermes:terminal:start', () => null)
    ipc.handle('hermes:terminal:write', () => null)
    ipc.handle('hermes:version', () => null)
    ipc.on('hermes:devtools:x', () => null)

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(['hermes:terminal:write', 'hermes:version'])
    expect(on).not.toHaveBeenCalled()

    setMainPolicySeams(null)
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      'hermes:terminal:write',
      'hermes:version',
      'hermes:terminal:start'
    ])
    expect(on.mock.calls.map(([channel]) => channel)).toEqual(['hermes:devtools:x'])

    // A module swapping its own handler leaves no stale tracked copy.
    ipc.removeHandler('hermes:terminal:write')
    expect(removeHandler).toHaveBeenCalledWith('hermes:terminal:write')
    expect(trackedIpcChannels().map(entry => entry.channel)).not.toContain('hermes:terminal:write')
  })

  test('main.ts imports the IPC guard before anything else', () => {
    const main = source('main.ts')
    const firstImport = main.split('\n').find(line => line.startsWith('import '))

    expect(firstImport).toBe("import './athena/ipc-guard-install'")
  })

  test('main.ts and fs-ipc.ts register each guarded channel through the seam', () => {
    const files = { 'fs-ipc.ts': source('fs-ipc.ts'), 'main.ts': source('main.ts') }
    const all = Object.values(files).join('\n')

    for (const channel of Object.values(GUARDED_IPC_CHANNELS).flat()) {
      expect(all, channel).toMatch(new RegExp(`athenaIpc\\.handle\\(\\s*'${channel}'`))
      expect(all, channel).not.toMatch(new RegExp(`ipcMain\\.handle\\(\\s*'${channel}'`))
    }

    expect(files['main.ts']).toContain('const athenaIpc = guardedIpcMain(ipcMain)')
    expect(files['fs-ipc.ts']).toContain('const athenaIpc = guardedIpcMain(ipcMain)')
  })
})

describe('deep-link seam', () => {
  const link = (kind: string) => ({ kind, name: 'install', params: {} })

  test('routes every link by default', () => {
    expect(deepLinkAllowed(link('mcp'))).toBe(true)
  })

  test('a denied kind is blocked', () => {
    setMainPolicySeams({ deepLink: ({ kind }) => kind !== 'mcp' })

    expect(deepLinkAllowed(link('mcp'))).toBe(false)
    expect(deepLinkAllowed(link('open'))).toBe(true)
  })

  test('main asks the REST and deep-link seams before routing', () => {
    const main = source('main.ts')
    const apiHandler = main.slice(main.indexOf("ipcMain.handle('hermes:api'"))
    const deepLink = main.slice(main.indexOf('function handleDeepLink(url)'))

    // First statement of the handler, before any profile gate or forwarding.
    expect(apiHandler.slice(0, 200)).toContain('const refusal = refuseRestRequest(request)')
    // After the link is parsed, before any kind-specific routing or delivery.
    expect(deepLink.indexOf('deepLinkAllowed(payload)')).toBeGreaterThan(-1)
    expect(deepLink.indexOf('deepLinkAllowed(payload)')).toBeLessThan(deepLink.indexOf("kind === 'copilot-key'"))
  })
})
