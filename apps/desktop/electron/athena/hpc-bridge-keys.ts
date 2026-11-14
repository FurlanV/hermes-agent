// Athena HPC bridge: who the bridge trusts and what it signs in with (F05 slice 06).
//
// Two narrow seams, both injected into the bridge (hpc-bridge.ts):
// - the pinned host keys of a login host (`pinnedHostKeys`): the build's table (hpc-bridge-host-keys.ts). The host's
//   key is checked against them before any authentication is sent; an empty list means the host is never contacted;
// - the user's key (`BridgeKeyProvider`): returns the private key and the HPC user name, or null when this laptop has
//   none. The key setup of a later slice (it generates the key, keeps it in the OS's protected storage and installs
//   the public half with the user's password, once) plugs in here. This slice ships only a development source.
//
// Development sources, honoured only where dev overrides are (client-config.ts `devOverridesFromEnv`:
// `ATHENA_DEV_OVERRIDES=1` and a build that is not a managed release), so a released build ignores them:
// - `ATHENA_HPC_BRIDGE_KEY_FILE` + `ATHENA_HPC_BRIDGE_USER`: an unencrypted OpenSSH private key file the login host
//   already accepts, and the user name to sign in as;
// - `ATHENA_HPC_BRIDGE_HOST_KEYS_FILE`: a JSON object `{"<host>[:<port>]": ["<key line or SHA256:…>", …]}` merged
//   over the build's table (for a stand-in login host).

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { DevOverrides } from './client-config'
import { type HostKeyPins, HPC_BRIDGE_HOST_KEYS } from './hpc-bridge-host-keys'

export type { HostKeyPins }

export const BRIDGE_KEY_FILE_ENV = 'ATHENA_HPC_BRIDGE_KEY_FILE'
export const BRIDGE_USER_ENV = 'ATHENA_HPC_BRIDGE_USER'
export const BRIDGE_HOST_KEYS_FILE_ENV = 'ATHENA_HPC_BRIDGE_HOST_KEYS_FILE'

// ── The user's key ──────────────────────────────────────────────────────────

export interface BridgeKey {
  /** Only for an encrypted private key. */
  passphrase?: string
  /** The private key, in a format ssh2 parses (OpenSSH or PEM). Held in memory only. */
  privateKey: Buffer | string
  /** The user's name on the login host. */
  username: string
}

/** The key to sign in with, or null when this laptop has none (the bridge then reports `no_key`). */
export type BridgeKeyProvider = () => BridgeKey | null | Promise<BridgeKey | null>

export const NO_BRIDGE_KEY: BridgeKeyProvider = () => null

type Env = Record<string, string | undefined>

/** The development key source: a key file and user name from the environment, only while dev overrides are allowed. */
export function devBridgeKeyProvider(
  env: Env,
  devOverrides: Pick<DevOverrides, 'allowed'>,
  log: (line: string) => void = () => {}
): BridgeKeyProvider {
  const file = env[BRIDGE_KEY_FILE_ENV]?.trim()
  const username = env[BRIDGE_USER_ENV]?.trim()

  if (!devOverrides.allowed || !file || !username) {
    return NO_BRIDGE_KEY
  }

  log(`[athena] hpc bridge: development key from ${BRIDGE_KEY_FILE_ENV} (unmanaged build, dev overrides on)`)

  return () => {
    try {
      return { privateKey: readFileSync(file), username }
    } catch {
      return null
    }
  }
}

// ── Pinned host keys ────────────────────────────────────────────────────────

/** `SHA256:<base64, no padding>` of a host key blob, as `ssh-keygen -l` prints it. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export interface PinnedHostKeys {
  /**
   * The host key algorithms to ask the host for, when every pin is a key line (so its type is known); undefined
   * when a pin is a bare fingerprint: the host then answers with the key of its choice.
   */
  algorithms?: string[]
  /** The accepted fingerprints. Empty: the host is not pinned and must not be contacted. */
  fingerprints: ReadonlySet<string>
}

const SIGNATURE_ALGORITHMS: Readonly<Record<string, readonly string[]>> = {
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256']
}

/** One pin: a fingerprint, or a public key line (`<type> <base64> [comment]`). Null when it is neither. */
export function parseHostKeyPin(pin: string): { fingerprint: string; type: null | string } | null {
  const text = pin.trim()

  if (/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(text)) {
    return { fingerprint: text.replace(/=+$/, ''), type: null }
  }

  const [type, blob] = text.split(/\s+/)

  if (!type || !blob || !/^[a-z0-9@.-]+$/.test(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) {
    return null
  }

  const key = Buffer.from(blob, 'base64')

  // The blob of a public key starts with its own type, length-prefixed: a line whose two halves disagree is not one.
  if (
    key.length < 4 + type.length ||
    key.readUInt32BE(0) !== type.length ||
    key.toString('latin1', 4, 4 + type.length) !== type
  ) {
    return null
  }

  return { fingerprint: hostKeyFingerprint(key), type }
}

/** The pins for a login host: `<host>:<port>` when the table has it, else `<host>`. Unparseable entries are dropped. */
export function pinnedHostKeys(table: HostKeyPins, host: string, port: number): PinnedHostKeys {
  const name = host.trim().toLowerCase()
  const pins = (table[`${name}:${port}`] ?? table[name] ?? []).map(parseHostKeyPin).filter(pin => pin !== null)
  const types = pins.map(pin => pin.type)

  return {
    ...(pins.length > 0 && types.every(type => type !== null)
      ? { algorithms: [...new Set(types.flatMap(type => SIGNATURE_ALGORITHMS[type!] ?? [type!]))] }
      : {}),
    fingerprints: new Set(pins.map(pin => pin.fingerprint))
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The build's pins, with the development file merged over them while dev overrides are allowed. */
export function hostKeyTable(
  env: Env,
  devOverrides: Pick<DevOverrides, 'allowed'>,
  log: (line: string) => void = () => {},
  bundled: HostKeyPins = HPC_BRIDGE_HOST_KEYS
): HostKeyPins {
  const file = env[BRIDGE_HOST_KEYS_FILE_ENV]?.trim()

  if (!devOverrides.allowed || !file) {
    return bundled
  }

  let data: unknown

  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    data = null
  }

  if (!isRecord(data)) {
    log(`[athena] hpc bridge: ${BRIDGE_HOST_KEYS_FILE_ENV} is not a JSON object of host → keys; ignored`)

    return bundled
  }

  const extra: Record<string, readonly string[]> = {}

  for (const [host, pins] of Object.entries(data)) {
    if (Array.isArray(pins)) {
      extra[host.trim().toLowerCase()] = pins.filter(pin => typeof pin === 'string')
    }
  }

  log(`[athena] hpc bridge: development host keys for ${Object.keys(extra).join(', ') || 'no host'} (dev overrides on)`)

  return { ...bundled, ...extra }
}
