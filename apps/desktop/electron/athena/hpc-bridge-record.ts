// Athena: the Profile's bridge record (F05 slices 04 to 06).
//
// `$HERMES_HOME/athena/hpc-bridge.json` says where this laptop's HPC bridge (the SSH forward to the local model
// server) listens. The Desktop writes it while its forward is up and removes it when the forward closes
// (hpc-bridge.ts); athena's applier reads it to pin hermes's second provider
// (`athena_shipper.local_models`, the reference reader and writer). One JSON object:
//
//   {"version": 1, "address": "127.0.0.1", "port": 49731, "pid": 4242, "connected_at": "2026-11-13T20:00:00Z"}
//
// Stale means absent: a record that cannot be read like that, whose address is not loopback, whose port is not a
// port, or whose `pid` names no running process (a Desktop that crashed leaves the file but no forward).
// Main reads it into every client-config snapshot (`hpcBridge`, client-config.ts), so the pickers and the model
// gate follow the bridge as it comes and goes.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { HpcBridgeAddress } from './client-config-types'

export const BRIDGE_RECORD_FILE = 'hpc-bridge.json'
export const BRIDGE_RECORD_VERSION = 1
export const BRIDGE_LOOPBACK = Object.freeze(['127.0.0.1', '::1', 'localhost'])

export interface BridgeRecord extends HpcBridgeAddress {
  /** The process that holds the forward open (the Desktop's main process). */
  pid: number
}

export const bridgeRecordFile = (athenaDir: string): string => path.join(athenaDir, BRIDGE_RECORD_FILE)

/** Whether a process is running. A pid this user may not signal (EPERM) is still a running process. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const integer = (value: unknown): null | number =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

/** The Profile's bridge record, or null when there is none or it is stale. */
export function readBridgeRecord(athenaDir: string, alive: (pid: number) => boolean = pidAlive): BridgeRecord | null {
  let data: unknown

  try {
    data = JSON.parse(readFileSync(bridgeRecordFile(athenaDir), 'utf8'))
  } catch {
    return null
  }

  if (!isRecord(data)) {
    return null
  }

  const port = integer(data.port)
  const pid = integer(data.pid)

  if (
    typeof data.address !== 'string' ||
    !BRIDGE_LOOPBACK.includes(data.address) ||
    port === null ||
    port < 1 ||
    port > 65535 ||
    pid === null ||
    !alive(pid)
  ) {
    return null
  }

  return {
    address: data.address,
    connectedAt: typeof data.connected_at === 'string' ? data.connected_at : null,
    pid,
    port
  }
}

/** What a snapshot carries of a record: where the bridge listens (not the pid). */
export function bridgeAddress(record: BridgeRecord | null): HpcBridgeAddress | null {
  return record ? { address: record.address, connectedAt: record.connectedAt, port: record.port } : null
}

/**
 * Write the record as athena's `write_record` does: a temporary file in the same folder, mode 0600, then a rename.
 * `pid` is the process holding the forward (this one).
 */
export function writeBridgeRecord(
  athenaDir: string,
  record: { address?: string; connectedAt?: string; pid?: number; port: number }
): string {
  const address = record.address ?? '127.0.0.1'

  if (!BRIDGE_LOOPBACK.includes(address)) {
    throw new Error(`the bridge listens on loopback only, not ${address}`)
  }

  const file = bridgeRecordFile(athenaDir)
  const tmp = `${file}.${process.pid}.tmp`

  const body = {
    version: BRIDGE_RECORD_VERSION,
    address,
    port: record.port,
    pid: record.pid ?? process.pid,
    connected_at: record.connectedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  }

  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })

  try {
    // An existing temporary file keeps its old mode; make sure of it (a no-op on Windows).
    chmodSync(tmp, 0o600)
  } catch {
    // Best effort: the folder is the user's own.
  }

  renameSync(tmp, file)

  return file
}

export function removeBridgeRecord(athenaDir: string): void {
  rmSync(bridgeRecordFile(athenaDir), { force: true })
}
