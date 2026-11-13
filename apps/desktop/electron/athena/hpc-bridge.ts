// Athena: the HPC bridge (F05 slice 06).
//
// The local model server is on a node only the user's laptop can reach, through the HPC login host. While local
// models are on, Electron main keeps one SSH connection to the login host of the client config
// (`local_models.login_host:login_port`) and forwards a loopback port to the model server
// (`target_host:target_port`):
//
//   hermes ──▶ 127.0.0.1:<port> ──(SSH, as the user)──▶ login host ──▶ model server
//
// - It runs only while feature row F05 is on, `local_models.enabled` is true, the config names the hosts, the build
//   pins a host key for the login host and this laptop has a key (hpc-bridge-keys.ts). Otherwise nothing is
//   contacted and the status says why.
// - The login host's key is checked against the pinned ones before any authentication is sent. Another key ends
//   the connection there (`host_key_mismatch`). Nothing is ever trusted on first use.
// - Only public-key authentication is offered. There is no password here.
// - The forward listens on 127.0.0.1 only. Its port is chosen once and kept in
//   `$HERMES_HOME/athena/hpc-bridge-port.json`, so the address hermes is pinned to is the same after every launch;
//   another port is taken only when that one is in use.
// - While the forward is up the Profile's bridge record says where (hpc-bridge-record.ts). The record is removed
//   the moment the connection is lost and written again when it is back, and `athena config apply` runs after each
//   change so hermes's second provider follows at once.
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
import { removeBridgeRecord, writeBridgeRecord } from './hpc-bridge-record'
import { HPC_BRIDGE_CHANNELS, type HpcBridgeState, type HpcBridgeStatus } from './hpc-bridge-types'
import { onMainPoliciesChanged } from './main-policy'
import { LOCAL_MODELS_FEATURE } from './model-policy'
import { policyRefusalMessage } from './policy-seams'

export { HPC_BRIDGE_CHANNELS }
export type { HpcBridgeState, HpcBridgeStatus }

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const hostName = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const portNumber = (value: unknown): null | number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65535 ? value : null

/** The hosts of the config's `local_models` section, or null when it does not name them all. */
export function bridgeTarget(config: unknown): BridgeTarget | null {
  const section = isRecord(config) && isRecord(config.local_models) ? config.local_models : {}
  const loginHost = hostName(section.login_host)
  const targetHost = hostName(section.target_host)

  const loginPort =
    section.login_port === undefined || section.login_port === null ? 22 : portNumber(section.login_port)

  const targetPort = portNumber(section.target_port)

  return loginHost && targetHost && loginPort !== null && targetPort !== null
    ? { loginHost, loginPort, targetHost, targetPort }
    : null
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

  return bridgeTarget(snapshot.config) ? null : 'not_configured'
}

// ── The local port ──────────────────────────────────────────────────────────

/** The port this Profile's bridge used last (null before the first, or when the file is not readable). */
export function readStoredPort(athenaDir: string): null | number {
  try {
    const data: unknown = JSON.parse(readFileSync(path.join(athenaDir, BRIDGE_PORT_FILE), 'utf8'))

    return isRecord(data) ? portNumber(data.port) : null
  } catch {
    return null
  }
}

function writeStoredPort(athenaDir: string, port: number): void {
  const file = path.join(athenaDir, BRIDGE_PORT_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  mkdirSync(athenaDir, { recursive: true })
  writeFileSync(tmp, `${JSON.stringify({ port }, null, 2)}\n`)
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
  /** The wait before each retry after a failure; the last one repeats. */
  backoffMs: readonly number[]
  /** The wait before asking a host again after it answered with a key that is not pinned. */
  hostKeyRetryMs: number
  keepaliveCountMax: number
  keepaliveIntervalMs: number
  /** How long the TCP connect, the handshake and the sign-in may take together. */
  readyTimeoutMs: number
}

/**
 * A dead link is noticed after `keepaliveIntervalMs` × `keepaliveCountMax` (10 s). After a failure the next attempt
 * is at most 15 s away and gives up after 10 s, so the bridge is back within 30 s of the login host being reachable.
 */
export const BRIDGE_TIMINGS: BridgeTimings = Object.freeze({
  applyDebounceMs: 250,
  backoffMs: Object.freeze([500, 1000, 2000, 4000, 8000, 15_000]),
  hostKeyRetryMs: 60_000,
  keepaliveCountMax: 2,
  keepaliveIntervalMs: 5000,
  readyTimeoutMs: 10_000
})

export interface HpcBridgeOptions {
  /** Run `athena config apply` (after the record was written or removed). */
  applyConfig?: () => Promise<unknown> | void
  /** `$HERMES_HOME/athena`: the bridge record and the remembered port live here. */
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

const sameTarget = (a: BridgeTarget | null, b: BridgeTarget | null): boolean =>
  a !== null &&
  b !== null &&
  a.loginHost === b.loginHost &&
  a.loginPort === b.loginPort &&
  a.targetHost === b.targetHost &&
  a.targetPort === b.targetPort

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

export class HpcBridge {
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly timings: BridgeTimings

  private current: HpcBridgeStatus
  /** The target the bridge is running for (null while it is off). */
  private target: BridgeTarget | null = null
  /** The user disconnected: stay off until asked to connect. */
  private paused = false
  /** Bumped by every start and stop: what an older attempt started is then dropped where it lands. */
  private generation = 0
  private attempts = 0
  private client: Client | null = null
  private ready = false
  private listener: NetServer | null = null
  private port: null | number = null
  private readonly sockets = new Set<Socket>()
  private retryTimer: NodeJS.Timeout | null = null
  private applyTimer: NodeJS.Timeout | null = null
  /** Inside `reconcile` (it is not re-entered: a record change it causes comes back as a snapshot change). */
  /** The first attempt of the current start, up to the point where it dials (or finds it cannot). */
  private starting: Promise<void> = Promise.resolve()
  private reconciling = false
  private reconcileAgain = false
  private stopped = false

  constructor(private readonly options: HpcBridgeOptions) {
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
    this.timings = { ...BRIDGE_TIMINGS, ...options.timings }
    this.current = { reason: 'feature_off', since: new Date(this.now()).toISOString(), state: 'off' }
  }

  status(): HpcBridgeStatus {
    return this.current
  }

  /** The loopback port the forward listens on (null while there is no listener). */
  get localPort(): null | number {
    return this.listener ? this.port : null
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
      this.teardown()
      this.setStatus('off', off)

      return
    }

    const target = bridgeTarget(snapshot!.config)

    if (sameTarget(target, this.target)) {
      return
    }

    // Other hosts, or a fresh start: the listener and its port stay, the connection is made anew.
    this.teardown({ keepListener: true })
    this.target = target
    this.begin()
  }

  /**
   * The user (or the key setup, once a key is installed) asks to connect now. Answers once the attempt is under
   * way: `connecting`, or why there is none (`off`, `no_key`, `host_key_unknown`).
   */
  async connect(): Promise<HpcBridgeStatus> {
    this.paused = false
    this.restart()
    await this.starting

    return this.current
  }

  /** The user disconnects: the forward closes and stays closed until `connect`. */
  disconnect(): HpcBridgeStatus {
    this.paused = true
    this.reconcile()

    return this.current
  }

  /**
   * The laptop woke, or the network came back. `force` reconnects even while connected (after a sleep the old
   * connection is dead more often than not, and waiting for the keepalives to say so wastes 10 s).
   */
  kick(options: { force?: boolean } = {}): void {
    if (!this.target || (this.ready && !options.force) || this.current.reason === 'auth_failed') {
      return
    }

    this.restart()
  }

  /** The app quits: close everything and remove the record, synchronously. */
  stop(): void {
    this.stopped = true
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
      this.teardown({ keepListener: true })
    } finally {
      this.reconciling = false
    }

    this.reconcile()
  }

  private setStatus(state: HpcBridgeState, reason?: string): void {
    const port = state === 'connected' && this.port !== null ? this.port : undefined

    if (this.current.state === state && this.current.reason === reason && this.current.port === port) {
      return
    }

    this.current = {
      ...(port === undefined ? {} : { port }),
      ...(reason === undefined ? {} : { reason }),
      since: new Date(this.now()).toISOString(),
      state
    }
    this.log(
      `[athena] hpc bridge: ${state}${reason ? ` (${reason})` : ''}${port ? ` on ${BRIDGE_ADDRESS}:${port}` : ''}`
    )

    try {
      this.options.onStatus?.(this.current)
    } catch (error) {
      this.log(`[athena] hpc bridge: status listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── Stopping ──────────────────────────────────────────────────────────────

  /** Close the connection, the forwarded sockets and the listener, and remove the record. Leaves the status alone. */
  private teardown(options: { keepListener?: boolean } = {}): void {
    this.generation += 1
    this.target = null
    this.attempts = 0

    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    const client = this.client
    const wasReady = this.ready
    this.client = null
    this.ready = false
    this.closeSockets()

    if (!options.keepListener) {
      this.closeListener()
    }

    if (client) {
      try {
        client.destroy()
      } catch {
        // already gone
      }
    }

    if (wasReady) {
      this.recordChanged(false)
    }
  }

  private closeSockets(): void {
    for (const socket of this.sockets) {
      socket.destroy()
    }

    this.sockets.clear()
  }

  private closeListener(): void {
    const listener = this.listener
    this.listener = null

    if (listener) {
      listener.close()
    }
  }

  // ── The record, and hermes's copy of it ───────────────────────────────────

  private recordChanged(up: boolean): void {
    try {
      if (up && this.port !== null) {
        writeBridgeRecord(this.options.athenaDir, { address: BRIDGE_ADDRESS, port: this.port })
      } else {
        removeBridgeRecord(this.options.athenaDir)
      }
    } catch (error) {
      this.log(`[athena] hpc bridge: could not ${up ? 'write' : 'remove'} the bridge record: ${String(error)}`)
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

  private async ensureListener(generation: number): Promise<boolean> {
    if (this.listener) {
      return true
    }

    const stored = readStoredPort(this.options.athenaDir)
    let server = createServer(socket => this.forward(socket))
    let port: number

    try {
      port = await listen(server, stored ?? 0)
    } catch (error) {
      if (stored === null) {
        throw error
      }

      // The remembered port is taken: any free one, remembered from now on.
      this.log(
        `[athena] hpc bridge: port ${stored} is not free (${(error as NodeJS.ErrnoException).code ?? error}); taking another`
      )
      server = createServer(socket => this.forward(socket))
      port = await listen(server, 0)
    }

    if (generation !== this.generation) {
      server.close()

      return false
    }

    server.on('error', error => this.log(`[athena] hpc bridge: listener error: ${String(error)}`))
    this.listener = server
    this.port = port

    if (port !== stored) {
      try {
        writeStoredPort(this.options.athenaDir, port)
      } catch (error) {
        this.log(`[athena] hpc bridge: could not remember port ${port}: ${String(error)}`)
      }
    }

    return true
  }

  private async attempt(generation: number, announce: boolean): Promise<void> {
    const target = this.target

    if (!target || generation !== this.generation) {
      return
    }

    // The pins first: a host this build does not pin is never contacted, whatever key the laptop has.
    const pins = pinnedHostKeys(this.options.hostKeys, target.loginHost, target.loginPort)

    if (pins.fingerprints.size === 0) {
      this.closeListener()
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

    if (!key) {
      this.closeListener()
      this.setStatus('no_key')

      return
    }

    try {
      if (!(await this.ensureListener(generation))) {
        return
      }
    } catch (error) {
      if (generation === this.generation) {
        this.log(`[athena] hpc bridge: no loopback port: ${String(error)}`)
        this.setStatus('down', 'local_port_unavailable')
        this.retryLater(generation)
      }

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
      this.recordChanged(true)
      this.setStatus('connected')
    })
    client.on('error', error => {
      reason ??= failureReason(error)
      this.log(`[athena] hpc bridge: ${target.loginHost}:${target.loginPort}: ${error.message}`)
      lost('connection_lost')
    })
    client.on('close', () => lost('connection_lost'))
    this.client = client

    const config: ConnectConfig = {
      // Public key only: no `none` probe, no password, no agent, no keyboard prompts.
      authHandler: ['publickey'],
      host: target.loginHost,
      hostVerifier: (hostKey: Buffer) => {
        const trusted = pins.fingerprints.has(hostKeyFingerprint(hostKey))

        if (!trusted) {
          // Returning false ends the handshake here: the user's name and key have not been sent.
          reason = 'host_key_mismatch'
          this.log(
            `[athena] hpc bridge: ${target.loginHost} answered with host key ${hostKeyFingerprint(hostKey)}, ` +
              'which is not pinned in this build; refused'
          )
        }

        return trusted
      },
      keepaliveCountMax: this.timings.keepaliveCountMax,
      keepaliveInterval: this.timings.keepaliveIntervalMs,
      passphrase: key.passphrase,
      port: target.loginPort,
      privateKey: key.privateKey,
      readyTimeout: this.timings.readyTimeoutMs,
      username: key.username,
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
    this.client = null
    this.ready = false
    this.closeSockets()

    if (wasReady) {
      this.recordChanged(false)
    }

    if (generation !== this.generation) {
      return
    }

    if (wasReady && reason === 'unreachable') {
      // A socket error on a connection that was up (a reset, a broken pipe) is the connection going away.
      reason = 'connection_lost'
    }

    if (reason === 'key_unreadable') {
      this.closeListener()
      this.setStatus('no_key', reason)

      return
    }

    this.setStatus('down', reason)

    if (reason === 'auth_failed') {
      // The login host refused the key. Asking again and again would only look like an attack: wait for a new
      // key, a config change or the user.
      return
    }

    this.retryLater(generation, reason === 'host_key_mismatch' ? this.timings.hostKeyRetryMs : undefined)
  }

  // ── Forwarding ────────────────────────────────────────────────────────────

  private forward(socket: Socket): void {
    const client = this.client
    const target = this.target
    socket.on('error', () => {})

    if (!client || !this.ready || !target) {
      socket.destroy()

      return
    }

    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))

    try {
      client.forwardOut(
        socket.remoteAddress ?? BRIDGE_ADDRESS,
        socket.remotePort ?? 0,
        target.targetHost,
        target.targetPort,
        (error, stream) => {
          if (error) {
            this.log(`[athena] hpc bridge: ${target.targetHost}:${target.targetPort} not reached: ${error.message}`)
            socket.destroy()

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
    <T>(channel: string, run: () => T) =>
    (): T => {
      const current = snapshot()

      if (!current || current.variant === 'stock' || !featureStates(current.config).flag(LOCAL_MODELS_FEATURE)) {
        throw new Error(policyRefusalMessage('ipc', channel))
      }

      return run()
    }

  options.ipcMain.handle(
    HPC_BRIDGE_CHANNELS.status,
    guarded(HPC_BRIDGE_CHANNELS.status, () => bridge.status())
  )
  options.ipcMain.handle(
    HPC_BRIDGE_CHANNELS.connect,
    guarded(HPC_BRIDGE_CHANNELS.connect, () => bridge.connect())
  )
  options.ipcMain.handle(
    HPC_BRIDGE_CHANNELS.disconnect,
    guarded(HPC_BRIDGE_CHANNELS.disconnect, () => bridge.disconnect())
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
