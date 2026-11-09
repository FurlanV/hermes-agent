// Athena: backend refusals built from the feature registry (F02 slice 17).
//
// Pure, no imports beyond the registry, shared by Electron main (REST, IPC,
// DevTools, deep links) and the renderer (JSON-RPC, `host.request` included).
// Each surface turns one call into the registry entry ids it reaches, and
// `featureDecider(config)` says whether the call may go ahead:
// - REST `PUT /api/x?y` reaches `rest:/api/x`, `rest:PUT /api/x` and (for any
//   method but GET/HEAD) `rest:WRITE /api/x`; an /api/env write or reveal also
//   reaches `credential:<KEY>` when a row names that key, else `env:<KEY>`;
// - JSON-RPC `m` reaches `rpc:m`, and `rpc:m/<action>` for the multiplexed
//   methods (`config.set` key, `*.manage` action, `command.dispatch` name);
//   `command.dispatch` and `slash.exec` also reach `slash:<command>`, so a
//   plugin cannot run a slash command the composer refuses;
// - IPC channel `c` reaches `ipc:c`.
// A call is refused while some entry it reaches is listed only under rows that
// are off (an entry no row lists is not audited and is left alone).
//
// Whatever the flags and the master switch say, `PUT`/`DELETE /api/env` for a
// managed-scope variable is refused: hermes loads the Profile `.env` with
// override, so the app's own env editor could otherwise point
// `HERMES_MANAGED_DIR` elsewhere and unpin the running daemon (spike 05).

import { featureStates, rowsForEntry } from './feature-registry'

export interface RestCall {
  body?: unknown
  method: string
  pathname: string
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The env var an /api/env write, delete or reveal names (null for other requests). */
export function envKeyOf(call: RestCall): null | string {
  if (call.pathname !== '/api/env' && call.pathname !== '/api/env/reveal') {
    return null
  }

  if (call.pathname === '/api/env' && READ_METHODS.has(call.method)) {
    return null
  }

  const key = isRecord(call.body) ? call.body.key : undefined

  return typeof key === 'string' ? key.trim() : ''
}

// ── Managed scope (always refused) ──────────────────────────────────────────

/**
 * Environment variables that move or switch off hermes managed scope, or steer
 * Athena's own client pieces, so the app may never write or delete them in a
 * Profile `.env`:
 * - `HERMES_MANAGED_DIR`: where managed scope lives (a missing folder turns it
 *   off entirely, `/etc/hermes` included);
 * - `HERMES_MANAGED`: hermes's package-manager write lock;
 * - `HERMES_HOME`: which Profile (and so which `athena/` folder) is in use;
 * - `PYTEST_CURRENT_TEST`: makes hermes ignore `/etc/hermes`;
 * - `ATHENA_*`: the Shipper, the guard and the launcher read these (trusted
 *   keys, the managed base, the model override, dev overrides).
 */
const MANAGED_SCOPE_ENV = new Set(['HERMES_MANAGED_DIR', 'HERMES_MANAGED', 'HERMES_HOME', 'PYTEST_CURRENT_TEST'])
const MANAGED_SCOPE_ENV_PREFIXES = ['ATHENA_']

export function isManagedScopeEnvKey(key: string): boolean {
  const name = key.trim().toUpperCase()

  return MANAGED_SCOPE_ENV.has(name) || MANAGED_SCOPE_ENV_PREFIXES.some(prefix => name.startsWith(prefix))
}

/** True for a `PUT`/`DELETE /api/env` naming a managed-scope variable (refused in every mode). */
export function isManagedScopeEnvWrite(call: RestCall): boolean {
  if (call.pathname !== '/api/env' || (call.method !== 'PUT' && call.method !== 'DELETE')) {
    return false
  }

  const key = envKeyOf(call)

  return key !== null && isManagedScopeEnvKey(key)
}

// ── Entry ids per call ──────────────────────────────────────────────────────

export function restEntries(call: RestCall): string[] {
  const pathname = call.pathname.replace(/\/+$/, '') || '/'
  const method = call.method.toUpperCase()
  const entries = [`rest:${pathname}`, `rest:${method} ${pathname}`]

  if (!READ_METHODS.has(method)) {
    entries.push(`rest:WRITE ${pathname}`)
  }

  const envKey = envKeyOf({ ...call, method, pathname })

  if (envKey) {
    const credential = `credential:${envKey}`
    entries.push(rowsForEntry(credential) === null ? `env:${envKey}` : credential)
  }

  return entries
}

/** The action a multiplexed JSON-RPC method carries in its params (null when it has none). */
export function rpcAction(method: string, params: Readonly<Record<string, unknown>>): null | string {
  const word = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

  if (method === 'config.set') {
    return word(params.key)
  }

  if (method === 'command.dispatch') {
    return word(params.name)?.replace(/^\//, '') ?? null
  }

  if (method === 'slash.exec') {
    return word(params.command)?.replace(/^\//, '').split(/\s+/)[0] ?? null
  }

  if (method.endsWith('.manage')) {
    return word(params.action)
  }

  return null
}

export function rpcEntries(method: string, params: Readonly<Record<string, unknown>> = {}): string[] {
  const entries = [`rpc:${method}`]
  const action = rpcAction(method, params)

  if (action) {
    entries.push(`rpc:${method}/${action}`)

    if (method === 'command.dispatch' || method === 'slash.exec') {
      entries.push(`slash:${action.toLowerCase()}`)
    }
  }

  return entries
}

export const ipcEntries = (channel: string): string[] => [`ipc:${channel}`]

/** Whether any row lists an IPC channel (only those are tracked for re-registration). */
export const isPolicyIpcChannel = (channel: string): boolean => rowsForEntry(`ipc:${channel}`) !== null

// ── Decisions ───────────────────────────────────────────────────────────────

export type DecisionAction = 'allowed_in_report' | 'refused'

/** What a surface records about a call (Electron main stamps `ts` and `source` and appends it to the decisions file). */
export interface FeatureDecisionRecord {
  action: DecisionAction
  /** The row id that decided (the first, in registry order, of the rows refusing the entry). */
  id: string
  mode: 'enforce' | 'off' | 'report'
  /** Which surface: `rest`, `rpc`, `ipc`, `deep-link`, `devtools`, `route`, `slash`, `keybind`, … */
  surface: string
  /** What was called (`PUT /api/env`, `billing.state`, `hermes:cloud:login`, …). */
  target: string
}

export interface FeatureDecision {
  allowed: boolean
  /** Null when there is nothing to record (allowed, or the master switch is `off`). */
  record: FeatureDecisionRecord | null
}

export type FeatureDecider = (entries: readonly string[], surface: string, target: string) => FeatureDecision

/**
 * Decide calls under one effective client config. `enforce` refuses (and
 * records the refusal); `off` lets everything through but remove rows, and
 * records nothing.
 */
export function featureDecider(config: unknown): FeatureDecider {
  const states = featureStates(config)

  return (entries, surface, target) => {
    for (const entry of entries) {
      const rows = rowsForEntry(entry)

      if (rows === null || rows.some(states.on)) {
        continue
      }

      return {
        allowed: false,
        record: states.filtering ? { action: 'refused', id: rows[0], mode: states.mode, surface, target } : null
      }
    }

    return { allowed: true, record: null }
  }
}
