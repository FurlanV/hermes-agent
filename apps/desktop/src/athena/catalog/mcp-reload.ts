/**
 * Connect a package's MCP server as soon as it is switched on (F03 slice 07 follow-up).
 *
 * Switching a `gateway` or `mcp` package on makes Electron main run `athena config tool <id> on`, which pins its
 * `mcp_servers` entry in managed scope. A running gateway daemon only connects a newly pinned server on `reload.mcp`
 * (hermes:gateway/session_ancillary.py:308, `confirm: true`) or at its next housekeeping tick (60 s, never the
 * first), so the page sends `reload.mcp` itself, exactly as the stock MCP toggle does (`@/lib/mcp-reload`), and new
 * chats get the server at once. Switching off needs no reload: the guard vetoes the tools at once and the applier
 * drops the server from the next chat.
 *
 * The daemon also says which servers did not connect (R01 slice 27). A package whose upstream is down is parked by
 * hermes, which tries it again by itself every five minutes (hermes:tools/mcp_tool.py `_PARKED_RETRY_INTERVAL`), so
 * the switch is not an error; the card says the package is not connected and offers to check again. Hermes reports a
 * revived server as connected only once it has stayed healthy for a few minutes, so a check soon after the upstream
 * came back can still say "not connected" while new chats already have the tools.
 */

import { JsonRpcGatewayError } from '@hermes/shared'

import { announceMcpReload, reloadMcp } from '@/lib/mcp-reload'
import { $gateway } from '@/store/gateway'
import { $activeSessionId } from '@/store/session'

import type { CatalogEntry } from './catalog'

/** Kinds whose switch-on pins an `mcp_servers` entry. */
export const MCP_KINDS: ReadonlySet<CatalogEntry['kind']> = new Set(['gateway', 'mcp'])

export const needsMcpReload = (entry: Pick<CatalogEntry, 'kind'>, on: boolean): boolean =>
  on && MCP_KINDS.has(entry.kind)

/** The `mcp_servers` name the applier pins a package under (athena: athena_shipper/tool_pins.py). */
export const packageServerName = (id: string): string => id.replaceAll('-', '_')

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
 * What `reload.mcp` said about the catalog's packages.
 *
 * - `sent: false`: no gateway connection, or the RPC failed for another reason; the server connects at the daemon's
 *   next housekeeping tick.
 * - `unreachable`: the package ids whose server did not connect. `null` when the daemon refused the reload because
 *   servers did not connect but did not say which (the caller's own package is then the one to mark).
 */
export interface PackageReload {
  sent: boolean
  unreachable: null | string[]
}

const REFUSED_UNAVAILABLE = 'mcp_servers_unavailable'
const DID_NOT_CONNECT = 'did not connect:'

/** The server names of a `mcp_servers_unavailable` refusal (hermes:gateway/session_ancillary.py), or null. */
export function refusedServers(error: unknown): null | string[] | undefined {
  const data = error instanceof JsonRpcGatewayError ? (error.data as { detail?: unknown; reason?: unknown } | undefined) : undefined

  if (data?.reason !== REFUSED_UNAVAILABLE) {
    return undefined
  }

  const detail = typeof data.detail === 'string' ? data.detail : ''
  const at = detail.indexOf(DID_NOT_CONNECT)

  if (at < 0) {
    return null
  }

  return detail
    .slice(at + DID_NOT_CONNECT.length)
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
}

/**
 * Send `reload.mcp` after a package was switched on, or to check a package again. Never throws. `packageIds` are
 * the catalog's MCP packages: their servers are reported in the result, not in the stock "Did not connect" notice,
 * which would show the user a server name they never chose.
 */
export async function reloadPackageServers(
  packageIds: readonly string[] = [],
  deps: McpReloadDeps = liveDeps()
): Promise<PackageReload> {
  if (!deps.gateway) {
    return { sent: false, unreachable: [] }
  }

  const idOf = new Map(packageIds.map(id => [packageServerName(id), id]))
  const idsOf = (servers: readonly string[]) => servers.flatMap(name => idOf.get(name) ?? [])

  try {
    const outcome = await deps.reload(deps.gateway, deps.sessionId)

    deps.announce(outcome, [...idOf.keys()])

    return { sent: true, unreachable: idsOf(outcome.unavailable) }
  } catch (error) {
    const refused = refusedServers(error)

    if (refused === undefined) {
      return { sent: false, unreachable: [] }
    }

    return { sent: true, unreachable: refused === null ? null : idsOf(refused) }
  }
}
