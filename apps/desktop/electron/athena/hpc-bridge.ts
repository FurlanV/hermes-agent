// Athena: the HPC bridge (F05 slices 06, 07 and 12).
//
// The local model servers are on nodes only the user's laptop can reach, through the HPC login host. While local
// models are on, Electron main keeps one SSH connection to the login host of the client config
// (`local_models.login_host:login_port`) and forwards one loopback port per model server the config names: the
// default one (`target_host:target_port`) and each entry of `local_models.servers`:
//
//   hermes ──▶ 127.0.0.1:<port A> ──┐
//                                   ├─(one SSH connection, as the user)──▶ login host ──▶ model server A
//   hermes ──▶ 127.0.0.1:<port B> ──┘                                               └──▶ model server B
//
// - Each server has its own forward and its own state. After signing in, the bridge asks the login host for each
//   server once (a channel opened and closed; nothing is sent to the model server). A server that does not answer,
//   or whose loopback port cannot be opened, is `down` on its own and is asked for again on the retry backoff; the
//   others work meanwhile. A request that fails on a server that was up marks that server down the same way.
// - The bridge never sees a model server's API key: hermes sends it, from managed scope.
// - It runs only while feature row F05 is on, `local_models.enabled` is true, the config names the hosts, the build
//   pins a host key for the login host and main holds something to sign in with: a configured key
//   (hpc-bridge-keys.ts) or the password the user entered (hpc-bridge-user.ts). Otherwise nothing is contacted and
//   the status says why.
// - The login host's key is checked against the pinned ones before any authentication is sent. Another key ends
//   the connection there (`host_key_mismatch`). Nothing is ever trusted on first use.
// - Signing in (F05 slice 07): with a configured key, public-key authentication only, as before. Without one, the
//   user's HPC user name and password, entered once in the Desktop's dialog (`signIn`). The password is held in
//   main's memory for the app's run (`BridgePassword`), so a reconnect after a drop, a sleep or a network change
//   asks nothing. It is forgotten on quit, on Disconnect, when local models go off, and the moment the login host
//   refuses it; a refused password is sent once and never again. It is sent only after the host key matched a pin,
//   as `password` authentication, or as the answer to a `keyboard-interactive` request with exactly one hidden
//   prompt that asks for a password. Anything else the login host asks for (a second factor, a new password) ends
//   the sign-in with `auth_unsupported`. Nothing is written on the HPC. The user name is remembered for the next
//   launch (`hpc-bridge-user.json`); the password never reaches a file, a log line, a status or the record.
// - Every forward listens on 127.0.0.1 only. Each server's port is chosen once and kept in
//   `$HERMES_HOME/athena/hpc-bridge-port.json`, so the address hermes is pinned to is the same after every launch;
//   another port is taken only when that one is in use.
// - While a forward is up the Profile's bridge record lists it with its port (hpc-bridge-record.ts). The record is
//   removed the moment the connection is lost and written again when it is back, and rewritten when one server
//   comes or goes; `athena config apply` runs after each change so hermes's providers follow at once.
// - A lost connection is retried with a capped backoff (the cap keeps recovery within 30 s of the network
//   returning); keepalives notice a dead link; a wake from sleep reconnects at once.
// - Status over guarded IPC (`athena:hpc-bridge:status|connect|disconnect`, pushed on `athena:hpc-bridge:changed`).
//   The channels are feature row F05's, so they are not registered while the row is off.
//
// The SSH client is `ssh2` (MIT): plain JavaScript on node:crypto, bundled into main, no native addon. It is loaded
// on the first connection attempt, never at startup (`loadSsh2` says why).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import path from 'node:path'

import type { BrowserWindow, IpcMain } from 'electron'
import type * as Ssh2Module from 'ssh2'
import type { Client, ConnectConfig } from 'ssh2'

import type { AthenaClientConfig } from './client-config'
import { devOverridesFromEnv } from './client-config'
import type { ClientConfigSnapshot } from './client-config-types'
import { featureStates } from './feature-registry'
import {
  type BridgeKeyProvider,
  devBridgeKeyProvider,
  hostKeyFingerprint,
  type HostKeyPins,
  hostKeyTable,
  pinnedHostKeys
} from './hpc-bridge-keys'
import { DEFAULT_MODEL_SERVER, MODEL_SERVER_ID, removeBridgeRecord, writeBridgeRecord } from './hpc-bridge-record'
import {
  HPC_BRIDGE_CHANNELS,
  type HpcBridgeCredential,
  type HpcBridgeServerState,
  type HpcBridgeServerStatus,
  type HpcBridgeState,
  type HpcBridgeStatus
} from './hpc-bridge-types'
import {
  bridgePassword,
  BridgePassword,
  bridgeUsername,
  forgetBridgeUser,
  readBridgeUser,
  writeBridgeUser
} from './hpc-bridge-user'
import { onMainPoliciesChanged } from './main-policy'
import { LOCAL_MODELS_FEATURE } from './model-policy'
import { policyRefusalMessage } from './policy-seams'

export { HPC_BRIDGE_CHANNELS }
export type { HpcBridgeCredential, HpcBridgeServerState, HpcBridgeServerStatus, HpcBridgeState, HpcBridgeStatus }

export const BRIDGE_PORT_FILE = 'hpc-bridge-port.json'
export const BRIDGE_ADDRESS = '127.0.0.1'

// ── The SSH library ─────────────────────────────────────────────────────────

type Ssh2 = typeof Ssh2Module

let ssh2: null | Promise<Ssh2> = null

/**
 * Load ssh2 when the bridge first needs it. Main is bundled as one ES module, where CommonJS's `__dirname` does
 * not exist, and ssh2's Pageant agent (never used here) reads it while the module loads: imported at the top, it
 * would stop main at startup with a ReferenceError. An undeclared name is looked up on the global object, so the
 * name exists there for the moment of the load and is taken away again. `hpc-bridge-bundle.test.ts` loads a
 * bundle built like main's.
 */
export function loadSsh2(): Promise<Ssh2> {
  ssh2 ??= (async () => {
    const scope = globalThis as { __dirname?: string }
    const missing = !('__dirname' in scope)

    if (missing) {
      scope.__dirname = path.dirname(process.execPath)
    }

    try {
      const loaded = (await import('ssh2')) as Ssh2 & { default?: Ssh2 }

      // CommonJS seen through an ES import: the names are on the namespace, or only on its default.
      return typeof loaded.Client === 'function' ? loaded : (loaded.default ?? loaded)
    } finally {
      if (missing) {
        delete scope.__dirname
      }
    }
  })()

  return ssh2
}

// ── What the config asks for ────────────────────────────────────────────────

export interface BridgeTarget {
  loginHost: string
  loginPort: number
  targetHost: string
  targetPort: number
}

/** One model server behind the login host: its id in the config, and where the login host reaches it. */
export interface BridgeServer {
  host: string
  /** `default` for the server `target_host`/`target_port` name, else its key in `local_models.servers`. */
  id: string
  port: number
}

/** Everything the bridge opens: one connection to the login host, one forward per model server. */
export interface BridgePlan {
  loginHost: string
  loginPort: number
  servers: readonly BridgeServer[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const hostName = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const portNumber = (value: unknown): null | number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65535 ? value : null

const localModelsSection = (config: unknown): Record<string, unknown> =>
  isRecord(config) && isRecord(config.local_models) ? config.local_models : {}

const loginPortOf = (section: Record<string, unknown>): null | number =>
  section.login_port === undefined || section.login_port === null ? 22 : portNumber(section.login_port)

/** The login host and the default model server of the config's `local_models` section, or null without them all. */
export function bridgeTarget(config: unknown): BridgeTarget | null {
  const section = localModelsSection(config)
  const loginHost = hostName(section.login_host)
  const targetHost = hostName(section.target_host)
  const loginPort = loginPortOf(section)
  const targetPort = portNumber(section.target_port)

  return loginHost && targetHost && loginPort !== null && targetPort !== null
    ? { loginHost, loginPort, targetHost, targetPort }
    : null
}

/**
 * The login host and every model server the config names (F05 slice 12): the default one
 * (`target_host`/`target_port`) and each usable entry of `local_models.servers`. Null without a login host or
 * without any server. A server's API key is not read here: the bridge never sees one.
 */
export function bridgePlan(config: unknown): BridgePlan | null {
  const section = localModelsSection(config)
  const loginHost = hostName(section.login_host)
  const loginPort = loginPortOf(section)
  const servers: BridgeServer[] = []
  const targetHost = hostName(section.target_host)
  const targetPort = portNumber(section.target_port)

  if (targetHost && targetPort !== null) {
    servers.push({ host: targetHost, id: DEFAULT_MODEL_SERVER, port: targetPort })
  }

  for (const [id, spec] of Object.entries(isRecord(section.servers) ? section.servers : {})) {
    const host = isRecord(spec) ? hostName(spec.host) : ''
    const port = isRecord(spec) ? portNumber(spec.port) : null

    // An id that is not one never reaches a file name or the record; `default` is the server above.
    if (MODEL_SERVER_ID.test(id) && id !== DEFAULT_MODEL_SERVER && host && port !== null) {
      servers.push({ host, id, port })
    }
  }

  return loginHost && loginPort !== null && servers.length > 0 ? { loginHost, loginPort, servers } : null
}

/** Why the bridge is not wanted under a snapshot, or null when it is. */
export function bridgeOffReason(snapshot: Pick<ClientConfigSnapshot, 'config' | 'variant'> | null): null | string {
  if (!snapshot || snapshot.variant === 'stock' || !featureStates(snapshot.config).flag(LOCAL_MODELS_FEATURE)) {
    return 'feature_off'
  }

  const section = isRecord(snapshot.config.local_models) ? snapshot.config.local_models : {}

  if (section.enabled !== true) {
    return 'switch_off'
  }

  return bridgePlan(snapshot.config) ? null : 'not_configured'
}

// ── The local ports ─────────────────────────────────────────────────────────

/**
 * The port each model server's forward used last on this Profile, by server id (empty before the first, or when
 * the file is not readable). The file is `{"port": <the default server's>, "servers": {"<id>": <port>}}`; with the
 * default server alone it is `{"port": <n>}`, as before there were several.
 */
export function readStoredPorts(athenaDir: string): Record<string, number> {
  const ports: Record<string, number> = {}

  try {
    const data: unknown = JSON.parse(readFileSync(path.join(athenaDir, BRIDGE_PORT_FILE), 'utf8'))

    if (!isRecord(data)) {
      return ports
    }

    for (const [id, value] of Object.entries(isRecord(data.servers) ? data.servers : {})) {
      const port = portNumber(value)

      if (MODEL_SERVER_ID.test(id) && id !== DEFAULT_MODEL_SERVER && port !== null) {
        ports[id] = port
      }
    }

    const port = portNumber(data.port)

    if (port !== null) {
      ports[DEFAULT_MODEL_SERVER] = port
    }
  } catch {
    // no file yet
  }

  return ports
}

/** The port the default model server's forward used last (null before the first). */
export function readStoredPort(athenaDir: string): null | number {
  return readStoredPorts(athenaDir)[DEFAULT_MODEL_SERVER] ?? null
}

function writeStoredPorts(athenaDir: string, ports: Readonly<Record<string, number>>): void {
  const file = path.join(athenaDir, BRIDGE_PORT_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  const { [DEFAULT_MODEL_SERVER]: port, ...servers } = ports

  const body = {
    ...(port === undefined ? {} : { port }),
    ...(Object.keys(servers).length > 0 ? { servers } : {})
  }

  mkdirSync(athenaDir, { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`)
  renameSync(tmp, file)
}

function listen(server: NetServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error)
    server.once('error', failed)
    // Loopback only: nothing off this laptop can reach the model server through the forward.
    server.listen({ exclusive: true, host: BRIDGE_ADDRESS, port }, () => {
      server.removeListener('error', failed)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    })
  })
}

// ── The bridge ──────────────────────────────────────────────────────────────

export interface BridgeTimings {
  /** Wait this long after the record changed before running `athena config apply` (changes within it run once). */
  applyDebounceMs: number
  /** The wait before each retry after a failure; the last one repeats. Also paces the checks of a server that is down. */
  backoffMs: readonly number[]
  /** The wait before asking a host again after it answered with a key that is not pinned. */
  hostKeyRetryMs: number
  keepaliveCountMax: number
  keepaliveIntervalMs: number
  /** How long the login host may take to say whether it reaches a model server. */
  probeTimeoutMs: number
  /** How long the TCP connect, the handshake and the sign-in may take together. */
  readyTimeoutMs: number
}

/**
 * A dead link is noticed after `keepaliveIntervalMs` × `keepaliveCountMax` (10 s). After a failure the next attempt
 * is at most 15 s away and gives up after 10 s, so the bridge is back within 30 s of the login host being reachable.
 * A model server that is down is asked for again on the same backoff, so it is back within 15 s + 5 s of answering.
 */
export const BRIDGE_TIMINGS: BridgeTimings = Object.freeze({
  applyDebounceMs: 250,
  backoffMs: Object.freeze([500, 1000, 2000, 4000, 8000, 15_000]),
  hostKeyRetryMs: 60_000,
  keepaliveCountMax: 2,
  keepaliveIntervalMs: 5000,
  probeTimeoutMs: 5000,
  readyTimeoutMs: 10_000
})

export interface HpcBridgeOptions {
  /** Run `athena config apply` (after the record was written or removed). */
  applyConfig?: () => Promise<unknown> | void
  /** `$HERMES_HOME/athena`: the bridge record and the remembered ports live here. */
  athenaDir: string
  /** The pinned host keys (hpc-bridge-keys.ts `hostKeyTable`). */
  hostKeys: HostKeyPins
  keyProvider: BridgeKeyProvider
  log?: (line: string) => void
  now?: () => number
  /** Called after the bridge record was written or removed (main re-reads it into the client-config snapshot). */
  onRecord?: () => void
  /** Called with each new status. */
  onStatus?: (status: HpcBridgeStatus) => void
  /** The current client-config snapshot (null before there is one). */
  snapshot: () => Pick<ClientConfigSnapshot, 'config' | 'variant'> | null
  timings?: Partial<BridgeTimings>
}

const samePlan = (a: BridgePlan | null, b: BridgePlan | null): boolean =>
  a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b)

/** A stable word for why a connection ended, from ssh2's error. */
function failureReason(error: unknown): string {
  const { code, level } = (error ?? {}) as { code?: unknown; level?: unknown }

  if (level === 'client-authentication') {
    return 'auth_failed'
  }

  if (level === 'client-timeout') {
    return 'timeout'
  }

  if (level === 'client-socket' || level === 'client-dns' || typeof code === 'string') {
    return 'unreachable'
  }

  return 'connection_lost'
}

/** One model server's forward: its loopback listener (kept across reconnects) and whether the server answers. */
interface Forward {
  /** How many checks in a row found the server down (paces the next one). */
  checks: number
  checkTimer: NodeJS.Timeout | null
  listener: NetServer | null
  port: null | number
  reason?: string
  server: BridgeServer
  state: HpcBridgeServerState
}

export class HpcBridge {
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly timings: BridgeTimings

  private current: HpcBridgeStatus
  /** What the bridge is running for (null while it is off). */
  private plan: BridgePlan | null = null
  /** The user disconnected: stay off until asked to connect. */
  private paused = false
  /** Bumped by every start and stop: what an older attempt started is then dropped where it lands. */
  private generation = 0
  private attempts = 0
  private client: Client | null = null
  private ready = false
  /** Whether `connected` was announced for the current connection (after the first server answered, or all failed). */
  private announced = false
  /** One forward per model server of the plan, by server id. A listener outlives the connection it served. */
  private readonly forwards = new Map<string, Forward>()
  /** The ports the bridge record on disk lists, as JSON ('' while there is no record). */
  private recorded = ''
  private readonly sockets = new Set<Socket>()
  private retryTimer: NodeJS.Timeout | null = null
  private applyTimer: NodeJS.Timeout | null = null
  /** The first attempt of the current start, up to the point where it dials (or finds it cannot). */
  private starting: Promise<void> = Promise.resolve()
  /** Inside `reconcile` (it is not re-entered: a record change it causes comes back as a snapshot change). */
  private reconciling = false
  private reconcileAgain = false
  private stopped = false
  /** The password of the sign-in, in memory only (F05 slice 07). Nothing here reads it but the connection attempt. */
  private readonly password = new BridgePassword()
  /** The user name of the password sign-in: entered now, or remembered from an earlier launch. Not a secret. */
  private username: null | string
  /** Whether the last look found a configured key (a key wins over the password). */
  private keyHeld = false
  /** What the current connection signed in with (null while there is none). */
  private clientAuth: 'key' | 'password' | null = null
  /** Called at each new status (a sign-in waits here for its attempt to settle). */
  private readonly watchers = new Set<() => void>()

  constructor(private readonly options: HpcBridgeOptions) {
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
    this.timings = { ...BRIDGE_TIMINGS, ...options.timings }
    this.username = readBridgeUser(options.athenaDir)
    this.current = {
      credential: 'none',
      reason: 'feature_off',
      since: new Date(this.now()).toISOString(),
      state: 'off',
      ...(this.username ? { username: this.username } : {})
    }
  }

  /** What main holds to sign in with: a configured key wins, else the password entered since the app started. */
  private credential(): HpcBridgeCredential {
    return this.keyHeld ? 'key' : this.password.held ? 'password' : 'none'
  }

  status(): HpcBridgeStatus {
    return this.current
  }

  /** The loopback port the default model server's forward listens on (null while there is no listener). */
  get localPort(): null | number {
    return this.localPortOf(DEFAULT_MODEL_SERVER)
  }

  /** The loopback port a model server's forward listens on (null while there is no listener for it). */
  localPortOf(server: string): null | number {
    const forward = this.forwards.get(server)

    return forward?.listener ? forward.port : null
  }

  /** Follow the client config: start, restart for other hosts, or stop. Called on every snapshot. */
  reconcile(): void {
    if (this.stopped) {
      return
    }

    if (this.reconciling) {
      this.reconcileAgain = true

      return
    }

    this.reconciling = true

    try {
      do {
        this.reconcileAgain = false
        this.reconcileOnce()
      } while (this.reconcileAgain)
    } finally {
      this.reconciling = false
    }
  }

  private reconcileOnce(): void {
    const snapshot = this.options.snapshot()
    const off = bridgeOffReason(snapshot) ?? (this.paused ? 'disconnected' : null)

    if (off) {
      // Not wanted (the row or the switch went off, or the user disconnected): nothing is kept to sign in with.
      this.password.forget()
      this.teardown()
      this.setStatus('off', off)

      return
    }

    const plan = bridgePlan(snapshot!.config)

    if (samePlan(plan, this.plan)) {
      return
    }

    // Other hosts or servers, or a fresh start: the listeners and their ports stay, the connection is made anew.
    this.teardown({ keepListeners: true })
    this.plan = plan
    this.begin()
  }

  /**
   * The user asks to connect now, with what main holds (a configured key, or the password entered earlier in this
   * run). Answers once the attempt is under way: `connecting`, or why there is none (`off`, `host_key_unknown`,
   * `no_key`: nothing is held, the dialog must ask).
   */
  async connect(): Promise<HpcBridgeStatus> {
    this.paused = false
    this.restart()
    await this.starting

    return this.current
  }

  /**
   * The user signs in from the dialog (F05 slice 07). The password is kept in memory and the bridge connects; once
   * the login host accepts the sign-in the user name is remembered for the next launch. Answers once the attempt
   * has settled: `connected`, or why not (`down` with `auth_failed` when the login host refused the password; the
   * password is then already forgotten, no port is left open and no user name was written). With a
   * configured key the key is used and the password is dropped unused. While local models are off nothing is kept.
   */
  async signIn(input: unknown): Promise<HpcBridgeStatus> {
    const { password: rawPassword, username: rawUsername } = (input ?? {}) as { password?: unknown; username?: unknown }
    const username = bridgeUsername(rawUsername)
    const password = bridgePassword(rawPassword)

    if (!username || password === null) {
      throw new Error('athena hpc bridge: a user name and a password are needed')
    }

    if (this.stopped || bridgeOffReason(this.options.snapshot())) {
      return this.current
    }

    // The user name is written down only once the login host has accepted the sign-in (`ready`).
    this.username = username
    this.password.set(password)
    this.paused = false
    this.restart()
    await this.starting
    await this.settled()

    return this.current
  }

  /** Resolves once the status is no longer `connecting` (or the sign-in and its checks could not take longer). */
  private settled(): Promise<void> {
    if (this.current.state !== 'connecting') {
      return Promise.resolve()
    }

    return new Promise(resolve => {
      const done = () => {
        if (this.current.state !== 'connecting') {
          finish()
        }
      }

      const finish = () => {
        clearTimeout(timer)
        this.watchers.delete(done)
        resolve()
      }

      const timer = setTimeout(finish, this.timings.readyTimeoutMs + this.timings.probeTimeoutMs + 1000)
      timer.unref?.()
      this.watchers.add(done)
    })
  }

  /** The user disconnects: the forwards close and stay closed until `connect`, and the password is forgotten. */
  disconnect(): HpcBridgeStatus {
    this.paused = true
    this.password.forget()
    this.reconcile()
    this.announce()

    return this.current
  }

  /**
   * Forget the remembered user name. The sign-in goes with it: the password is forgotten and a bridge that was
   * opened with it closes. A bridge on a configured key is not touched.
   */
  forgetUser(): HpcBridgeStatus {
    this.username = null
    this.password.forget()

    try {
      forgetBridgeUser(this.options.athenaDir)
    } catch (error) {
      this.log(`[athena] hpc bridge: could not forget the user name: ${String(error)}`)
    }

    if (this.plan && !this.keyHeld) {
      this.restart()
    }

    this.announce()

    return this.current
  }

  /** Tell the status again when what main holds, or the user name, changed under the same state. */
  private announce(): void {
    this.setStatus(this.current.state, this.current.reason)
  }

  /**
   * The laptop woke, or the network came back. `force` reconnects even while connected (after a sleep the old
   * connection is dead more often than not, and waiting for the keepalives to say so wastes 10 s).
   */
  kick(options: { force?: boolean } = {}): void {
    const refused = this.current.reason === 'auth_failed' || this.current.reason === 'auth_unsupported'

    if (!this.plan || (this.ready && !options.force) || refused) {
      return
    }

    this.restart()
  }

  /** The app quits: close everything and remove the record, synchronously. */
  stop(): void {
    this.stopped = true
    this.password.forget()
    this.teardown()
    this.setStatus('off', bridgeOffReason(this.options.snapshot()) ?? 'disconnected')

    if (this.applyTimer) {
      // A removal still waiting for its apply: run it now, the timer would die with the process.
      clearTimeout(this.applyTimer)
      this.applyTimer = null
      this.runApply()
    }
  }

  private restart(): void {
    if (this.stopped) {
      return
    }

    // Held as a reconcile, so the record change the teardown causes does not start a second attempt.
    this.reconciling = true

    try {
      this.teardown({ keepListeners: true })
    } finally {
      this.reconciling = false
    }

    this.reconcile()
  }

  /** Each model server's state, while connected: what the status carries beside the overall state. */
  private serverStatuses(): Record<string, HpcBridgeServerStatus> {
    const servers: Record<string, HpcBridgeServerStatus> = {}

    for (const [id, forward] of this.forwards) {
      servers[id] = {
        ...(forward.state === 'up' && forward.port !== null ? { port: forward.port } : {}),
        ...(forward.reason === undefined ? {} : { reason: forward.reason }),
        state: forward.state
      }
    }

    return servers
  }

  private setStatus(state: HpcBridgeState, reason?: string): void {
    const servers = state === 'connected' ? this.serverStatuses() : undefined
    const port = servers?.[DEFAULT_MODEL_SERVER]?.port
    const sameState = this.current.state === state && this.current.reason === reason
    const credential = this.credential()
    const username = this.username ?? undefined

    if (
      sameState &&
      this.current.port === port &&
      this.current.credential === credential &&
      this.current.username === username &&
      JSON.stringify(this.current.servers) === JSON.stringify(servers)
    ) {
      return
    }

    this.current = {
      credential,
      ...(port === undefined ? {} : { port }),
      ...(reason === undefined ? {} : { reason }),
      ...(servers === undefined ? {} : { servers }),
      // `since` is when the state or its reason changed, not when a model server came or went.
      since: sameState ? this.current.since : new Date(this.now()).toISOString(),
      state,
      ...(username === undefined ? {} : { username })
    }

    const listed = Object.entries(servers ?? {})
      .map(([id, server]) => `${id} ${server.state}${server.port ? ` on ${BRIDGE_ADDRESS}:${server.port}` : ''}`)
      .join(', ')

    this.log(`[athena] hpc bridge: ${state}${reason ? ` (${reason})` : ''}${listed ? `: ${listed}` : ''}`)

    try {
      this.options.onStatus?.(this.current)
    } catch (error) {
      this.log(`[athena] hpc bridge: status listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    for (const watcher of [...this.watchers]) {
      watcher()
    }
  }

  // ── Stopping ──────────────────────────────────────────────────────────────

  /** Close the connection, the forwarded sockets and the listeners, and remove the record. Leaves the status alone. */
  private teardown(options: { keepListeners?: boolean } = {}): void {
    this.generation += 1
    this.plan = null
    this.attempts = 0

    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    const client = this.client
    this.client = null
    this.clientAuth = null
    this.ready = false
    this.announced = false
    this.closeSockets()
    this.resetForwards()

    if (!options.keepListeners) {
      this.closeListeners()
    }

    if (client) {
      try {
        client.destroy()
      } catch {
        // already gone
      }
    }

    this.syncRecord()
  }

  private closeSockets(): void {
    for (const socket of this.sockets) {
      socket.destroy()
    }

    this.sockets.clear()
  }

  /** No connection: no server is known to answer, and nothing is waiting to ask one. */
  private resetForwards(): void {
    for (const forward of this.forwards.values()) {
      if (forward.checkTimer) {
        clearTimeout(forward.checkTimer)
        forward.checkTimer = null
      }

      forward.checks = 0
      forward.state = 'down'

      // A forward without a listener keeps saying why (`local_port_unavailable`) until one opens.
      if (forward.listener) {
        delete forward.reason
      }
    }
  }

  private closeListeners(): void {
    for (const forward of this.forwards.values()) {
      forward.listener?.close()
    }

    this.forwards.clear()
  }

  // ── The record, and hermes's copy of it ───────────────────────────────────

  /** The port of every model server whose forward is up now. */
  private upPorts(): Record<string, number> {
    const ports: Record<string, number> = {}

    if (this.ready) {
      for (const [id, forward] of this.forwards) {
        if (forward.state === 'up' && forward.listener && forward.port !== null) {
          ports[id] = forward.port
        }
      }
    }

    return ports
  }

  /**
   * Make the bridge record say which forwards are up: written with their ports, or removed when none is. When that
   * changed the file, main re-reads it and `athena config apply` runs, so each server's provider follows at once.
   */
  private syncRecord(): void {
    const ports = this.upPorts()
    const wanted = Object.keys(ports).length > 0 ? JSON.stringify(ports) : ''

    if (wanted === this.recorded) {
      return
    }

    this.recorded = wanted

    try {
      if (wanted) {
        const { [DEFAULT_MODEL_SERVER]: port, ...servers } = ports
        writeBridgeRecord(this.options.athenaDir, { address: BRIDGE_ADDRESS, port, servers })
      } else {
        removeBridgeRecord(this.options.athenaDir)
      }
    } catch (error) {
      this.log(`[athena] hpc bridge: could not ${wanted ? 'write' : 'remove'} the bridge record: ${String(error)}`)
    }

    if (this.applyTimer) {
      clearTimeout(this.applyTimer)
    }

    this.applyTimer = setTimeout(() => {
      this.applyTimer = null
      this.runApply()
    }, this.timings.applyDebounceMs)

    try {
      this.options.onRecord?.()
    } catch (error) {
      this.log(`[athena] hpc bridge: record listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private runApply(): void {
    try {
      void Promise.resolve(this.options.applyConfig?.()).catch(error =>
        this.log(`[athena] hpc bridge: athena config apply failed: ${String(error)}`)
      )
    } catch (error) {
      this.log(`[athena] hpc bridge: athena config apply failed: ${String(error)}`)
    }
  }

  // ── Connecting ────────────────────────────────────────────────────────────

  private begin(): void {
    this.attempts = 0
    this.starting = this.attempt(this.generation, true)
  }

  private retryLater(generation: number, delayMs?: number): void {
    const backoff = this.timings.backoffMs
    const delay = delayMs ?? backoff[Math.min(this.attempts, backoff.length - 1)] ?? 15_000
    this.attempts += 1

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null

      if (generation === this.generation) {
        void this.attempt(generation, false)
      }
    }, delay)
    this.retryTimer.unref?.()
  }

  /** A loopback listener for one model server, on the port it had before when that is still free. */
  private async openListener(
    server: BridgeServer,
    stored: null | number
  ): Promise<{ listener: NetServer; port: number }> {
    let listener = createServer(socket => this.forward(server.id, socket))
    let port: number

    try {
      port = await listen(listener, stored ?? 0)
    } catch (error) {
      if (stored === null) {
        throw error
      }

      // The remembered port is taken: any free one, remembered from now on.
      this.log(
        `[athena] hpc bridge: port ${stored} is not free (${(error as NodeJS.ErrnoException).code ?? error}); taking another`
      )
      listener = createServer(socket => this.forward(server.id, socket))
      port = await listen(listener, 0)
    }

    return { listener, port }
  }

  /**
   * One listener per model server of the plan, each on its own kept port. A server whose port cannot be opened is
   * left without one (`local_port_unavailable`) and the others go ahead. Answers how many listeners there are, or
   * null when the attempt was overtaken meanwhile.
   */
  private async ensureListeners(generation: number, plan: BridgePlan): Promise<null | number> {
    const wanted = new Set(plan.servers.map(server => server.id))

    // A server the config no longer names: its listener goes.
    for (const [id, forward] of this.forwards) {
      if (!wanted.has(id)) {
        forward.listener?.close()
        this.forwards.delete(id)
      }
    }

    const stored = readStoredPorts(this.options.athenaDir)
    const ports = { ...stored }
    let open = 0

    for (const server of plan.servers) {
      const existing = this.forwards.get(server.id)

      if (existing?.listener) {
        existing.server = server
        open += 1

        continue
      }

      let made: { listener: NetServer; port: number } | null = null

      try {
        made = await this.openListener(server, stored[server.id] ?? null)
      } catch (error) {
        this.log(`[athena] hpc bridge: no loopback port for model server ${server.id}: ${String(error)}`)
      }

      if (generation !== this.generation) {
        made?.listener.close()

        return null
      }

      if (!made) {
        this.forwards.set(server.id, {
          checks: 0,
          checkTimer: null,
          listener: null,
          port: null,
          reason: 'local_port_unavailable',
          server,
          state: 'down'
        })

        continue
      }

      made.listener.on('error', error =>
        this.log(`[athena] hpc bridge: listener error (model server ${server.id}): ${String(error)}`)
      )
      this.forwards.set(server.id, {
        checks: 0,
        checkTimer: null,
        listener: made.listener,
        port: made.port,
        server,
        state: 'down'
      })
      ports[server.id] = made.port
      open += 1
    }

    if (JSON.stringify(ports) !== JSON.stringify(stored)) {
      try {
        writeStoredPorts(this.options.athenaDir, ports)
      } catch (error) {
        this.log(`[athena] hpc bridge: could not remember the forward ports: ${String(error)}`)
      }
    }

    return open
  }

  private async attempt(generation: number, announce: boolean): Promise<void> {
    const plan = this.plan

    if (!plan || generation !== this.generation) {
      return
    }

    // The pins first: a host this build does not pin is never contacted, whatever key the laptop has.
    const pins = pinnedHostKeys(this.options.hostKeys, plan.loginHost, plan.loginPort)

    if (pins.fingerprints.size === 0) {
      this.closeListeners()
      this.setStatus('host_key_unknown')

      return
    }

    let key: Awaited<ReturnType<BridgeKeyProvider>> = null

    try {
      key = await this.options.keyProvider()
    } catch (error) {
      this.log(
        `[athena] hpc bridge: the key could not be read: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    if (generation !== this.generation) {
      return
    }

    this.keyHeld = Boolean(key)

    if (key) {
      // A configured key wins (slice 06's path, unchanged): a password entered beside it is dropped unused.
      this.password.forget()
    }

    const password = key ? null : this.password.use()
    const username = key ? key.username : this.username

    if (!key && (password === null || !username)) {
      // Nothing to sign in with: the Desktop's dialog asks for the user name and password (`signIn`).
      this.closeListeners()
      this.setStatus('no_key')

      return
    }

    const open = await this.ensureListeners(generation, plan)

    if (open === null) {
      return
    }

    if (open === 0) {
      // Not one forward can listen: there is nothing to connect for. Tried again like a failed connection.
      this.setStatus('down', 'local_port_unavailable')
      this.retryLater(generation)

      return
    }

    if (announce) {
      this.setStatus('connecting')
    }

    let client: Client

    try {
      client = new (await loadSsh2()).Client()
    } catch (error) {
      // The build is broken, not the network: say so once and stop.
      this.log(
        `[athena] hpc bridge: the SSH library did not load: ${error instanceof Error ? error.message : String(error)}`
      )

      if (generation === this.generation) {
        this.setStatus('down', 'ssh_unavailable')
      }

      return
    }

    if (generation !== this.generation) {
      return
    }

    let reason: null | string = null
    let gone = false

    const lost = (fallback: string) => {
      if (gone) {
        return
      }

      gone = true

      try {
        client.destroy()
      } catch {
        // already gone
      }

      this.clientGone(generation, client, reason ?? fallback)
    }

    client.on('ready', () => {
      if (generation !== this.generation || client !== this.client) {
        client.destroy()

        return
      }

      this.ready = true
      this.attempts = 0
      this.announced = false

      if (!key && username && readBridgeUser(this.options.athenaDir) !== username) {
        try {
          writeBridgeUser(this.options.athenaDir, username)
        } catch (error) {
          this.log(`[athena] hpc bridge: could not remember the user name: ${String(error)}`)
        }
      }

      // One connection, one forward per model server. Each server is asked for once before its models are
      // offered: a server that is down (or a port that could not be opened) does not hold the others back.
      for (const forward of this.forwards.values()) {
        if (forward.listener) {
          forward.state = 'checking'
          delete forward.reason
          this.check(generation, client, forward)
        }
      }

      this.serversChanged()
    })
    client.on('error', error => {
      reason ??= failureReason(error)
      this.log(`[athena] hpc bridge: ${plan.loginHost}:${plan.loginPort}: ${error.message}`)
      lost('connection_lost')
    })
    client.on('close', () => lost('connection_lost'))
    // The login host wants the password changed: not something the bridge does.
    client.on('change password', () => {
      reason = 'auth_unsupported'
      lost('auth_unsupported')
    })
    this.client = client
    this.clientAuth = key ? 'key' : 'password'

    // The password sign-in (F05 slice 07). ssh2 calls this only after the host key passed `hostVerifier` below, so
    // nothing here runs for a host whose key is not pinned. One step at a time:
    //   1. `none`: asks the login host which methods it takes (as OpenSSH does); sends the user name only;
    //   2. the password, once: as `password` when the host takes that, else as the answer to `keyboard-interactive`;
    //   3. whatever comes back that is not success ends the sign-in. The password is never sent a second time, so
    //      a wrong one costs one failed attempt on the account, not two.
    let step = 0
    let prompted = false

    const answerPrompt = (
      _name: string,
      _instructions: string,
      _language: string,
      prompts: readonly { echo?: boolean; prompt: string }[],
      finish: (answers: string[]) => void
    ) => {
      const only = prompts.length === 1 ? prompts[0] : null

      // Exactly one hidden prompt that asks for a password, once. A second round, a visible prompt, several
      // prompts or another question (a verification code) is not answered.
      if (prompted || !only || only.echo === true || !/password/i.test(only.prompt)) {
        reason = 'auth_unsupported'
        this.log('[athena] hpc bridge: the login host asked for more than one password; sign-in stopped')
        lost('auth_unsupported')

        return
      }

      prompted = true
      finish([password!])
    }

    const passwordAuth = (
      methodsLeft: null | readonly string[],
      partial: boolean | null,
      next: (auth: unknown) => void
    ) => {
      step += 1

      if (step === 1) {
        next({ type: 'none', username })

        return
      }

      const methods = methodsLeft ?? []

      if (step === 2 && methods.includes('password')) {
        next({ password, type: 'password', username })
      } else if (step === 2 && methods.includes('keyboard-interactive')) {
        next({ prompt: answerPrompt, type: 'keyboard-interactive', username })
      } else {
        // No method takes a password, or the password was accepted and more is asked for (`partial`): not
        // supported. Otherwise the login host refused the password.
        reason ??= step === 2 || partial ? 'auth_unsupported' : 'auth_failed'
        next(false)
      }
    }

    const config: ConnectConfig = {
      // With a key: public key only (no `none` probe, no password, no agent, no keyboard prompts).
      authHandler: (key ? ['publickey'] : passwordAuth) as never,
      host: plan.loginHost,
      hostVerifier: (hostKey: Buffer) => {
        const trusted = pins.fingerprints.has(hostKeyFingerprint(hostKey))

        if (!trusted) {
          // Returning false ends the handshake here: the user's name and key have not been sent.
          reason = 'host_key_mismatch'
          this.log(
            `[athena] hpc bridge: ${plan.loginHost} answered with host key ${hostKeyFingerprint(hostKey)}, ` +
              'which is not pinned in this build; refused'
          )
        }

        return trusted
      },
      keepaliveCountMax: this.timings.keepaliveCountMax,
      keepaliveInterval: this.timings.keepaliveIntervalMs,
      port: plan.loginPort,
      readyTimeout: this.timings.readyTimeoutMs,
      username: username!,
      ...(key ? { passphrase: key.passphrase, privateKey: key.privateKey } : {}),
      ...(pins.algorithms ? { algorithms: { serverHostKey: pins.algorithms as never } } : {})
    }

    try {
      client.connect(config)
    } catch (error) {
      // ssh2 throws at once for a key it cannot parse.
      reason = 'key_unreadable'
      this.log(`[athena] hpc bridge: the key cannot be used: ${error instanceof Error ? error.message : String(error)}`)
      lost('key_unreadable')
    }
  }

  private clientGone(generation: number, client: Client, reason: string): void {
    if (client !== this.client) {
      return
    }

    const wasReady = this.ready
    const auth = this.clientAuth
    this.client = null
    this.clientAuth = null
    this.ready = false
    this.announced = false
    this.closeSockets()
    this.resetForwards()
    this.syncRecord()

    if (generation !== this.generation) {
      return
    }

    if (wasReady && reason === 'unreachable') {
      // A socket error on a connection that was up (a reset, a broken pipe) is the connection going away.
      reason = 'connection_lost'
    }

    if (reason === 'key_unreadable') {
      this.closeListeners()
      this.setStatus('no_key', reason)

      return
    }

    const refused = reason === 'auth_failed' || reason === 'auth_unsupported'

    if (refused && auth === 'password') {
      // A password the login host does not take is not kept, and so cannot be sent again. Nothing stays open, and
      // the user name falls back to the one an accepted sign-in left (if any).
      this.password.forget()
      this.username = readBridgeUser(this.options.athenaDir)
      this.closeListeners()
    }

    this.setStatus('down', reason)

    if (refused) {
      // The login host refused the key or the password. Asking again and again would only look like an attack (and
      // locks an account): wait for a new sign-in, a config change or the user.
      return
    }

    this.retryLater(generation, reason === 'host_key_mismatch' ? this.timings.hostKeyRetryMs : undefined)
  }

  // ── The model servers ─────────────────────────────────────────────────────

  /**
   * Ask the login host whether it reaches one model server: open a channel to it and close it again. Nothing is
   * sent to the model server. The answer (or none within `probeTimeoutMs`) sets the server `up` or `down`.
   */
  private check(generation: number, client: Client, forward: Forward): void {
    const { server } = forward
    let settled = false

    const done = (up: boolean, why?: string) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)

      if (generation !== this.generation || client !== this.client || !this.ready) {
        return
      }

      if (!up) {
        this.log(`[athena] hpc bridge: model server ${server.id} (${server.host}:${server.port}) not reached: ${why}`)
      }

      this.setForward(generation, client, forward, up)
    }

    const timer = setTimeout(() => done(false, 'no answer'), this.timings.probeTimeoutMs)
    timer.unref?.()

    try {
      client.forwardOut(BRIDGE_ADDRESS, 0, server.host, server.port, (error, stream) => {
        if (stream) {
          stream.on('error', () => {})
          stream.destroy()
        }

        done(!error, error?.message)
      })
    } catch (error) {
      done(false, error instanceof Error ? error.message : String(error))
    }
  }

  /** One model server answered, or did not: record it, tell the status, and ask a server that is down again later. */
  private setForward(generation: number, client: Client, forward: Forward, up: boolean): void {
    if (forward.checkTimer) {
      clearTimeout(forward.checkTimer)
      forward.checkTimer = null
    }

    if (up) {
      forward.state = 'up'
      forward.checks = 0
      delete forward.reason
    } else {
      forward.state = 'down'
      forward.reason = 'target_unreachable'
      const backoff = this.timings.backoffMs
      const delay = backoff[Math.min(forward.checks, backoff.length - 1)] ?? 15_000
      forward.checks += 1

      forward.checkTimer = setTimeout(() => {
        forward.checkTimer = null

        if (generation === this.generation && client === this.client && this.ready) {
          this.check(generation, client, forward)
        }
      }, delay)
      forward.checkTimer.unref?.()
    }

    this.serversChanged()
  }

  /** A server's state changed: the record lists the forwards that are up, and the status says each one's state. */
  private serversChanged(): void {
    this.syncRecord()

    const states = [...this.forwards.values()].map(forward => forward.state)

    // `connected` is announced once a first server answers, or once every one has been asked: one slow or dead
    // server does not keep the others waiting, and with a single server the record is there when `connected` is.
    if (!this.announced && (states.includes('up') || !states.includes('checking'))) {
      this.announced = true
    }

    if (this.announced && this.ready) {
      this.setStatus('connected')
    }
  }

  // ── Forwarding ────────────────────────────────────────────────────────────

  private forward(id: string, socket: Socket): void {
    const client = this.client
    const forward = this.forwards.get(id)
    const generation = this.generation
    socket.on('error', () => {})

    // A server that is not up is not offered (its models are off the list); it is asked for again on its own.
    if (!client || !this.ready || !forward || forward.state !== 'up') {
      socket.destroy()

      return
    }

    const { server } = forward
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))

    try {
      client.forwardOut(
        socket.remoteAddress ?? BRIDGE_ADDRESS,
        socket.remotePort ?? 0,
        server.host,
        server.port,
        (error, stream) => {
          if (error) {
            this.log(`[athena] hpc bridge: ${server.host}:${server.port} not reached: ${error.message}`)
            socket.destroy()

            // This server went away: its models leave the list, the other servers are not touched.
            if (generation === this.generation && client === this.client && this.ready && forward.state === 'up') {
              this.setForward(generation, client, forward, false)
            }

            return
          }

          if (socket.destroyed) {
            stream.destroy()

            return
          }

          stream.on('error', () => socket.destroy())
          stream.once('close', () => socket.destroy())
          socket.once('close', () => stream.destroy())
          socket.pipe(stream).pipe(socket)
        }
      )
    } catch {
      socket.destroy()
    }
  }
}

// ── Installing it in main ───────────────────────────────────────────────────

interface PowerEvents {
  on: (event: 'resume' | 'unlock-screen', listener: () => void) => unknown
}

export interface InstallHpcBridgeOptions {
  allWindows: () => readonly Pick<BrowserWindow, 'isDestroyed' | 'webContents'>[]
  /** `whenReady`: the power monitor is not usable before it. `on('will-quit')`: the record goes with the app. */
  app: { on: (event: 'will-quit', listener: () => void) => unknown; whenReady: () => Promise<unknown> }
  /** Run `athena config apply` (tool-prefs.ts `applyConfig`). */
  applyConfig?: () => Promise<unknown> | void
  athenaDir: string
  /** The running client-config source: its snapshot is the config, and it re-reads the record on request. */
  clientConfig: () => Pick<AthenaClientConfig, 'refresh' | 'snapshot'> | null
  env?: Record<string, string | undefined>
  /** Tests: the pinned host keys (default: the build's table, plus the development file). */
  hostKeys?: HostKeyPins
  installStamp: unknown
  ipcMain: Pick<IpcMain, 'handle'>
  /** `net.isOnline`: polled while the bridge is down, so it reconnects when the network returns. */
  isOnline?: () => boolean
  /** Tests, and the key setup of a later slice (default: the development key source). */
  keyProvider?: BridgeKeyProvider
  log: (line: string) => void
  onlinePollMs?: number
  powerMonitor?: () => PowerEvents
  timings?: Partial<BridgeTimings>
}

let installed: HpcBridge | null = null

/** The running bridge (null before `installAthenaHpcBridge`, and in tests). */
export function athenaHpcBridge(): HpcBridge | null {
  return installed
}

export function installAthenaHpcBridge(options: InstallHpcBridgeOptions): HpcBridge {
  const env = options.env ?? process.env
  const devOverrides = devOverridesFromEnv(env, options.installStamp)
  const snapshot = () => options.clientConfig()?.snapshot() ?? null

  const bridge = new HpcBridge({
    applyConfig: options.applyConfig,
    athenaDir: options.athenaDir,
    hostKeys: options.hostKeys ?? hostKeyTable(env, devOverrides, options.log),
    keyProvider: options.keyProvider ?? devBridgeKeyProvider(env, devOverrides, options.log),
    log: options.log,
    onRecord: () => {
      options.clientConfig()?.refresh()
    },
    onStatus: status => {
      for (const win of options.allWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(HPC_BRIDGE_CHANNELS.changed, status)
        }
      }
    },
    snapshot,
    timings: options.timings
  })

  // The channels are row F05's, so the IPC guard registers them only while the row lets it (policy-seams.ts).
  // Under `managed.features: report` it registers them whatever the row says: each call asks the row again.
  const guarded =
    <T>(channel: string, run: (payload: unknown) => T) =>
    (_event?: unknown, payload?: unknown): T => {
      const current = snapshot()

      if (!current || current.variant === 'stock' || !featureStates(current.config).flag(LOCAL_MODELS_FEATURE)) {
        throw new Error(policyRefusalMessage('ipc', channel))
      }

      return run(payload)
    }

  options.ipcMain.handle(
    HPC_BRIDGE_CHANNELS.status,
    guarded(HPC_BRIDGE_CHANNELS.status, () => bridge.status())
  )
  options.ipcMain.handle(
    HPC_BRIDGE_CHANNELS.connect,
    // With a sign-in (the dialog's user name and password, sent once): kept in main's memory, never echoed back.
    guarded(HPC_BRIDGE_CHANNELS.connect, payload =>
      payload === undefined || payload === null ? bridge.connect() : bridge.signIn(payload)
    )
  )
  options.ipcMain.handle(
    HPC_BRIDGE_CHANNELS.disconnect,
    guarded(HPC_BRIDGE_CHANNELS.disconnect, () => bridge.disconnect())
  )
  options.ipcMain.handle(
    HPC_BRIDGE_CHANNELS.forgetUser,
    guarded(HPC_BRIDGE_CHANNELS.forgetUser, () => bridge.forgetUser())
  )

  onMainPoliciesChanged(() => bridge.reconcile())
  bridge.reconcile()

  options.app.on('will-quit', () => bridge.stop())
  // `app.exit()` skips will-quit; the record must not outlive the forward either way.
  process.once('exit', () => bridge.stop())

  void options.app.whenReady().then(() => {
    try {
      const power = options.powerMonitor?.()
      power?.on('resume', () => bridge.kick({ force: true }))
      power?.on('unlock-screen', () => bridge.kick())
    } catch (error) {
      options.log(`[athena] hpc bridge: no power monitor: ${String(error)}`)
    }
  })

  if (options.isOnline) {
    let online = true

    const timer = setInterval(() => {
      let now = online

      try {
        now = options.isOnline!()
      } catch {
        // keep the last answer
      }

      if (now && !online) {
        bridge.kick()
      }

      online = now
    }, options.onlinePollMs ?? 3000)

    timer.unref?.()
  }

  installed = bridge

  return bridge
}
