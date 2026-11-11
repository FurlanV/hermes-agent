/**
 * Connect a package's MCP server as soon as it is switched on (F03 slice 07 follow-up).
 *
 * Switching a `gateway` or `mcp` package on makes Electron main run `athena config tool <id> on`, which pins its
 * `mcp_servers` entry in managed scope. A running gateway daemon only connects a newly pinned server on `reload.mcp`
 * (hermes:gateway/session_ancillary.py:308, `confirm: true`) or at its next housekeeping tick (60 s, never the
 * first), so the page sends `reload.mcp` itself, exactly as the stock MCP toggle does (`@/lib/mcp-reload`), and new
 * chats get the server at once. Switching off needs no reload: the guard vetoes the tools at once and the applier
 * drops the server from the next chat. A failed reload is not an error for the switch (the tick still connects it);
 * the card says so.
 */

import { announceMcpReload, reloadMcp } from '@/lib/mcp-reload'
import { $gateway } from '@/store/gateway'
import { $activeSessionId } from '@/store/session'

import type { CatalogEntry } from './catalog'

/** Kinds whose switch-on pins an `mcp_servers` entry. */
export const MCP_KINDS: ReadonlySet<CatalogEntry['kind']> = new Set(['gateway', 'mcp'])

export const needsMcpReload = (entry: Pick<CatalogEntry, 'kind'>, on: boolean): boolean =>
  on && MCP_KINDS.has(entry.kind)

export interface McpReloadDeps {
  gateway: Parameters<typeof reloadMcp>[0] | null
  reload: typeof reloadMcp
  announce: typeof announceMcpReload
  sessionId: null | string
}

const liveDeps = (): McpReloadDeps => ({
  announce: announceMcpReload,
  gateway: $gateway.get(),
  reload: reloadMcp,
  sessionId: $activeSessionId.get()
})

/**
 * Send `reload.mcp` after a package was switched on; true when the daemon took it. Never throws: without a gateway
 * connection, or when the RPC fails, the server connects at the daemon's next housekeeping tick.
 */
export async function reloadPackageServers(deps: McpReloadDeps = liveDeps()): Promise<boolean> {
  if (!deps.gateway) {
    return false
  }

  try {
    deps.announce(await deps.reload(deps.gateway, deps.sessionId))

    return true
  } catch {
    return false
  }
}
