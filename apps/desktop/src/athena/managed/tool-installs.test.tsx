import { readFileSync } from 'node:fs'
import path from 'node:path'

// F02 slice 29, renderer half: while managed.tools is enforce, every JSON-RPC install call (sent directly, or by a
// desktop plugin through host.request) is refused before it is sent and recorded with kind "tool"; the install
// dialogs and the plugin catalog lookup the renderer opens by itself do not open; the in-chat install cards and the
// setup chat's plugins and connectors beats are not shown. Under report each goes through and is recorded as
// allowed_in_report; under off nothing is refused or recorded. Main's half is electron/athena/tool-install-policy.test.ts.
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { HermesGateway } from '@/api/client'
import { PRIMARY_SESSION_VIEW, type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { SetupBeatTool } from '@/components/assistant-ui/setup-beat/setup-beat-tool'
import { I18nProvider } from '@/i18n'
import { lookupPluginCatalogEntry } from '@/lib/plugin-catalog'
import { host } from '@/sdk'
import { $gateway } from '@/store/gateway'
import { $mcpInstallRequest, requestMcpInstallFromDeepLink } from '@/store/mcp-deeplink-install'
import { $pluginInstallRequest, closePluginInstallRequest, openPluginInstallRequest } from '@/store/plugin-install-request'
import type * as SetupBeatStore from '@/store/setup-beat'
import { $setupBeatRequests, answerSetupBeat, parkSetupBeat } from '@/store/setup-beat'
import { requestSkillInstallFromDeepLink } from '@/store/skill-deeplink-install'

import { BUNDLED_DEFAULT_CONFIG } from '../../../electron/athena/bundled-config-data'

import { $clientConfig, type ClientConfigSnapshot, setClientConfigSnapshot } from './client-config'
import { installFeaturePolicy } from './feature-policy'
import { PolicyRefusedError } from './policy-refusal'
import { assertRpcAllowed } from './rpc-seam'
import { $toolInstallsVisible, gateInstallCard, installToolInstallPolicy } from './tool-installs'

const confirm = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/store/confirm', () => ({ confirm }))
vi.mock('@/store/setup-beat', async importOriginal => ({
  ...(await importOriginal<typeof SetupBeatStore>()),
  answerSetupBeat: vi.fn(() => true)
}))

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

const snapshot = (tools: string, features: Record<string, string> = {}): ClientConfigSnapshot => ({
  config: {
    ...bundled,
    features: { ...((bundled.features as Record<string, string>) ?? {}), ...features },
    managed: { ...(bundled.managed as object), tools }
  },
  configVersion: null,
  devOverridesActive: false,
  error: 'missing',
  role: null,
  source: 'bundled',
  verifiedAt: null
})

const record = vi.fn()
let uninstall: Array<() => void> = []

beforeEach(() => {
  record.mockReset()
  confirm.mockClear()
  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { policy: { record } }
  uninstall = [installFeaturePolicy(), installToolInstallPolicy()]
})

afterEach(() => {
  cleanup()
  uninstall.forEach(off => off())
  $clientConfig.set(null)
  $gateway.set(null)
  closePluginInstallRequest()
  $mcpInstallRequest.set(null)
  $setupBeatRequests.set({})
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

// Every JSON-RPC install call the slice lists, as the app (or Bot Mode, or the setup chat) sends it.
const RPC_CALLS: readonly (readonly [method: string, params: Record<string, unknown>, id: string])[] = [
  ['plugins.manage', { action: 'install', identifier: 'owner/repo' }, 'install:plugin'],
  ['plugins.manage', { action: 'install', catalog_name: 'kanban' }, 'install:plugin'],
  ['plugins.manage', { action: 'inspect', identifier: 'owner/repo' }, 'install:plugin'],
  ['plugins.manage', { action: 'update', name: 'x' }, 'install:plugin'],
  ['plugins.manage', { action: 'update_all' }, 'install:plugin'],
  ['plugins.manage', { action: 'auto_update', enable: true }, 'install:plugin'],
  ['plugins.manage', { action: 'remove', name: 'x' }, 'install:plugin'],
  ['plugins.manage', { action: 'install_desktop', identifier: 'owner/repo' }, 'install:desktop-plugin'],
  ['plugins.manage', { action: 'remove_desktop', name: 'x' }, 'install:desktop-plugin'],
  ['plugins.catalog.lookup', { name: 'kanban' }, 'install:plugin'],
  ['skills.manage', { action: 'install', query: 'official/x' }, 'install:skill-hub'],
  ['skills.manage', { action: 'search', query: 'x' }, 'install:skill-hub'],
  ['skills.manage', { action: 'browse' }, 'install:skill-hub'],
  ['skills.manage', { action: 'inspect', query: 'x' }, 'install:skill-hub'],
  ['mcp.servers.add', { name: 'linear', preset: 'linear' }, 'install:mcp-server'],
  ['mcp.servers.remove', { name: 'linear' }, 'install:mcp-server'],
  ['connectors.list', { owner: 'desktop' }, 'install:connector'],
  ['connectors.catalog', {}, 'install:connector'],
  ['connectors.connect', { slug: 'gmail' }, 'install:connector'],
  ['connectors.accounts', {}, 'install:connector'],
  ['connectors.accounts.remove', { connection_id: 'c' }, 'install:connector'],
  ['connectors.accounts.rename', { alias: 'a', connection_id: 'c' }, 'install:connector'],
  ['connectors.policy.get', {}, 'install:connector'],
  ['connectors.policy.set', { change: {} }, 'install:connector'],
  ['connectors.tools', { slug: 'gmail' }, 'install:connector'],
  ['connectors.operation.status', { op_id: 'o' }, 'install:connector'],
  ['connectors.operation.wake', { op_id: 'o' }, 'install:connector'],
  ['tools.configure', { action: 'enable', names: ['web'] }, 'install:toolsets']
]

const rpcLabel = ([method, params]: (typeof RPC_CALLS)[number]) =>
  params.action ? `${method} ${String(params.action)}` : method

function spyOnSend() {
  return vi.spyOn(Object.getPrototypeOf(HermesGateway.prototype), 'request').mockResolvedValue({ ok: true })
}

describe('JSON-RPC install calls', () => {
  test.each(RPC_CALLS.map(call => [rpcLabel(call), call] as const))(
    'enforce: %s is refused before it is sent, and recorded',
    async (_label, [method, params, id]) => {
      setClientConfigSnapshot(snapshot('enforce'))
      const sent = spyOnSend()

      await expect(new HermesGateway().request(method, params)).rejects.toBeInstanceOf(PolicyRefusedError)
      expect(sent).not.toHaveBeenCalled()
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'refused', id, kind: 'tool', mode: 'enforce', surface: 'rpc', target: method })
      )
      sent.mockRestore()
    }
  )

  test.each(RPC_CALLS.map(call => [rpcLabel(call), call] as const))(
    'report: %s is sent, and recorded as allowed_in_report',
    async (_label, [method, params, id]) => {
      setClientConfigSnapshot(snapshot('report'))
      const sent = spyOnSend()

      await expect(new HermesGateway().request(method, params)).resolves.toEqual({ ok: true })
      expect(sent).toHaveBeenCalledTimes(1)
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'allowed_in_report', id, kind: 'tool', mode: 'report' })
      )
      sent.mockRestore()
    }
  )

  test.each(RPC_CALLS.map(call => [rpcLabel(call), call] as const))(
    'off: %s is sent, and nothing is recorded',
    async (_label, [method, params]) => {
      setClientConfigSnapshot(snapshot('off'))
      const sent = spyOnSend()

      await expect(new HermesGateway().request(method, params)).resolves.toEqual({ ok: true })
      expect(record).not.toHaveBeenCalled()
      sent.mockRestore()
    }
  )

  test('a desktop plugin calling an install method through host.request is refused; Bot Mode on does not reopen it', async () => {
    setClientConfigSnapshot(snapshot('enforce', { S123: 'on' }))
    $gateway.set(new HermesGateway())
    const sent = spyOnSend()

    await expect(host.request('skills.manage', { action: 'install', query: 'x' })).rejects.toMatchObject({
      code: 'refused_by_policy',
      target: 'skills.manage'
    })
    await expect(host.request('mcp.servers.add', { name: 'x' })).rejects.toBeInstanceOf(PolicyRefusedError)
    await expect(host.request('skills.manage', { action: 'list' })).resolves.toEqual({ ok: true })
    expect(sent.mock.calls.map(([method, params]) => [method, (params as { action?: string }).action])).toEqual([
      ['skills.manage', 'list']
    ])
    sent.mockRestore()
  })

  test('reads and actions on what is already configured stay open under enforce', () => {
    setClientConfigSnapshot(snapshot('enforce'))

    const open: [string, Record<string, unknown>][] = [
      ['skills.manage', { action: 'list' }],
      ['plugins.manage', { action: 'list' }],
      ['plugins.manage', { action: 'presence', names: ['x'] }],
      ['plugins.manage', { action: 'settings', key: 'x', values: {} }],
      ['plugins.list', {}],
      ['mcp.servers.list', {}],
      ['mcp.servers.status', {}],
      ['mcp.servers.test', { name: 'x' }],
      ['mcp.catalog', {}],
      ['toolsets.list', {}]
    ]

    for (const [method, params] of open) {
      expect(() => assertRpcAllowed(method, params), method).not.toThrow()
    }

    expect(record).not.toHaveBeenCalled()
  })
})

describe('install dialogs and lookups the renderer opens', () => {
  const mcpParams = { config: btoa(JSON.stringify({ url: 'https://mcp.example.org/sse' })), name: 'example' }

  const openAll = async () => {
    openPluginInstallRequest({ repo: 'owner/repo' })
    requestMcpInstallFromDeepLink(mcpParams)
    await requestSkillInstallFromDeepLink('official/x')
    const request = vi.fn(async () => ({ entry: { name: 'kanban', repo: 'o/r' }, status: 'found' }))
    const fetchImpl = vi.fn()
    const lookup = await lookupPluginCatalogEntry('kanban', { fetchImpl, request })

    return { fetchImpl, lookup, request }
  }

  test('enforce: none opens, nothing reaches the backend or the Nous-hosted feed, each refusal is recorded', async () => {
    setClientConfigSnapshot(snapshot('enforce'))
    const { fetchImpl, lookup, request } = await openAll()

    expect($pluginInstallRequest.get()).toBeNull()
    expect($mcpInstallRequest.get()).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
    expect(lookup).toEqual({ error: 'unavailable', ok: false })
    expect(request).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(record.mock.calls.map(([decision]) => [decision.id, decision.action, decision.surface])).toEqual([
      ['install:plugin', 'refused', 'ui'],
      ['install:mcp-server', 'refused', 'ui'],
      ['install:skill-hub', 'refused', 'ui'],
      ['install:plugin', 'refused', 'ui']
    ])
  })

  test('report: each opens (the user still confirms), and each use is recorded', async () => {
    setClientConfigSnapshot(snapshot('report'))
    const { lookup } = await openAll()

    expect($pluginInstallRequest.get()).toMatchObject({ repo: 'owner/repo' })
    expect($mcpInstallRequest.get()).not.toBeNull()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(lookup).toMatchObject({ ok: true })
    expect(record.mock.calls.map(([decision]) => decision.action)).toEqual(Array(4).fill('allowed_in_report'))
  })

  test('off: stock', async () => {
    setClientConfigSnapshot(snapshot('off'))
    await openAll()

    expect($pluginInstallRequest.get()).not.toBeNull()
    expect($mcpInstallRequest.get()).not.toBeNull()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(record).not.toHaveBeenCalled()
  })

  test('the stock variant is untouched by managed.tools', async () => {
    setClientConfigSnapshot({ ...snapshot('enforce'), variant: 'stock' })
    await openAll()

    expect($pluginInstallRequest.get()).not.toBeNull()
    expect($toolInstallsVisible.get()).toBe(true)
  })
})

describe('in-chat install cards and setup beats', () => {
  const view: SessionView = { ...PRIMARY_SESSION_VIEW, $runtimeId: atom('beat-session'), $storedId: atom('stored') }

  function renderBeat(beat: 'connectors' | 'plugins') {
    parkSetupBeat({
      beat,
      card: { plugins: ['kanban'], suggested: [] },
      question: 'Add some?',
      requestId: 'r1',
      sessionId: 'beat-session',
      toolCallId: 'call-1'
    })

    const row = { args: {}, result: undefined, toolCallId: 'call-1', toolName: 'setup_beat' } as ToolCallMessagePartProps

    return render(
      <I18nProvider configClient={null} initialLocale="en">
        <SessionViewProvider value={view}>
          <SetupBeatTool {...row} />
        </SessionViewProvider>
      </I18nProvider>
    )
  }

  test('enforce: the plugins beat shows no card and answers "nothing installed"', () => {
    setClientConfigSnapshot(snapshot('enforce'))
    vi.mocked(answerSetupBeat).mockClear()
    const { container } = renderBeat('plugins')

    expect(container.querySelector('[data-setup-beat="plugins"]')).toBeNull()
    expect(answerSetupBeat).toHaveBeenCalledWith('beat-session', { installed: [], label: '' })
  })

  test('enforce: the connectors beat shows no directory and answers "nothing connected"', () => {
    setClientConfigSnapshot(snapshot('enforce'))
    vi.mocked(answerSetupBeat).mockClear()
    const { container } = renderBeat('connectors')

    expect(container.querySelector('[data-setup-beat="connectors"]')).toBeNull()
    expect(answerSetupBeat).toHaveBeenCalledWith('beat-session', { connected: [], newly_connected: [] })
  })

  test.each([
    ['enforce', 'plain row'],
    ['report', 'install card'],
    ['off', 'install card']
  ])('%s: a gated install card renders the %s', (mode, shown) => {
    setClientConfigSnapshot(snapshot(mode))

    const Gated = gateInstallCard(
      () => <span>install card</span>,
      () => <span>plain row</span>
    )

    render(<Gated />)
    expect(screen.getByText(shown)).not.toBeNull()
  })

  test('manage_catalog and manage_connections go through the gate in the transcript', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../../components/assistant-ui/thread/message-parts.tsx'),
      'utf8'
    )

    expect(source).toMatch(/manage_catalog: gateInstallCard<TimelineToolCallProps>\(CatalogInstallTool, ToolFallback\)/)
    expect(source).toMatch(
      /manage_connections: gateInstallCard<TimelineToolCallProps>\(ConnectionsToolPart, ToolFallback\)/
    )
  })
})
