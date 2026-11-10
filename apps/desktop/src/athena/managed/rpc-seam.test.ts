// The renderer JSON-RPC seam (F02): every HermesGateway request, desktop
// plugins' `host.request` included, asks it first.
import { afterEach, describe, expect, test, vi } from 'vitest'

import { HermesGateway } from '@/api/client'
import { host } from '@/sdk'
import { $gateway } from '@/store/gateway'

import * as mainSeams from '../../../electron/athena/policy-seams'

import { isPolicyRefusal, policyRefusalMessage, PolicyRefusedError } from './policy-refusal'
import { assertRpcAllowed, setRpcPolicy } from './rpc-seam'

afterEach(() => {
  setRpcPolicy(null)
  $gateway.set(null)
})

describe('JSON-RPC seam', () => {
  test('allows every method by default', () => {
    expect(() => assertRpcAllowed('billing.state', {})).not.toThrow()
  })

  test('a denied method rejects with a typed refusal before anything is sent', async () => {
    setRpcPolicy(method => method !== 'billing.state')
    const gateway = new HermesGateway()
    const sent = vi.spyOn(Object.getPrototypeOf(HermesGateway.prototype), 'request')

    const refused = gateway.request('billing.state', {})

    await expect(refused).rejects.toBeInstanceOf(PolicyRefusedError)
    await expect(refused).rejects.toMatchObject({ code: 'refused_by_policy', kind: 'rpc', target: 'billing.state' })
    expect(sent).not.toHaveBeenCalled()
    sent.mockRestore()
  })

  test("a desktop plugin's host.request passes through the seam", async () => {
    const policy = vi.fn((method: string) => method !== 'plugins.manage')
    setRpcPolicy(policy)
    $gateway.set(new HermesGateway())

    await expect(host.request('plugins.manage', { action: 'install', identifier: 'x/y' })).rejects.toMatchObject({
      kind: 'rpc',
      target: 'plugins.manage'
    })
    expect(policy).toHaveBeenCalledWith('plugins.manage', { action: 'install', identifier: 'x/y' })
  })
})

describe('policy refusal', () => {
  test('a REST refusal bridged from main reads back as the typed error', () => {
    // Electron prefixes a rejected invoke; preload's own rethrow does not. Both parse.
    for (const message of [
      'refused_by_policy: rest PUT /api/config',
      "Error invoking remote method 'hermes:api': Error: refused_by_policy: rest PUT /api/config"
    ]) {
      const refusal = PolicyRefusedError.from(new Error(message))

      expect(refusal).toBeInstanceOf(PolicyRefusedError)
      expect(refusal).toMatchObject({ kind: 'rest', target: 'PUT /api/config' })
    }

    expect(isPolicyRefusal(new Error('404: not found'))).toBe(false)
  })

  test('main and renderer share one message format', () => {
    for (const kind of ['deep-link', 'ipc', 'rest', 'rpc'] as const) {
      expect(mainSeams.policyRefusalMessage(kind, 'x')).toBe(policyRefusalMessage(kind, 'x'))
    }

    expect(mainSeams.POLICY_REFUSED_CODE).toBe(new PolicyRefusedError('rpc', 'x').code)
  })
})
