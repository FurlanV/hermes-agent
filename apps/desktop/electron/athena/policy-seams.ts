// Athena policy seams in the main process (F02 managed client).
//
// Three places in main decide whether the renderer (or the OS) may reach a
// backend surface:
// - REST: the `hermes:api` handler asks `refuseRestRequest` before forwarding;
// - IPC: privileged channels register through `guardedIpcMain`, so a refused
//   channel is never registered at all (an invoke then fails with Electron's
//   "No handler registered");
// - deep links: `handleDeepLink` asks `deepLinkAllowed` before routing.
//
// Every seam allows everything today. A later slice installs policies built
// from the feature registry and the signed client config with
// `setMainPolicySeams`, before main registers its IPC handlers.
//
// The renderer's JSON-RPC seam is separate (`src/athena/managed/rpc-seam.ts`):
// renderer JSON-RPC goes straight to the gateway's WebSocket and never passes
// through main (check M4).

import type { IpcMain } from 'electron'

export interface RestRequestInfo {
  method: string
  /** As sent, query included (`/api/config?profile=x`). */
  path: string
  /** `path` without its query (`/api/config`). */
  pathname: string
}

export interface DeepLinkInfo {
  /** `hermes://<kind>/<name>?…`: `mcp`, `plugin`, `skill`, `open`, `blueprint`, … */
  kind: string
  name: string
  params: Record<string, string>
}

export interface MainPolicySeams {
  deepLink: (link: DeepLinkInfo) => boolean
  ipcChannel: (channel: string) => boolean
  rest: (request: RestRequestInfo) => boolean
}

export const ALLOW_ALL_MAIN_SEAMS: MainPolicySeams = Object.freeze({
  deepLink: () => true,
  ipcChannel: () => true,
  rest: () => true
})

let seams: MainPolicySeams = ALLOW_ALL_MAIN_SEAMS

/** Install policies (any omitted seam allows everything); `null` restores allow-all. */
export function setMainPolicySeams(next: null | Partial<MainPolicySeams>): void {
  seams = next ? { ...ALLOW_ALL_MAIN_SEAMS, ...next } : ALLOW_ALL_MAIN_SEAMS
}

// ── Refusal contract ─────────────────────────────────────────────────────────
// Mirrors src/athena/managed/policy-refusal.ts: the renderer's
// `PolicyRefusedError.from` recognises this message. Custom Error properties
// do not survive contextBridge, so the message is the type.

export type PolicyRefusalKind = 'deep-link' | 'ipc' | 'rest' | 'rpc'

export const POLICY_REFUSED_CODE = 'refused_by_policy'

export const policyRefusalMessage = (kind: PolicyRefusalKind, target: string): string =>
  `${POLICY_REFUSED_CODE}: ${kind} ${target}`

// ── REST ─────────────────────────────────────────────────────────────────────
// Like the expected-404 seam (api-expected-404.ts), a refusal RESOLVES with a
// sentinel and preload rethrows it, so Electron does not log a stack for it.

export const ATHENA_POLICY_REFUSED = '__athenaPolicyRefused__'

export function restRequestInfo(request: { method?: unknown; path?: unknown } | null | undefined): RestRequestInfo {
  const method = String(request?.method ?? 'GET').toUpperCase()
  const path = String(request?.path ?? '')
  const query = path.search(/[?#]/)

  return { method, path, pathname: query === -1 ? path : path.slice(0, query) }
}

/** The sentinel to resolve with when the request is refused, else null (forward it). */
export function refuseRestRequest(
  request: { method?: unknown; path?: unknown } | null | undefined
): null | Record<typeof ATHENA_POLICY_REFUSED, string> {
  const info = restRequestInfo(request)

  return seams.rest(info) ? null : { [ATHENA_POLICY_REFUSED]: policyRefusalMessage('rest', `${info.method} ${info.pathname}`) }
}

function isPolicyRefusalSentinel(value: unknown): value is Record<typeof ATHENA_POLICY_REFUSED, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const keys = Object.keys(value)

  return keys.length === 1 && keys[0] === ATHENA_POLICY_REFUSED && typeof (value as any)[ATHENA_POLICY_REFUSED] === 'string'
}

/** Preload: a refusal sentinel becomes the rejection the caller sees; anything else passes through. */
export function unwrapPolicyRefusal(value: unknown): unknown {
  if (isPolicyRefusalSentinel(value)) {
    throw new Error(value[ATHENA_POLICY_REFUSED])
  }

  return value
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/**
 * The privileged channels later slices may refuse. Each registers through
 * `guardedIpcMain` (main.ts, fs-ipc.ts). Web access has no IPC channel: it is
 * REST (`/api/webapp-access/*`) and goes through the REST seam.
 */
export const GUARDED_IPC_CHANNELS = Object.freeze({
  pluginInstall: ['hermes:plugin:probe', 'hermes:plugin:installDesktop'],
  hermesCloud: [
    'hermes:cloud:status',
    'hermes:cloud:login',
    'hermes:cloud:logout',
    'hermes:cloud:discover',
    'hermes:cloud:agent-sign-in'
  ],
  updates: ['hermes:updates:check', 'hermes:updates:apply', 'hermes:updates:channel:set']
} as const)

export function ipcChannelAllowed(channel: string): boolean {
  return seams.ipcChannel(channel)
}

/** `ipcMain.handle`, except a channel the policy refuses is not registered. Returns whether it was. */
export function guardedIpcMain(ipc: Pick<IpcMain, 'handle'>) {
  return {
    handle(channel: string, listener: Parameters<IpcMain['handle']>[1]): boolean {
      if (!ipcChannelAllowed(channel)) {
        return false
      }

      ipc.handle(channel, listener)

      return true
    }
  }
}

// ── Deep links ───────────────────────────────────────────────────────────────

export function deepLinkAllowed(link: DeepLinkInfo): boolean {
  return seams.deepLink(link)
}
