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
  policyRefusalMessage,
  refuseRestRequest,
  setMainPolicySeams,
  unwrapPolicyRefusal
} from './policy-seams'

const electronDir = path.resolve(import.meta.dirname, '..')
const source = (file: string) => readFileSync(path.join(electronDir, file), 'utf8')

afterEach(() => setMainPolicySeams(null))

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
  const fakeIpc = () => ({ handle: vi.fn() })

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
