// Athena HPC bridge: what main tells the renderer about it (F05 slices 06 and 07). No runtime imports, so the
// renderer and the sandboxed preload can use these.

/**
 * - `off`: the bridge is not wanted. `reason`: `feature_off` (row F05), `switch_off` (`local_models.enabled`),
 *   `not_configured` (the config names no login host or model server), `disconnected` (the user disconnected).
 * - `no_key`: main holds nothing to sign in with: no SSH key is configured for this laptop and no password was
 *   entered since the app started (`reason: key_unreadable` when a key is configured but cannot be used). Nothing
 *   connects until the user signs in (`connect` with a username and password).
 * - `host_key_unknown`: the build pins no host key for the login host, so it is never contacted.
 * - `connecting`: the first attempt after a start, a wake or a request to connect.
 * - `connected`: the connection to the login host is up. `servers` says which model servers answer through it; the
 *   Profile's bridge record lists those, and `port` is the default server's forward while that one is up.
 * - `down`: not connected; retried by itself except after `auth_failed`. `reason`: `host_key_mismatch` (the host
 *   answered with a key that is not pinned; nothing was sent to it), `auth_failed` (the login host refused the key
 *   or the password; a refused password is forgotten at once), `auth_unsupported` (the login host asks for something
 *   other than one password, a second factor for example: not retried, the password is forgotten), `unreachable`,
 *   `timeout`, `connection_lost`, `local_port_unavailable`, `ssh_unavailable` (a broken build: not retried).
 */
export type HpcBridgeState = 'connected' | 'connecting' | 'down' | 'host_key_unknown' | 'no_key' | 'off'

/**
 * One model server behind the bridge (F05 slice 12):
 * - `checking`: just connected, the login host has not said yet whether it reaches the server;
 * - `up`: its forward works, on `port`; its models are offered;
 * - `down`: its models are not offered. `reason`: `target_unreachable` (the login host does not reach it; asked
 *   again by itself) or `local_port_unavailable` (no loopback port could be opened for it).
 */
export type HpcBridgeServerState = 'checking' | 'down' | 'up'

export interface HpcBridgeServerStatus {
  /** The forward's loopback port, while the server is up. */
  port?: number
  reason?: string
  state: HpcBridgeServerState
}

/**
 * What main holds to sign in with now (F05 slice 07): a configured SSH key (it wins), the password the user entered
 * since the app started (memory only), or nothing. With `none` a connection needs the sign-in dialog.
 */
export type HpcBridgeCredential = 'key' | 'none' | 'password'

/** What the sign-in dialog sends, once: the HPC user name and password. Main keeps the password in memory only. */
export interface HpcBridgeSignIn {
  password: string
  username: string
}

export interface HpcBridgeStatus {
  /** What main holds to sign in with (absent from builds before slice 07: read as `none` unless connected). */
  credential?: HpcBridgeCredential
  /** The default model server's forward (its loopback port), while connected and that server is up. */
  port?: number
  /** A stable word for why (see `HpcBridgeState`); absent when the state says it all. */
  reason?: string
  /**
   * Each model server of the config by id (`default`: the one `local_models.target_host` names), while connected.
   * One server being down leaves the others up.
   */
  servers?: Record<string, HpcBridgeServerStatus>
  /** When the state (or its reason) last changed, ISO 8601. */
  since: string
  state: HpcBridgeState
  /**
   * The HPC user name of the password sign-in: the one in use, else the one remembered from the last sign-in
   * (`$HERMES_HOME/athena/hpc-bridge-user.json`). Not a secret. Absent when none is remembered.
   */
  username?: string
}

/** `window.athenaDesktop.hpcBridge` (preload-bridge.ts). Every call is refused while feature row F05 is off. */
export interface AthenaHpcBridgeApi {
  /**
   * Without an argument: connect with what main holds (answers once the attempt is under way). With a sign-in:
   * main keeps the password in memory, remembers the user name, and answers once the attempt has settled
   * (`connected`, or why not).
   */
  connect: (signIn?: HpcBridgeSignIn) => Promise<HpcBridgeStatus>
  /** Close the bridge and forget the password. */
  disconnect: () => Promise<HpcBridgeStatus>
  /** Forget the remembered user name (and so the sign-in: the bridge closes and the password is forgotten). */
  forgetUser: () => Promise<HpcBridgeStatus>
  onChanged: (callback: (status: HpcBridgeStatus) => void) => () => void
  status: () => Promise<HpcBridgeStatus>
}

export const HPC_BRIDGE_CHANNELS = Object.freeze({
  /** main → every window: each new status. */
  changed: 'athena:hpc-bridge:changed',
  connect: 'athena:hpc-bridge:connect',
  disconnect: 'athena:hpc-bridge:disconnect',
  forgetUser: 'athena:hpc-bridge:forget-user',
  status: 'athena:hpc-bridge:status'
} as const)
