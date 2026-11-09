// Athena: the signed client config in Electron main (F02 slice 14).
//
// `athena config sync` (the CLI, driven by the Shipper) stores the raw signed
// document the server issued at `$HERMES_HOME/athena/client-config.jws`. Main
// never trusts the CLI's verified copy (`client-config.json`): it re-verifies
// the JWS itself with the trusted keys bundled in the app, checks `typ`, `aud`,
// the schema major and `sub` (the signed-in user's Entra `oid`, read from
// `token.json`), and refuses a `config_version` lower than any it has seen.
//
// Fallback ladder (plan section C, "Safe defaults"):
//   the file verifies              → that config            (source `server`)
//   the file is bad (edited, unsigned, foreign `sub`, replayed, too new)
//                                   → the last good one held  (source `last-good`)
//                                     until 7 days past its `expires_at`
//   no file (deleted, signed out), nothing usable held
//                                   → the bundled default     (source `bundled`)
// An unsigned file is never used.
//
// Dev override: when the launcher passes `ATHENA_DEV_OVERRIDES=1` AND the build
// is not a managed release (install stamp `athenaManagedRelease`), a local JSON
// file is merged on top (hermes's rule: dicts merge, lists replace).
//
// Main writes `$HERMES_HOME/athena/desktop-status.json` for the Shipper's
// heartbeat: `{dev_overrides_active, config_version_seen, updated_at}`. Its
// `config_version_seen` is also the replay floor across restarts.

import { type JsonWebKey, type KeyObject } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { BUNDLED_DEFAULT_CONFIG, TRUSTED_KEYS } from './bundled-config-data'
import type {
  ClientConfigDocument,
  ClientConfigRejection,
  ClientConfigSnapshot,
  ClientConfigSource
} from './client-config-types'
import { JwsError, trustedKeys, verifyCompactJws } from './jws'

export const CLIENT_CONFIG_TYP = 'athena-client-config+jws'
export const CLIENT_CONFIG_AUDIENCE = 'athena-desktop'
export const SCHEMA_MAJOR = 1
/** How long past `expires_at` a last good config still stands in. */
export const LAST_GOOD_GRACE_MS = 7 * 24 * 60 * 60 * 1000

/** How often `desktop-status.json` is rewritten while nothing changes (the Shipper ignores it after 10 min). */
export const STATUS_REFRESH_MS = 60_000

export const CLIENT_CONFIG_FILE = 'client-config.jws'
export const DESKTOP_STATUS_FILE = 'desktop-status.json'
export const TOKEN_FILE = 'token.json'
export const DEV_OVERRIDES_ENV = 'ATHENA_DEV_OVERRIDES'
export const DEV_OVERRIDES_FILE_ENV = 'ATHENA_DEV_OVERRIDES_FILE'
export const defaultDevOverridesFile = (home = homedir()): string => path.join(home, 'athena-demo', 'athena-overrides.json')

export type {
  ClientConfigDocument,
  ClientConfigRejection,
  ClientConfigSnapshot,
  ClientConfigSource
} from './client-config-types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** hermes's merge: nested objects merge key by key; anything else, arrays included, replaces. */
export function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(overlay)) {
    const current = out[key]
    out[key] = isRecord(value) && isRecord(current) ? deepMerge(current, value) : value
  }

  return out
}

export const BUNDLED_DEFAULT: ClientConfigDocument = Object.freeze(
  structuredClone(BUNDLED_DEFAULT_CONFIG)
) as ClientConfigDocument

export function bundledTrustedKeys(): ReadonlyMap<string, KeyObject> {
  return trustedKeys(TRUSTED_KEYS.keys as unknown as JsonWebKey[])
}

// ── Signed-in subject ───────────────────────────────────────────────────────

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** The JWT payload of a bearer token, unverified: only used to name the user, never to authorize. */
function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') {
    return null
  }

  const parts = token.split('.')

  if (parts.length !== 3) {
    return null
  }

  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))

    return isRecord(claims) ? claims : null
  } catch {
    return null
  }
}

/**
 * The signed-in user's Entra `oid` from `$HERMES_HOME/athena/token.json` (written by `athena login`):
 * an explicit `oid` key if the CLI stores one, else the access token's `oid` claim. Null when signed out.
 */
export function signedInSubject(athenaDir: string): null | string {
  const token = readJson(path.join(athenaDir, TOKEN_FILE))

  if (!isRecord(token)) {
    return null
  }

  if (typeof token.oid === 'string' && token.oid) {
    return token.oid
  }

  const oid = jwtClaims(token.access_token)?.oid

  return typeof oid === 'string' && oid ? oid : null
}

// ── Verification ────────────────────────────────────────────────────────────

export class ClientConfigRejected extends Error {
  constructor(readonly reason: ClientConfigRejection) {
    super(reason)
  }
}

export function schemaMajor(version: unknown): null | number {
  if (typeof version !== 'string') {
    return null
  }

  const head = version.split('.', 1)[0]

  return /^\d+$/.test(head) ? Number(head) : null
}

/**
 * Verify one signed config: signature against `trusted`, `typ`, `aud`, schema major, `sub`, and the shape the
 * Desktop relies on. Version replay and expiry are the caller's. Unknown fields are kept (and ignored).
 */
export function verifyClientConfig(
  token: string,
  trusted: ReadonlyMap<string, KeyObject>,
  sub: null | string
): ClientConfigDocument {
  let verified

  try {
    verified = verifyCompactJws(token.trim(), trusted)
  } catch (error) {
    if (error instanceof JwsError) {
      throw new ClientConfigRejected(error.reason)
    }

    throw error
  }

  if (verified.header.typ !== CLIENT_CONFIG_TYP) {
    throw new ClientConfigRejected('wrong_type')
  }

  let data: unknown

  try {
    data = JSON.parse(verified.payload.toString('utf8'))
  } catch {
    throw new ClientConfigRejected('bad_payload')
  }

  if (!isRecord(data)) {
    throw new ClientConfigRejected('bad_payload')
  }

  const major = schemaMajor(data.schema_version)

  if (major === null) {
    throw new ClientConfigRejected('bad_payload')
  }

  if (major > SCHEMA_MAJOR) {
    throw new ClientConfigRejected('schema_too_new')
  }

  if (data.aud !== CLIENT_CONFIG_AUDIENCE) {
    throw new ClientConfigRejected('wrong_audience')
  }

  if (!sub) {
    throw new ClientConfigRejected('no_subject')
  }

  if (data.sub !== sub) {
    throw new ClientConfigRejected('wrong_subject')
  }

  const version = data.config_version

  if (!Number.isSafeInteger(version) || (version as number) < 0 || Number.isNaN(Date.parse(String(data.expires_at)))) {
    throw new ClientConfigRejected('bad_payload')
  }

  return data
}

// ── The source ──────────────────────────────────────────────────────────────

export interface DevOverrides {
  /** True only when the env var is set and the build is not a managed release. */
  allowed: boolean
  file: string
}

/**
 * Dev overrides are honoured only when the launcher passes `ATHENA_DEV_OVERRIDES=1` and the build is not a managed
 * release. A managed release is stamped at build time (`ATHENA_MANAGED_RELEASE=1` → install stamp
 * `athenaManagedRelease: true`); the demo build is not one, and an unpackaged dev run has no stamp at all.
 */
export function devOverridesFromEnv(
  env: Record<string, string | undefined>,
  installStamp: unknown,
  home = homedir()
): DevOverrides {
  const managedRelease = isRecord(installStamp) && installStamp.athenaManagedRelease === true

  return {
    allowed: env[DEV_OVERRIDES_ENV] === '1' && !managedRelease,
    file: env[DEV_OVERRIDES_FILE_ENV] || defaultDevOverridesFile(home)
  }
}

export interface ClientConfigSourceOptions {
  /** `$HERMES_HOME/athena` of the Profile this app runs on. */
  athenaDir: string
  bundledDefault?: ClientConfigDocument
  devOverrides?: DevOverrides
  log?: (line: string) => void
  now?: () => number
  /** Called with each new snapshot (not for no-op refreshes). */
  onChange?: (snapshot: ClientConfigSnapshot) => void
  trusted?: ReadonlyMap<string, KeyObject>
}

interface Held {
  config: ClientConfigDocument
  sub: string
  verifiedAt: string
}

function fileSignature(file: string): string {
  try {
    const stat = statSync(file)

    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(tmp, file)
}

export class AthenaClientConfig {
  private readonly athenaDir: string
  private readonly bundledDefault: ClientConfigDocument
  private readonly devOverrides: DevOverrides
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly onChange?: (snapshot: ClientConfigSnapshot) => void
  private readonly trusted: ReadonlyMap<string, KeyObject>

  private held: Held | null = null
  private versionSeen: number
  private current: ClientConfigSnapshot
  private statusWritten = ''
  private statusWrittenAt = 0
  private signatures = ''
  private timer: NodeJS.Timeout | null = null
  private lastRefreshAt = 0

  constructor(options: ClientConfigSourceOptions) {
    this.athenaDir = options.athenaDir
    this.bundledDefault = options.bundledDefault ?? BUNDLED_DEFAULT
    this.devOverrides = options.devOverrides ?? { allowed: false, file: defaultDevOverridesFile() }
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
    this.onChange = options.onChange
    this.trusted = options.trusted ?? bundledTrustedKeys()

    const status = readJson(this.statusFile)
    const seen = isRecord(status) ? status.config_version_seen : undefined
    this.versionSeen = Number.isSafeInteger(seen) && (seen as number) >= 0 ? (seen as number) : -1
    this.current = this.resolve()
    this.writeStatus()
  }

  get statusFile(): string {
    return path.join(this.athenaDir, DESKTOP_STATUS_FILE)
  }

  get configFile(): string {
    return path.join(this.athenaDir, CLIENT_CONFIG_FILE)
  }

  /** The highest `config_version` ever accepted on this Profile (-1 before the first). */
  get configVersionSeen(): number {
    return this.versionSeen
  }

  snapshot(): ClientConfigSnapshot {
    return this.current
  }

  /** Re-read everything now. Calls `onChange` when the snapshot changed. */
  refresh(): ClientConfigSnapshot {
    const next = this.resolve()
    const changed = JSON.stringify(next) !== JSON.stringify(this.current)
    this.current = next
    this.writeStatus()

    if (changed) {
      this.log(
        `[athena] client config: ${next.source}${next.configVersion === null ? '' : ` v${next.configVersion}`}` +
          `${next.role ? ` role ${next.role}` : ''}${next.error ? ` (file ${next.error})` : ''}` +
          `${next.devOverridesActive ? ' + dev overrides' : ''}`
      )
      this.onChange?.(next)
    }

    return next
  }

  /** Poll the inputs (config, token, override file) and refresh when one changed, or once a minute for expiry. */
  start(intervalMs = 1000): void {
    this.stop()
    this.signatures = this.inputSignatures()
    this.lastRefreshAt = this.now()
    this.timer = setInterval(() => this.tick(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  tick(): void {
    const signatures = this.inputSignatures()

    if (signatures !== this.signatures || this.now() - this.lastRefreshAt >= 60_000) {
      this.signatures = signatures
      this.lastRefreshAt = this.now()
      this.refresh()
    }
  }

  private inputSignatures(): string {
    return [
      fileSignature(this.configFile),
      fileSignature(path.join(this.athenaDir, TOKEN_FILE)),
      this.devOverrides.allowed ? fileSignature(this.devOverrides.file) : ''
    ].join('|')
  }

  private resolve(): ClientConfigSnapshot {
    const sub = signedInSubject(this.athenaDir)
    let token: null | string = null

    try {
      token = readFileSync(this.configFile, 'utf8')
    } catch {
      token = null
    }

    let chosen: Held | null = null
    let error: ClientConfigRejection | null = null
    let source: ClientConfigSource = 'bundled'

    if (token === null) {
      // Deleted (or never synced, or signed out): the bundled default, never an old copy.
      error = 'missing'
      this.held = null
    } else {
      try {
        const config = verifyClientConfig(token, this.trusted, sub)
        const version = config.config_version as number

        if (version < this.versionSeen) {
          throw new ClientConfigRejected('replayed_version')
        }

        if (!this.usable(config)) {
          throw new ClientConfigRejected('expired')
        }

        this.versionSeen = version
        this.held = { config, sub: sub as string, verifiedAt: new Date(this.now()).toISOString() }
        chosen = this.held
        source = 'server'
      } catch (rejection) {
        if (!(rejection instanceof ClientConfigRejected)) {
          throw rejection
        }

        error = rejection.reason

        if (this.held && this.held.sub === sub && this.usable(this.held.config)) {
          chosen = this.held
          source = 'last-good'
        }
      }
    }

    let config = deepMerge(this.bundledDefault, chosen?.config ?? {})
    const override = this.readOverride()

    if (override) {
      config = deepMerge(config, override)
    }

    return {
      config,
      configVersion: chosen ? (chosen.config.config_version as number) : null,
      devOverridesActive: override !== null,
      error,
      role: chosen && typeof chosen.config.role === 'string' ? chosen.config.role : null,
      source,
      verifiedAt: chosen?.verifiedAt ?? null
    }
  }

  private usable(config: ClientConfigDocument): boolean {
    return this.now() <= Date.parse(String(config.expires_at)) + LAST_GOOD_GRACE_MS
  }

  private readOverride(): ClientConfigDocument | null {
    if (!this.devOverrides.allowed) {
      return null
    }

    const data = readJson(this.devOverrides.file)

    return isRecord(data) ? data : null
  }

  private writeStatus(): void {
    const key = `${this.current.devOverridesActive}:${this.versionSeen}`

    // Rewritten at least once a minute: the Shipper treats a status older than ten minutes as stale.
    if (key === this.statusWritten && this.now() - this.statusWrittenAt < STATUS_REFRESH_MS) {
      return
    }

    try {
      writeJsonAtomic(this.statusFile, {
        dev_overrides_active: this.current.devOverridesActive,
        config_version_seen: Math.max(this.versionSeen, 0),
        updated_at: new Date(this.now()).toISOString()
      })
      this.statusWritten = key
      this.statusWrittenAt = this.now()
    } catch (error) {
      this.log(`[athena] could not write ${this.statusFile}: ${String(error)}`)
    }
  }
}
