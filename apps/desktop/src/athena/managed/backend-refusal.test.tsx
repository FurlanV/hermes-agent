// F02 slice 17: a disabled feature's JSON-RPC methods are refused by the renderer seam, even when called directly
// or by a desktop plugin through `host.request`, and a row turned on re-opens them with the next snapshot.
// Table-driven over the registry: every `rpc:` / `slash:` surface of every row that is off under the bundled
// default. Plus the renderer's half of "Import config with S02 on": the control shows and the write it sends
// passes the REST seam (the pinned key is then held by managed scope, tested in the athena repo).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { HermesGateway } from '@/api/client'
import { host } from '@/sdk'
import { $gateway } from '@/store/gateway'

import { rowSurfaces, type SurfaceCall } from '../../../electron/athena/backend-surfaces.test-helper'
import { BUNDLED_DEFAULT_CONFIG } from '../../../electron/athena/bundled-config-data'
import { featureEntryFilter, featureStates } from '../../../electron/athena/feature-registry'
import { applyMainPolicies } from '../../../electron/athena/main-policy'
import { refuseRestRequest, setMainPolicySeams } from '../../../electron/athena/policy-seams'

import { $clientConfig, type ClientConfigSnapshot, setClientConfigSnapshot } from './client-config'
import { installFeaturePolicy } from './feature-policy'
import { $featureFilter } from './features'
import { PolicyRefusedError } from './policy-refusal'
import { assertRpcAllowed } from './rpc-seam'

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

const snapshot = (features: Record<string, string> = {}, devOverridesActive = false): ClientConfigSnapshot => ({
  config: { ...bundled, features: { ...((bundled.features as Record<string, string>) ?? {}), ...features } },
  configVersion: null,
  devOverridesActive,
  error: 'missing',
  role: null,
  source: 'bundled',
  verifiedAt: null
})

const record = vi.fn()
let uninstall: () => void

beforeEach(() => {
  record.mockReset()
  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { policy: { record } }
  uninstall = installFeaturePolicy()
})

afterEach(() => {
  uninstall()
  $clientConfig.set(null)
  $gateway.set(null)
  setMainPolicySeams(null)
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

const RPC_ROWS = rowSurfaces(['rpc'])
const offByDefault = (id: string) => !featureStates(bundled).on(id)
const rpcCalls = (calls: SurfaceCall[]) => calls.filter(call => call.kind === 'rpc')

describe('every disabled row is refused at JSON-RPC', () => {
  test('the table covers the audit methods', () => {
    const ids = RPC_ROWS.map(({ row }) => row.id)

    for (const id of ['S77', 'S110', 'S49', 'S117', 'S113', 'S118b', 'S53']) {
      expect(ids, id).toContain(id)
    }
  })

  test.each(RPC_ROWS.filter(({ row }) => offByDefault(row.id)).map(({ calls, row }) => [row.id, calls] as const))(
    '%s off: each method is refused before it is sent, and recorded',
    async (id, calls) => {
      setClientConfigSnapshot(snapshot())
      const gateway = new HermesGateway()
      const sent = vi.spyOn(Object.getPrototypeOf(HermesGateway.prototype), 'request')

      for (const call of rpcCalls(calls)) {
        if (call.kind !== 'rpc') {
          continue
        }

        await expect(gateway.request(call.method, call.params), `${id} ${call.entry}`).rejects.toBeInstanceOf(
          PolicyRefusedError
        )
      }

      expect(sent).not.toHaveBeenCalled()
      sent.mockRestore()
      expect(record).toHaveBeenCalledTimes(rpcCalls(calls).length)
      expect(record.mock.calls[0][0]).toMatchObject({ action: 'refused', kind: 'feature', mode: 'enforce', surface: 'rpc' })
    }
  )

  test.each(
    RPC_ROWS.filter(({ row }) => offByDefault(row.id) && row.mark === 'disable').map(
      ({ calls, row }) => [row.id, calls] as const
    )
  )('%s turned on (dev override): each method goes through with the next snapshot', (id, calls) => {
    setClientConfigSnapshot(snapshot())
    setClientConfigSnapshot(snapshot({ [id]: 'on' }, true))

    for (const call of rpcCalls(calls)) {
      if (call.kind === 'rpc') {
        expect(() => assertRpcAllowed(call.method, call.params), `${id} ${call.entry}`).not.toThrow()
      }
    }
  })

  test.each(RPC_ROWS.filter(({ row }) => row.mark === 'remove').map(({ calls, row }) => [row.id, calls] as const))(
    '%s (remove) stays refused with features: {%s: on}',
    (id, calls) => {
      setClientConfigSnapshot(snapshot({ [id]: 'on' }, true))

      for (const call of rpcCalls(calls)) {
        if (call.kind === 'rpc') {
          expect(() => assertRpcAllowed(call.method, call.params), `${id} ${call.entry}`).toThrow(PolicyRefusedError)
        }
      }
    }
  )

  test('methods no row lists are left alone', () => {
    setClientConfigSnapshot(snapshot())

    for (const method of ['session.create', 'prompt.submit', 'config.get', 'model.options', 'pet.info', 'plugins.list']) {
      expect(() => assertRpcAllowed(method, {}), method).not.toThrow()
    }

    expect(() => assertRpcAllowed('command.dispatch', { name: 'reasoning' })).not.toThrow()
    expect(record).not.toHaveBeenCalled()
  })
})

describe('desktop plugins', () => {
  test("a test plugin calling a refused method through host.request is refused, and an allowed one is not", async () => {
    setClientConfigSnapshot(snapshot())
    const gateway = new HermesGateway()
    $gateway.set(gateway)
    const sent = vi.spyOn(Object.getPrototypeOf(HermesGateway.prototype), 'request').mockResolvedValue({ ok: true })

    // What a plugin's code does: `host.request(method, params)`.
    const testPlugin = {
      billing: () => host.request('billing.state', {}),
      cron: () => host.request('cron.manage', { action: 'list' }),
      yolo: () => host.request('command.dispatch', { name: 'yolo' }),
      list: () => host.request('plugins.list', {})
    }

    await expect(testPlugin.billing()).rejects.toMatchObject({ code: 'refused_by_policy', kind: 'rpc', target: 'billing.state' })
    await expect(testPlugin.cron()).rejects.toMatchObject({ kind: 'rpc', target: 'cron.manage' })
    await expect(testPlugin.yolo()).rejects.toMatchObject({ kind: 'rpc', target: 'command.dispatch' })
    await expect(testPlugin.list()).resolves.toEqual({ ok: true })
    expect(sent.mock.calls.map(([method]) => method)).toEqual(['plugins.list'])
    sent.mockRestore()
  })
})

describe('Import config with S02 on through the dev override', () => {
  test('the Import control is offered and its PUT /api/config passes the REST seam (the backend pins hold)', () => {
    const on = snapshot({ S02: 'on' }, true)
    setClientConfigSnapshot(on)
    applyMainPolicies(on)

    expect($featureFilter.get()('settings-control:import-config')).toBe(true)
    expect(featureEntryFilter(bundled)('settings-control:import-config')).toBe(false)
    expect(
      refuseRestRequest({ body: { config: { approvals: { timeout: 5 } } }, method: 'PUT', path: '/api/config' })
    ).toBeNull()
  })
})

describe('desktop pins', () => {
  test('S36 off pins inline embeds off and clears standing grants; S36 on lets the user choose', async () => {
    const { $embedAllowed, $embedMode, allowProvider, setEmbedMode } = await import('@/store/embed-consent')
    const { installDesktopPins } = await import('./desktop-pins')
    setClientConfigSnapshot(snapshot({ S36: 'on' }, true))
    setEmbedMode('always')
    allowProvider('youtube')
    const off = installDesktopPins()

    expect($embedMode.get()).toBe('always')

    setClientConfigSnapshot(snapshot())
    expect($embedMode.get()).toBe('off')
    expect($embedAllowed.get()).toEqual([])

    // A write from elsewhere while the row is off is undone.
    setEmbedMode('always')
    expect($embedMode.get()).toBe('off')

    setClientConfigSnapshot(snapshot({ S36: 'on' }, true))
    setEmbedMode('ask')
    expect($embedMode.get()).toBe('ask')
    off()
  })
})
