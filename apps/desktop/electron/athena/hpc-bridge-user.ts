// Athena HPC bridge: the password sign-in (F05 slice 07).
//
// The bridge signs in to the login host with the user's HPC user name and password. Nothing is installed on the HPC.
//
// - The password lives in one place: a private field of `BridgePassword`, in Electron main's memory, for the app's
//   run. It is never written to a file, a log line, a status, the bridge record or a snapshot, and it never goes to
//   the Athena server. It is forgotten on quit, on Disconnect, and the moment the login host refuses it. The holder
//   prints as `[password]` wherever it is logged, inspected or serialised.
// - The user name is not a secret. It is remembered for the next launch in
//   `$HERMES_HOME/athena/hpc-bridge-user.json` (`{"username": "<name>"}`, beside the bridge's remembered ports), so
//   the dialog asks only for the password again.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const BRIDGE_USER_FILE = 'hpc-bridge-user.json'

/** A POSIX-style account name, as an HPC login is: letters, digits, `.`, `_`, `-`; never starting with `-`. */
const USERNAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/

const MAX_PASSWORD_LENGTH = 1024

/** The user name as the login host takes it, or null when it is not one. */
export function bridgeUsername(value: unknown): null | string {
  const name = typeof value === 'string' ? value.trim() : ''

  return USERNAME.test(name) ? name : null
}

/** A password as typed (not trimmed: spaces may be part of it), or null when it is empty or absurdly long. */
export function bridgePassword(value: unknown): null | string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PASSWORD_LENGTH ? value : null
}

/** The password, held in memory only. Nothing but `use()` gives it out. */
export class BridgePassword {
  #value: null | string = null

  get held(): boolean {
    return this.#value !== null
  }

  set(password: string): void {
    this.#value = password
  }

  /** The password, for the one place that sends it: the sign-in to a login host whose key was just checked. */
  use(): null | string {
    return this.#value
  }

  forget(): void {
    this.#value = null
  }

  toJSON(): string {
    return '[password]'
  }

  toString(): string {
    return '[password]'
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[password]'
  }
}

// ── The remembered user name ────────────────────────────────────────────────

/** The user name of the last sign-in on this Profile (null before the first, or when the file is not readable). */
export function readBridgeUser(athenaDir: string): null | string {
  try {
    const data: unknown = JSON.parse(readFileSync(path.join(athenaDir, BRIDGE_USER_FILE), 'utf8'))

    return data && typeof data === 'object' ? bridgeUsername((data as { username?: unknown }).username) : null
  } catch {
    return null
  }
}

/** Remember the user name (and nothing else) for the next launch. */
export function writeBridgeUser(athenaDir: string, username: string): void {
  const file = path.join(athenaDir, BRIDGE_USER_FILE)
  const tmp = `${file}.${process.pid}.tmp`

  mkdirSync(athenaDir, { recursive: true })
  writeFileSync(tmp, `${JSON.stringify({ username }, null, 2)}\n`, { mode: 0o600 })

  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Windows: the Profile folder's own access list applies
  }

  renameSync(tmp, file)
}

export function forgetBridgeUser(athenaDir: string): void {
  rmSync(path.join(athenaDir, BRIDGE_USER_FILE), { force: true })
}
