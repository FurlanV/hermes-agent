// Switching a gateway or mcp package on sends hermes's `reload.mcp` (confirm: true) so the running daemon connects
// the newly pinned server for new chats, instead of waiting for its 60 s housekeeping tick (F03 slice 07 follow-up).
// The answer names the packages whose server did not connect (R01 slice 27).
import { JsonRpcGatewayError } from '@hermes/shared'
import { describe, expect, test, vi } from 'vitest'

import { type McpReloadDeps, needsMcpReload, packageServerName, refusedServers, reloadPackageServers } from './mcp-reload'

vi.mock('@/lib/mcp-reload', () => ({ announceMcpReload: vi.fn(), reloadMcp: vi.fn() }))

const PACKAGES = ['eagle-asd-evidence', 'eagle-curator', 'stub-echo']

function deps(overrides: Partial<McpReloadDeps> = {}): McpReloadDeps {
  return {
    announce: vi.fn(),
    gateway: { request: vi.fn() },
    reload: vi.fn(async () => ({ deferred: false, sessionServers: ['stub_echo'], unavailable: [] })),
    sessionId: 'session-1',
    ...overrides
  }
}

const refusal = (data: unknown) => new JsonRpcGatewayError('mcp_servers_unavailable', { code: 4001, data })

describe('reload.mcp after a package switch', () => {
  test('only switching a gateway or mcp package on needs a reload', () => {
    expect(needsMcpReload({ kind: 'gateway' }, true)).toBe(true)
    expect(needsMcpReload({ kind: 'mcp' }, true)).toBe(true)
    expect(needsMcpReload({ kind: 'gateway' }, false)).toBe(false) // off: the guard vetoes at once
    expect(needsMcpReload({ kind: 'toolset' }, true)).toBe(false)
    expect(needsMcpReload({ kind: 'skill' }, true)).toBe(false)
  })

  test('a package is pinned under its id with underscores', () => {
    expect(packageServerName('eagle-asd-evidence')).toBe('eagle_asd_evidence')
  })

  test('sends reload.mcp on the active gateway for the active chat; the notice leaves the package servers out', async () => {
    const d = deps()
    expect(await reloadPackageServers(PACKAGES, d)).toEqual({ sent: true, unreachable: [] })
    expect(d.reload).toHaveBeenCalledWith(d.gateway, 'session-1')
    expect(d.announce).toHaveBeenCalledWith({ deferred: false, sessionServers: ['stub_echo'], unavailable: [] }, [
      'eagle_asd_evidence',
      'eagle_curator',
      'stub_echo'
    ])
  })

  test('servers that did not connect beside a reload that took effect are named by package id', async () => {
    const d = deps({
      reload: vi.fn(async () => ({ deferred: false, sessionServers: [], unavailable: ['eagle_curator', 'someone_elses'] }))
    })

    expect(await reloadPackageServers(PACKAGES, d)).toEqual({ sent: true, unreachable: ['eagle-curator'] })
  })

  test('a reload refused because servers did not connect names them from the refusal', async () => {
    const error = refusal({
      detail: 'did not connect: eagle_asd_evidence, eagle_curator',
      field: 'mcp_servers',
      reason: 'mcp_servers_unavailable'
    })

    const d = deps({ reload: vi.fn(async () => Promise.reject(error)) })

    expect(refusedServers(error)).toEqual(['eagle_asd_evidence', 'eagle_curator'])
    expect(await reloadPackageServers(PACKAGES, d)).toEqual({
      sent: true,
      unreachable: ['eagle-asd-evidence', 'eagle-curator']
    })
    expect(d.announce).not.toHaveBeenCalled()
  })

  test('a refusal that does not say which servers: unreachable is unknown (null)', async () => {
    const error = refusal({ reason: 'mcp_servers_unavailable' })

    expect(refusedServers(error)).toBeNull()
    expect(await reloadPackageServers(PACKAGES, deps({ reload: vi.fn(async () => Promise.reject(error)) }))).toEqual({
      sent: true,
      unreachable: null
    })
  })

  test('without a gateway connection, or when the RPC fails otherwise, nothing was sent and it never throws', async () => {
    expect(await reloadPackageServers(PACKAGES, deps({ gateway: null }))).toEqual({ sent: false, unreachable: [] })
    const failing = deps({ reload: vi.fn(async () => Promise.reject(new Error('socket closed'))) })
    expect(await reloadPackageServers(PACKAGES, failing)).toEqual({ sent: false, unreachable: [] })
    expect(failing.announce).not.toHaveBeenCalled()
    const other = deps({ reload: vi.fn(async () => Promise.reject(refusal({ reason: 'permission_denied' }))) })
    expect(await reloadPackageServers(PACKAGES, other)).toEqual({ sent: false, unreachable: [] })
  })
})
