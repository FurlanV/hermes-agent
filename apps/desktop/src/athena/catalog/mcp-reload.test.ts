// Switching a gateway or mcp package on sends hermes's `reload.mcp` (confirm: true) so the running daemon connects
// the newly pinned server for new chats, instead of waiting for its 60 s housekeeping tick (F03 slice 07 follow-up).
import { describe, expect, test, vi } from 'vitest'

import { type McpReloadDeps, needsMcpReload, reloadPackageServers } from './mcp-reload'

vi.mock('@/lib/mcp-reload', () => ({ announceMcpReload: vi.fn(), reloadMcp: vi.fn() }))

function deps(overrides: Partial<McpReloadDeps> = {}): McpReloadDeps {
  return {
    announce: vi.fn(),
    gateway: { request: vi.fn() },
    reload: vi.fn(async () => ({ deferred: false, sessionServers: ['stub_echo'], unavailable: [] })),
    sessionId: 'session-1',
    ...overrides
  }
}

describe('reload.mcp after a package switch', () => {
  test('only switching a gateway or mcp package on needs a reload', () => {
    expect(needsMcpReload({ kind: 'gateway' }, true)).toBe(true)
    expect(needsMcpReload({ kind: 'mcp' }, true)).toBe(true)
    expect(needsMcpReload({ kind: 'gateway' }, false)).toBe(false) // off: the guard vetoes at once
    expect(needsMcpReload({ kind: 'toolset' }, true)).toBe(false)
    expect(needsMcpReload({ kind: 'skill' }, true)).toBe(false)
  })

  test('sends reload.mcp on the active gateway for the active chat and announces what did not apply', async () => {
    const d = deps()
    expect(await reloadPackageServers(d)).toBe(true)
    expect(d.reload).toHaveBeenCalledWith(d.gateway, 'session-1')
    expect(d.announce).toHaveBeenCalledWith({ deferred: false, sessionServers: ['stub_echo'], unavailable: [] })
  })

  test('without a gateway connection, or when the RPC fails, it reports false and never throws', async () => {
    expect(await reloadPackageServers(deps({ gateway: null }))).toBe(false)
    const failing = deps({ reload: vi.fn(async () => Promise.reject(new Error('socket closed'))) })
    expect(await reloadPackageServers(failing)).toBe(false)
    expect(failing.announce).not.toHaveBeenCalled()
  })
})
