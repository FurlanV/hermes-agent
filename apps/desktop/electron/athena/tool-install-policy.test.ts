// F02 slice 29, main half: while managed.tools is enforce, every REST, IPC and deep-link way to add a skill, plugin,
// connector or MCP server is refused in Electron main and recorded with kind "tool"; under report each goes through
// and is recorded as allowed_in_report; under off nothing is refused or recorded. A feature row turned on (Bot Mode,
// S123) does not reopen them. The renderer half (JSON-RPC, dialogs, cards, the disk plugin loader) is
// src/athena/managed/tool-installs.test.tsx.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { deepLinkEntries } from './app-locations'
import { ipcEntries, restEntries, rpcEntries } from './backend-policy'
import { callForEntry } from './backend-surfaces.test-helper'
import { BUNDLED_DEFAULT_CONFIG } from './bundled-config-data'
import { applyMainPolicies, configureMainPolicies } from './main-policy'
import { PolicyDecisionLog } from './policy-decisions'
import {
  deepLinkAllowed,
  type DeepLinkInfo,
  guardedIpcMain,
  installIpcPolicyGuard,
  refuseRestRequest,
  resetIpcTrackingForTests,
  setMainPolicySeams,
  trackedIpcChannels
} from './policy-seams'
import {
  backendDecider,
  isToolInstallIpcChannel,
  TOOL_INSTALL_ROWS,
  toolInstallDecider,
  toolInstallRowFor
} from './tool-install-policy'

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

const config = (tools?: string, features: Record<string, string> = {}, featuresMode?: string) => ({
  ...bundled,
  features: { ...((bundled.features as Record<string, string>) ?? {}), ...features },
  managed: { ...(bundled.managed as object), ...(tools ? { tools } : {}), ...(featuresMode ? { features: featuresMode } : {}) }
})

let dir: string
let log: PolicyDecisionLog

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'athena-tool-installs-'))
  log = new PolicyDecisionLog({ coalesceMs: 0, file: path.join(dir, 'policy-decisions.jsonl') })
  configureMainPolicies({ decisions: log })
})

afterEach(() => {
  setMainPolicySeams(null)
  resetIpcTrackingForTests()
  configureMainPolicies({})
  rmSync(dir, { force: true, recursive: true })
})

const lines = (): Record<string, unknown>[] => {
  try {
    return readFileSync(log.file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** `hermes://kind/name?…` parsed the way main's handleDeepLink does. */
function deepLink(url: string): DeepLinkInfo {
  const parsed = new URL(url)
  const params: Record<string, string> = {}
  parsed.searchParams.forEach((value, key) => {
    params[key] = value
  })

  return { kind: parsed.hostname, name: decodeURIComponent(parsed.pathname.replace(/^\//, '')), params }
}

// Every install call the slice lists that reaches Electron main, as the app (or a page, or the OS) sends it.
type MainCall =
  | { id: string; kind: 'deep-link'; url: string }
  | { body?: unknown; id: string; kind: 'rest'; method: string; path: string }
  | { channel: string; id: string; kind: 'ipc' }

const MAIN_CALLS: readonly MainCall[] = [
  // Skill hub install, scan and update (and the rest of the hub).
  { body: { identifier: 'official/x' }, id: 'install:skill-hub', kind: 'rest', method: 'POST', path: '/api/skills/hub/install' },
  { id: 'install:skill-hub', kind: 'rest', method: 'GET', path: '/api/skills/hub/scan?identifier=official%2Fx' },
  { body: {}, id: 'install:skill-hub', kind: 'rest', method: 'POST', path: '/api/skills/hub/update' },
  { body: { name: 'x' }, id: 'install:skill-hub', kind: 'rest', method: 'POST', path: '/api/skills/hub/uninstall' },
  { id: 'install:skill-hub', kind: 'rest', method: 'GET', path: '/api/skills/hub/search?q=x&source=all&limit=20' },
  { id: 'install:skill-hub', kind: 'rest', method: 'GET', path: '/api/skills/hub/preview?identifier=x' },
  { id: 'install:skill-hub', kind: 'rest', method: 'GET', path: '/api/skills/hub/official' },
  { id: 'install:skill-hub', kind: 'rest', method: 'GET', path: '/api/skills/hub/sources' },
  { body: { name: 'x', content: '---' }, id: 'install:skill-write', kind: 'rest', method: 'POST', path: '/api/skills' },
  { body: { name: 'x', content: '---' }, id: 'install:skill-write', kind: 'rest', method: 'PUT', path: '/api/skills/content' },
  // MCP server writes and catalog install.
  { body: { name: 'x', url: 'https://x' }, id: 'install:mcp-server', kind: 'rest', method: 'POST', path: '/api/mcp/servers' },
  { body: { servers: { x: {} } }, id: 'install:mcp-server', kind: 'rest', method: 'PUT', path: '/api/mcp/servers' },
  { body: { enabled: true }, id: 'install:mcp-server', kind: 'rest', method: 'PUT', path: '/api/mcp/servers/x/enabled' },
  { id: 'install:mcp-server', kind: 'rest', method: 'DELETE', path: '/api/mcp/servers/x' },
  { body: { name: 'x', env: {}, enable: true }, id: 'install:mcp-server', kind: 'rest', method: 'POST', path: '/api/mcp/catalog/install' },
  // The raw config endpoint.
  { body: { yaml_text: 'mcp_servers: {}' }, id: 'install:raw-config', kind: 'rest', method: 'PUT', path: '/api/config/raw' },
  // Toolsets (S71's writes).
  { body: { enabled: true }, id: 'install:toolsets', kind: 'rest', method: 'PUT', path: '/api/tools/toolsets/web' },
  { body: {}, id: 'install:toolsets', kind: 'rest', method: 'POST', path: '/api/tools/toolsets/browser/post-setup' },
  // The desktop-plugin probe and install channels (and remove).
  { channel: 'hermes:plugin:probe', id: 'install:desktop-plugin', kind: 'ipc' },
  { channel: 'hermes:plugin:installDesktop', id: 'install:desktop-plugin', kind: 'ipc' },
  { channel: 'hermes:plugin:removeDesktop', id: 'install:desktop-plugin', kind: 'ipc' },
  // Deep links: mcp/install, plugin*, skill/install, and the hosted-connector return.
  { id: 'install:mcp-server', kind: 'deep-link', url: 'hermes://mcp/install?config=eyJuYW1lIjoieCJ9' },
  { id: 'install:plugin', kind: 'deep-link', url: 'hermes://plugin/install?repo=owner/repo' },
  { id: 'install:plugin', kind: 'deep-link', url: 'hermes://plugin/install?catalog=kanban' },
  { id: 'install:plugin', kind: 'deep-link', url: 'hermes://plugin-agent/owner/repo' },
  { id: 'install:desktop-plugin', kind: 'deep-link', url: 'hermes://plugin-desktop/owner/repo' },
  { id: 'install:skill-hub', kind: 'deep-link', url: 'hermes://skill/install?identifier=official/x' },
  { id: 'install:plugin', kind: 'deep-link', url: 'hermes://install/owner/repo' },
  { id: 'install:connector', kind: 'deep-link', url: 'hermes://connections/done?op=op1&status=ok' }
]

const label = (call: MainCall) =>
  call.kind === 'rest' ? `rest ${call.method} ${call.path}` : call.kind === 'ipc' ? `ipc ${call.channel}` : `deep-link ${call.url}`

/** Send one call through main's seams; true when it went through. IPC: whether the channel is registered. */
function send(call: MainCall): boolean {
  if (call.kind === 'rest') {
    return refuseRestRequest({ body: call.body, method: call.method, path: call.path }) === null
  }

  if (call.kind === 'deep-link') {
    return deepLinkAllowed(deepLink(call.url))
  }

  return trackedIpcChannels().find(entry => entry.channel === call.channel)?.registered ?? false
}

/** Register the install channels the way fs-ipc.ts does (probe, installDesktop) and as a plain handle (removeDesktop). */
function registerInstallChannels() {
  const raw = { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() }
  const ipc = { ...raw }
  installIpcPolicyGuard(ipc as never, isToolInstallIpcChannel)
  const guarded = guardedIpcMain(ipc as never)
  guarded.handle('hermes:plugin:probe', () => ({}))
  guarded.handle('hermes:plugin:installDesktop', () => ({}))
  ;(ipc as unknown as { handle: (channel: string, listener: () => unknown) => void }).handle(
    'hermes:plugin:removeDesktop',
    () => ({})
  )

  return raw
}

describe('managed.tools: every install call reaching main', () => {
  test('each call reaches the row it is listed under', () => {
    for (const call of MAIN_CALLS) {
      const entries =
        call.kind === 'rest'
          ? restEntries({ method: call.method, pathname: call.path.split('?')[0] })
          : call.kind === 'ipc'
            ? ipcEntries(call.channel)
            : deepLinkEntries(deepLink(call.url))

      expect(entries.map(toolInstallRowFor).find(Boolean)?.id, label(call)).toBe(call.id)
    }
  })

  test.each(MAIN_CALLS.map(call => [label(call), call] as const))('enforce refuses and records %s', (_label, call) => {
    applyMainPolicies({ config: config('enforce') })

    if (call.kind === 'ipc') {
      registerInstallChannels()
    }

    expect(send(call)).toBe(false)

    if (call.kind !== 'ipc') {
      // Registration is not a use: nothing is recorded for a channel that is simply not there.
      expect(lines()).toEqual([
        expect.objectContaining({ action: 'refused', id: call.id, kind: 'tool', mode: 'enforce', source: 'desktop' })
      ])
    }
  })

  test.each(MAIN_CALLS.map(call => [label(call), call] as const))(
    'report lets %s through and records it',
    (_label, call) => {
      applyMainPolicies({ config: config('report') })

      if (call.kind === 'ipc') {
        // Registered; each invoke is recorded (next test).
        registerInstallChannels()
        expect(send(call)).toBe(true)
      } else {
        expect(send(call)).toBe(true)
        expect(lines()).toEqual([
          expect.objectContaining({ action: 'allowed_in_report', id: call.id, kind: 'tool', mode: 'report' })
        ])
      }
    }
  )

  test.each(MAIN_CALLS.map(call => [label(call), call] as const))('off is stock: %s goes through', (_label, call) => {
    applyMainPolicies({ config: config('off') })

    if (call.kind === 'ipc') {
      registerInstallChannels()
    }

    expect(send(call)).toBe(true)
    expect(lines()).toEqual([])
  })

  test('a report-mode invoke of an install channel is recorded', async () => {
    applyMainPolicies({ config: config('report') })
    const ipc = registerInstallChannels()
    const [, listener] = ipc.handle.mock.calls.find(([channel]) => channel === 'hermes:plugin:probe')!

    await listener({}, { repo: 'owner/repo' })

    expect(lines()).toEqual([
      expect.objectContaining({ action: 'allowed_in_report', id: 'install:desktop-plugin', kind: 'tool', surface: 'ipc' })
    ])
  })

  test('install channels unregister under enforce and come back with the next snapshot under off', () => {
    applyMainPolicies({ config: config('enforce') })
    registerInstallChannels()
    expect(trackedIpcChannels().every(entry => !entry.registered)).toBe(true)

    applyMainPolicies({ config: config('off') })
    expect(trackedIpcChannels().map(entry => entry.registered)).toEqual([true, true, true])

    applyMainPolicies({ config: config('enforce') })
    expect(trackedIpcChannels().every(entry => !entry.registered)).toBe(true)
  })

  test('profile import is refused while S122 is off (a feature row, not managed.tools), and opens with S122 on', () => {
    const importCall = { method: 'POST', path: '/api/profiles/import' }

    applyMainPolicies({ config: config('off') })
    expect(refuseRestRequest(importCall)).not.toBeNull()
    expect(lines()).toEqual([expect.objectContaining({ action: 'refused', id: 'S122', kind: 'feature' })])

    applyMainPolicies({ config: config('enforce', { S122: 'on' }) })
    expect(refuseRestRequest(importCall)).toBeNull()

    applyMainPolicies({ config: config('enforce', {}, 'report') })
    expect(refuseRestRequest(importCall)).toBeNull()
    expect(lines().at(-1)).toMatchObject({ action: 'allowed_in_report', id: 'S122', kind: 'feature' })
  })

  test('Bot Mode on (S123) and features off do not reopen install paths', () => {
    applyMainPolicies({ config: config('enforce', { S123: 'on' }, 'off') })

    for (const call of MAIN_CALLS.filter(each => each.kind !== 'ipc')) {
      expect(send(call), label(call)).toBe(false)
    }
  })

  test('reads and ordinary writes stay open under enforce', () => {
    applyMainPolicies({ config: config('enforce') })

    const open = [
      { method: 'GET', path: '/api/skills' },
      { method: 'GET', path: '/api/skills/content?name=x' },
      { body: { name: 'x', enabled: false }, method: 'PUT', path: '/api/skills/toggle' },
      { method: 'GET', path: '/api/mcp/servers' },
      { method: 'GET', path: '/api/mcp/catalog' },
      { method: 'POST', path: '/api/mcp/servers/x/test' },
      { method: 'GET', path: '/api/config/raw' },
      { body: { config: { display: { personality: 'x' } } }, method: 'PUT', path: '/api/config' },
      { method: 'GET', path: '/api/tools/toolsets' },
      { method: 'DELETE', path: '/api/learning/node' }
    ]

    for (const call of open) {
      expect(refuseRestRequest(call), `${call.method} ${call.path}`).toBeNull()
    }

    expect(deepLinkAllowed(deepLink('hermes://open/capabilities'))).toBe(true)
    expect(lines()).toEqual([])
  })
})

describe('the tools deny table', () => {
  test('every backend entry of every row reaches its row, and its call is refused under enforce', () => {
    const decide = toolInstallDecider(config('enforce'))

    for (const row of TOOL_INSTALL_ROWS) {
      for (const entry of row.entries) {
        const call = callForEntry(entry.replace(/\{\}/g, 'athena-probe'))

        if (!call) {
          expect(entry, `${row.id}: unknown kind`).toMatch(/^(deep-link|ui|desktop-plugin):/)

          continue
        }

        const entries =
          call.kind === 'rest'
            ? restEntries({ method: call.method, pathname: call.path })
            : call.kind === 'rpc'
              ? rpcEntries(call.method, call.params)
              : call.kind === 'ipc'
                ? ipcEntries(call.channel)
                : []

        expect(entries.map(toolInstallRowFor).find(Boolean)?.id, `${row.id} ${entry}`).toBe(row.id)
        expect(decide(entries, call.kind, entry).allowed, `${row.id} ${entry}`).toBe(false)
      }
    }
  })

  test('`{}` is one path segment and a trailing `*` any rest', () => {
    expect(toolInstallRowFor('rest:PUT /api/tools/toolsets/web')?.id).toBe('install:toolsets')
    expect(toolInstallRowFor('rest:PUT /api/tools/toolsets/web/model')).toBeNull()
    expect(toolInstallRowFor('rest:DELETE /api/mcp/servers/a/b')).toBeNull()
    expect(toolInstallRowFor('rpc:connectors.accounts.remove')?.id).toBe('install:connector')
    expect(toolInstallRowFor('rpc:skills.manage/list')).toBeNull()
    expect(toolInstallRowFor('rpc:plugins.manage/list')).toBeNull()
  })

  test('the backend decider: a feature refusal wins, then a tool refusal; report keeps the first record', () => {
    // Scheduled jobs (S113) is a disabled feature; the skills hub is an install path.
    const cron = rpcEntries('cron.manage', { action: 'list' })
    const both = backendDecider(config('enforce'))
    expect(both(cron, 'rpc', 'cron.manage').record).toMatchObject({ action: 'refused', id: 'S113' })
    expect(both(rpcEntries('skills.manage', { action: 'install' }), 'rpc', 'skills.manage').record).toMatchObject({
      id: 'install:skill-hub',
      kind: 'tool'
    })

    const report = backendDecider(config('report', {}, 'report'))
    expect(report(cron, 'rpc', 'cron.manage')).toMatchObject({
      allowed: true,
      record: { action: 'allowed_in_report', id: 'S113' }
    })
    expect(report(rpcEntries('skills.manage', { action: 'install' }), 'rpc', 'x')).toMatchObject({
      allowed: true,
      record: { action: 'allowed_in_report', kind: 'tool' }
    })
  })

  test('main.ts loads the IPC guard that tracks install channels first', () => {
    const guard = readFileSync(path.join(import.meta.dirname, 'ipc-guard-install.ts'), 'utf8')
    const main = readFileSync(path.join(import.meta.dirname, '..', 'main.ts'), 'utf8')

    expect(guard).toMatch(/isToolInstallIpcChannel\(channel\)/)
    expect(main.split('\n').find(line => line.startsWith('import '))).toBe("import './athena/ipc-guard-install'")
  })
})
