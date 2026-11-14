// Athena: the Profile's bridge record (F05 slices 04 to 06, and 12).
//
// `$HERMES_HOME/athena/hpc-bridge.json` says where this laptop's HPC bridge (the SSH forwards to the local model
// servers) listens. The Desktop writes it while a forward is up and removes it when none is (hpc-bridge.ts);
// athena's applier reads it to pin one hermes provider per model server (`athena_shipper.local_models`, the
// reference reader and writer). One JSON object (version 2):
//
//   {"version": 2, "address": "127.0.0.1", "port": 49731, "pid": 4242, "connected_at": "2026-11-13T20:00:00Z",
//    "servers": {"default": {"port": 49731}, "hpc-llm": {"port": 49732}}}
//
// `servers` lists the model servers whose forward is up now, by the config's server id (`default`: the one
// `local_models.target_host` names). `port` repeats the default server's port while that forward is up: it is what
// version 1 had, and a record without `servers` is read as the default server alone.
//
// Stale means absent: a record that cannot be read like that, whose address is not loopback, that lists no server
// with a usable port, or whose `pid` names no running process (a Desktop that crashed leaves the file but no
// forward). A server entry whose id or port is not one is dropped on its own.
// Main reads it into every client-config snapshot (`hpcBridge`, client-config.ts), so the pickers and the model
// gate follow the bridge as it comes and goes.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { HpcBridgeAddress } from './client-config-types'

export const BRIDGE_RECORD_FILE = 'hpc-bridge.json'
export const BRIDGE_RECORD_VERSION = 2
/** The id of the model server `local_models.target_host`/`target_port` name (athena's `DEFAULT_MODEL_SERVER`). */
export const DEFAULT_MODEL_SERVER = 'default'
/** A model server id (athena's `ServerId`): it goes into a hermes provider key and into file contents. */
export const MODEL_SERVER_ID = /^[a-z][a-z0-9-]{0,31}$/
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

const usablePort = (value: unknown): null | number => {
  const port = integer(value)

  return port !== null && port >= 1 && port <= 65535 ? port : null
}

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

  const pid = integer(data.pid)

  if (typeof data.address !== 'string' || !BRIDGE_LOOPBACK.includes(data.address) || pid === null) {
    return null
  }

  // Version 2 lists every server that is up; version 1 has the default server's port alone.
  const servers: Record<string, number> = {}

  if (isRecord(data.servers)) {
    for (const [id, entry] of Object.entries(data.servers)) {
      const port = isRecord(entry) ? usablePort(entry.port) : null

      if (MODEL_SERVER_ID.test(id) && port !== null) {
        servers[id] = port
      }
    }
  } else {
    const port = usablePort(data.port)

    if (port !== null) {
      servers[DEFAULT_MODEL_SERVER] = port
    }
  }

  if (Object.keys(servers).length === 0 || !alive(pid)) {
    return null
  }

  const port = servers[DEFAULT_MODEL_SERVER]
  const listed = isRecord(data.servers)

  return {
    address: data.address,
    connectedAt: typeof data.connected_at === 'string' ? data.connected_at : null,
    pid,
    ...(port === undefined ? {} : { port }),
    ...(listed ? { servers } : {})
  }
}

/** What a snapshot carries of a record: where the bridge listens (not the pid). */
export function bridgeAddress(record: BridgeRecord | null): HpcBridgeAddress | null {
  return record
    ? {
        address: record.address,
        connectedAt: record.connectedAt,
        ...(record.port === undefined ? {} : { port: record.port }),
        ...(record.servers ? { servers: record.servers } : {})
      }
    : null
}

/** The port of every model server whose forward a record (or a snapshot's `hpcBridge`) says is up, by server id. */
export function bridgePorts(
  bridge: Pick<HpcBridgeAddress, 'port' | 'servers'> | null | undefined
): Record<string, number> {
  if (!bridge) {
    return {}
  }

  return bridge.servers ?? (bridge.port === undefined ? {} : { [DEFAULT_MODEL_SERVER]: bridge.port })
}

/**
 * Write the record as athena's `write_record` does: a temporary file in the same folder, mode 0600, then a rename.
 * `port` is the default model server's forward, `servers` the other servers' ports by id; `pid` is the process
 * holding the forwards (this one).
 */
export function writeBridgeRecord(
  athenaDir: string,
  record: { address?: string; connectedAt?: string; pid?: number; port?: number; servers?: Record<string, number> }
): string {
  const address = record.address ?? '127.0.0.1'

  if (!BRIDGE_LOOPBACK.includes(address)) {
    throw new Error(`the bridge listens on loopback only, not ${address}`)
  }

  const ports: Record<string, number> = {
    ...(record.port === undefined ? {} : { [DEFAULT_MODEL_SERVER]: record.port }),
    ...record.servers
  }

  const ids = Object.keys(ports)

  if (ids.length === 0 || ids.some(id => !MODEL_SERVER_ID.test(id))) {
    throw new Error('a bridge record lists at least one model server, each by a server id')
  }

  const defaultPort = ports[DEFAULT_MODEL_SERVER]

  const file = bridgeRecordFile(athenaDir)
  const tmp = `${file}.${process.pid}.tmp`

  const body = {
    version: BRIDGE_RECORD_VERSION,
    address,
    ...(defaultPort === undefined ? {} : { port: defaultPort }),
    pid: record.pid ?? process.pid,
    connected_at: record.connectedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    servers: Object.fromEntries(ids.map(id => [id, { port: ports[id] }]))
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
