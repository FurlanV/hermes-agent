/**
 * The status of local models, in words (F05 slice 08): connected, connecting, or not connected with the reason,
 * read from main's bridge status (`$hpcBridge`) and the role's list. Pure: no React here, so the model policy can
 * use it at boot. The places that show it are in local-models-settings.tsx.
 */

import type { HpcBridgeStatus } from '../../../electron/athena/hpc-bridge-types'
import {
  DEFAULT_MODEL_SERVER,
  findModelEntry,
  isBridgeProvider,
  type ManagedModelEntry,
  type ManagedModels
} from '../../../electron/athena/model-policy'

import { $hpcBridge } from './local-models'

export type LocalModelState = 'connected' | 'connecting' | 'not_connected'

export interface LocalModelStatus {
  /** Why it is not connected, in a few plain words; null when there is nothing to add. */
  reason: null | string
  state: LocalModelState
}

export const LOCAL_MODEL_STATE: Readonly<Record<LocalModelState, string>> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  not_connected: 'Not connected'
}

const LOGIN_NODE = 'login node unreachable'

/** Main's reason for a bridge that is down, in the words the user reads. */
const BRIDGE_REASONS: Readonly<Record<string, string>> = {
  auth_failed: 'password refused',
  auth_unsupported: 'the HPC asked for more than a password',
  connection_lost: LOGIN_NODE,
  host_key_mismatch: 'host key mismatch',
  local_port_unavailable: 'could not open the connection on this computer',
  ssh_unavailable: 'could not open the connection on this computer',
  timeout: LOGIN_NODE,
  unreachable: LOGIN_NODE
}

const SERVER_REASONS: Readonly<Record<string, string>> = {
  local_port_unavailable: 'could not open the connection on this computer',
  target_unreachable: 'model server not answering'
}

const NOT_IN_BUILD = 'not available in this version of Athena'

/** The connection to the HPC as a whole (the login node), whatever the model servers behind it do. */
export function bridgeStatus(status: HpcBridgeStatus | null): LocalModelStatus {
  if (!status) {
    return { reason: null, state: 'not_connected' }
  }

  switch (status.state) {
    case 'connected':
      return { reason: null, state: 'connected' }

    case 'connecting':
      return { reason: null, state: 'connecting' }

    case 'down':
      return { reason: BRIDGE_REASONS[status.reason ?? ''] ?? null, state: 'not_connected' }

    case 'host_key_unknown':
      return { reason: NOT_IN_BUILD, state: 'not_connected' }

    default:
      // `off` (the user disconnected) and `no_key` (nothing to sign in with yet): just not connected.
      return { reason: null, state: 'not_connected' }
  }
}

/**
 * One local model: the connection's status, narrowed by its own model server. `callable` is what the role's list
 * says (the model can be called now); it settles the answer when main's status is not known.
 */
export function localModelStatus(
  entry: Pick<ManagedModelEntry, 'server'>,
  status: HpcBridgeStatus | null,
  callable: boolean
): LocalModelStatus {
  if (!status) {
    return { reason: null, state: callable ? 'connected' : 'not_connected' }
  }

  const bridge = bridgeStatus(status)

  if (bridge.state !== 'connected') {
    return bridge
  }

  const server = status.servers?.[entry.server ?? DEFAULT_MODEL_SERVER]

  if (!server) {
    return { reason: null, state: callable ? 'connected' : 'not_connected' }
  }

  if (server.state === 'up') {
    return { reason: null, state: 'connected' }
  }

  if (server.state === 'checking') {
    return { reason: null, state: 'connecting' }
  }

  return { reason: SERVER_REASONS[server.reason ?? ''] ?? SERVER_REASONS.target_unreachable, state: 'not_connected' }
}

/** "Not connected: password refused" (Settings, toasts). */
export const statusLine = (status: LocalModelStatus): string =>
  status.reason ? `${LOCAL_MODEL_STATE[status.state]}: ${status.reason}` : LOCAL_MODEL_STATE[status.state]

/** The few words beside a picker row: the reason alone when there is one ("Password refused"), else the state. */
export function statusTag(status: LocalModelStatus): string {
  const words = status.reason ?? LOCAL_MODEL_STATE[status.state]

  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The local model a picker row shows (connected or not), or undefined for any other row. */
export function localModelOf(
  models: ManagedModels | null,
  model: string,
  provider: string
): { callable: boolean; entry: ManagedModelEntry } | undefined {
  if (!models || !models.localModels.on || !isBridgeProvider(provider)) {
    return undefined
  }

  const entry = models.localModels.configured.find(candidate => candidate.id === model.trim())

  return entry ? { callable: Boolean(findModelEntry(models, entry.id)), entry } : undefined
}

/** The tag of a picker row, or null when the row is not a local model. */
export function localModelTag(models: ManagedModels | null, model: string, provider: string): null | string {
  const found = localModelOf(models, model, provider)

  return found ? statusTag(localModelStatus(found.entry, $hpcBridge.get(), found.callable)) : null
}

/** Whether "Disconnect" is what the row offers: the bridge is up or on its way, or main still holds a password. */
export function canDisconnect(status: HpcBridgeStatus | null): boolean {
  if (!status || status.state === 'off' || status.state === 'no_key' || status.state === 'host_key_unknown') {
    return false
  }

  return status.state !== 'down' || status.credential === 'password'
}
