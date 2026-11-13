// Athena HPC bridge: what main tells the renderer about it (F05 slice 06). No runtime imports, so the renderer and
// the sandboxed preload can use these.

/**
 * - `off`: the bridge is not wanted. `reason`: `feature_off` (row F05), `switch_off` (`local_models.enabled`),
 *   `not_configured` (the config names no login host or model server), `disconnected` (the user disconnected).
 * - `no_key`: no SSH key is installed for this laptop yet (`reason: key_unreadable` when one is, but cannot be
 *   used). Nothing connects until there is one.
 * - `host_key_unknown`: the build pins no host key for the login host, so it is never contacted.
 * - `connecting`: the first attempt after a start, a wake or a request to connect.
 * - `connected`: the forward is up on `port`, and the Profile's bridge record says so.
 * - `down`: not connected; retried by itself except after `auth_failed`. `reason`: `host_key_mismatch` (the host
 *   answered with a key that is not pinned; nothing was sent to it), `auth_failed` (the login host refused the key),
 *   `unreachable`, `timeout`, `connection_lost`, `local_port_unavailable`, `ssh_unavailable` (a broken build: not retried).
 */
export type HpcBridgeState = 'connected' | 'connecting' | 'down' | 'host_key_unknown' | 'no_key' | 'off'

export interface HpcBridgeStatus {
  /** The forward's loopback port, while connected. */
  port?: number
  /** A stable word for why (see `HpcBridgeState`); absent when the state says it all. */
  reason?: string
  /** When the state (or its reason) last changed, ISO 8601. */
  since: string
  state: HpcBridgeState
}

/** `window.athenaDesktop.hpcBridge` (preload-bridge.ts). Every call is refused while feature row F05 is off. */
export interface AthenaHpcBridgeApi {
  connect: () => Promise<HpcBridgeStatus>
  disconnect: () => Promise<HpcBridgeStatus>
  onChanged: (callback: (status: HpcBridgeStatus) => void) => () => void
  status: () => Promise<HpcBridgeStatus>
}

export const HPC_BRIDGE_CHANNELS = Object.freeze({
  /** main → every window: each new status. */
  changed: 'athena:hpc-bridge:changed',
  connect: 'athena:hpc-bridge:connect',
  disconnect: 'athena:hpc-bridge:disconnect',
  status: 'athena:hpc-bridge:status'
} as const)
