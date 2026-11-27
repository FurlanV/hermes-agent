// F02 slice 29: with Bot Mode turned on (S123) and managed.tools enforce, Bot Mode's inline MCP add hits the same
// JSON-RPC refusal as the rest of the app: nothing reaches the gateway, and the refusal is recorded with kind "tool".
// The component is the real one, calling the real SDK `host.request` over a real `HermesGateway` whose wire send is
// spied. Bot Mode's own skills hub picker is gone upstream (v0.23.4, 2a0f26c6bc): Bot Mode embeds the Capabilities
// view instead, whose skills.manage calls tool-installs.test.tsx refuses for every action.
import type * as HermesSdk from '@hermes/plugin-sdk'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { HermesGateway } from '@/api/client'
import { translateBots } from '@/plugins/hermes-bots/i18n-test-helper'
import { $gateway } from '@/store/gateway'

import { BUNDLED_DEFAULT_CONFIG } from '../../../electron/athena/bundled-config-data'

import { $clientConfig, type ClientConfigSnapshot, setClientConfigSnapshot } from './client-config'
import { installFeaturePolicy } from './feature-policy'

vi.mock('@hermes/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof HermesSdk>()),
  usePluginI18n: () => translateBots
}))

const { McpSetupButton } = await import('@/plugins/hermes-bots/mcp-setup')

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

const botModeOn: ClientConfigSnapshot = {
  config: { ...bundled, features: { S123: 'on' }, managed: { ...(bundled.managed as object), tools: 'enforce' } },
  configVersion: null,
  devOverridesActive: true,
  error: 'missing',
  role: null,
  source: 'bundled',
  verifiedAt: null
}

const record = vi.fn()
let uninstall: () => void
let sent: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  record.mockReset()
  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { policy: { record } }
  uninstall = installFeaturePolicy()
  setClientConfigSnapshot(botModeOn)
  $gateway.set(new HermesGateway())
  sent = vi.spyOn(Object.getPrototypeOf(HermesGateway.prototype), 'request').mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
})

afterEach(() => {
  cleanup()
  sent.mockRestore()
  vi.unstubAllGlobals()
  uninstall()
  $clientConfig.set(null)
  $gateway.set(null)
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

const sentMethods = () =>
  (sent.mock.calls as unknown[][]).map(([method, params]) =>
    `${String(method)} ${(params as undefined | { action?: string })?.action ?? ''}`.trim()
  )

const refusals = () => record.mock.calls.map(([decision]) => decision).filter(decision => decision.action === 'refused')

describe('Bot Mode on (S123) under managed.tools enforce', () => {
  test("the inline MCP add is refused before it is sent, and the row shows the failure", async () => {
    render(
      <McpSetupButton
        entry={{ fromCatalog: true, installed: false, name: 'linear', requires: ['LINEAR_API_KEY'] }}
        profile="bot-one"
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: translateBots('tools.setUp') }))

    await waitFor(() => expect(screen.getByText(/refused_by_policy/)).not.toBeNull())
    expect(refusals()).toEqual([
      expect.objectContaining({ id: 'install:mcp-server', kind: 'tool', target: 'mcp.servers.add' })
    ])
    expect(sentMethods()).not.toContain('mcp.servers.add')
  })
})
