// Athena policy seams in the main process (F02 managed client).
//
// Four places in main decide whether the renderer (or the OS) may reach a
// backend surface:
// - REST: the `hermes:api` handler asks `refuseRestRequest` before forwarding;
// - IPC: a policy channel is tracked when it registers (through
//   `guardedIpcMain`, or any `ipcMain.handle`/`on` once `installIpcPolicyGuard`
//   wrapped `ipcMain`), and is registered only while the policy allows it. A
//   refused channel is not registered at all (an invoke then fails with
//   Electron's "No handler registered"); each `setMainPolicySeams` reconciles
//   every tracked channel, so turning a row on re-registers its handlers;
// - deep links: `handleDeepLink` asks `deepLinkAllowed` before routing;
// - DevTools: `toggleDevTools` asks `devToolsAllowed`.
//
// Every seam allows everything until `main-policy.ts` installs policies built
// from the feature registry and the signed client config (slice 17).
//
// The renderer's JSON-RPC seam is separate (`src/athena/managed/rpc-seam.ts`):
// renderer JSON-RPC goes straight to the gateway's WebSocket and never passes
// through main (check M4).

import type { IpcMain } from 'electron'

export interface RestRequestInfo {
  /** The request body as sent (an /api/env write names its key here). */
  body?: unknown
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
  devTools: () => boolean
  /** Whether a tracked channel may be registered (asked at registration and on every policy change). */
  ipcChannel: (channel: string) => boolean
  /** Called on each use of a tracked channel that is registered (report-mode records hook in here). */
  ipcUse: (channel: string) => void
  rest: (request: RestRequestInfo) => boolean
}

export const ALLOW_ALL_MAIN_SEAMS: MainPolicySeams = Object.freeze({
  deepLink: () => true,
  devTools: () => true,
  ipcChannel: () => true,
  ipcUse: () => {},
  rest: () => true
})

let seams: MainPolicySeams = ALLOW_ALL_MAIN_SEAMS

/** Install policies (any omitted seam allows everything); `null` restores allow-all. Tracked IPC follows at once. */
export function setMainPolicySeams(next: null | Partial<MainPolicySeams>): void {
  seams = next ? { ...ALLOW_ALL_MAIN_SEAMS, ...next } : ALLOW_ALL_MAIN_SEAMS
  reconcileIpcRegistrations()
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

  return { body: (request as { body?: unknown } | null | undefined)?.body, method, path, pathname: query === -1 ? path : path.slice(0, query) }
}

/** The sentinel to resolve with when the request is refused, else null (forward it). */
export function refuseRestRequest(
  request: { body?: unknown; method?: unknown; path?: unknown } | null | undefined
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
 * Channels registered through `guardedIpcMain` by name (main.ts, fs-ipc.ts).
 * Every other policy channel (the registry's `ipc:` entries) is caught by
 * `installIpcPolicyGuard`. Web access has no IPC channel: it is REST
 * (`/api/webapp-access/*`) and goes through the REST seam.
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

type IpcListener = (...args: any[]) => any
type RawIpc = Pick<IpcMain, 'handle' | 'removeHandler'> & Partial<Pick<IpcMain, 'on' | 'removeListener'>>

interface TrackedRegistration {
  channel: string
  ipc: RawIpc
  kind: 'handle' | 'on'
  registered: boolean
  /** The listener Electron holds: the original, wrapped so each use reaches `ipcUse`. */
  wrapped: IpcListener
}

const tracked: TrackedRegistration[] = []

/** The unwrapped methods of an `ipcMain` that `installIpcPolicyGuard` replaced (else the object itself). */
const RAW = new WeakMap<object, RawIpc>()

const rawOf = (ipc: RawIpc): RawIpc => RAW.get(ipc) ?? ipc

function setRegistered(entry: TrackedRegistration, on: boolean): void {
  if (entry.registered === on) {
    return
  }

  if (entry.kind === 'handle') {
    if (on) {
      entry.ipc.handle(entry.channel, entry.wrapped)
    } else {
      entry.ipc.removeHandler(entry.channel)
    }
  } else if (on) {
    entry.ipc.on?.(entry.channel, entry.wrapped)
  } else {
    entry.ipc.removeListener?.(entry.channel, entry.wrapped)
  }

  entry.registered = on
}

function track(ipc: RawIpc, kind: TrackedRegistration['kind'], channel: string, listener: IpcListener): boolean {
  const wrapped: IpcListener = (...args) => {
    seams.ipcUse(channel)

    return listener(...args)
  }

  const entry: TrackedRegistration = { channel, ipc, kind, registered: false, wrapped }
  tracked.push(entry)
  setRegistered(entry, ipcChannelAllowed(channel))

  return entry.registered
}

/** Register or remove every tracked channel to match the current policy. */
export function reconcileIpcRegistrations(): void {
  for (const entry of tracked) {
    setRegistered(entry, ipcChannelAllowed(entry.channel))
  }
}

/** Tracked channels and whether each is registered now (tests, diagnostics). */
export function trackedIpcChannels(): { channel: string; registered: boolean }[] {
  return tracked.map(({ channel, registered }) => ({ channel, registered }))
}

/** Tests: forget tracked registrations (it does not unregister them). */
export function resetIpcTrackingForTests(): void {
  tracked.length = 0
}

/** `ipcMain.handle`, except the channel is registered only while the policy allows it. Returns whether it is now. */
export function guardedIpcMain(ipc: RawIpc) {
  return {
    handle(channel: string, listener: Parameters<IpcMain['handle']>[1]): boolean {
      return track(rawOf(ipc), 'handle', channel, listener)
    }
  }
}

/**
 * Route `ipcMain.handle`/`on` for channels `isPolicyChannel` names through the
 * tracker, so modules that register their own channels (uninstall, terminal,
 * the free-tier challenge…) follow the policy without a hook each. Call it
 * before anything registers (main.ts imports `ipc-guard-install` first).
 * Other channels pass through untouched.
 */
export function installIpcPolicyGuard(ipc: IpcMain, isPolicyChannel: (channel: string) => boolean): void {
  if (RAW.has(ipc)) {
    return
  }

  const raw: RawIpc = {
    handle: ipc.handle.bind(ipc),
    on: ipc.on.bind(ipc),
    removeHandler: ipc.removeHandler.bind(ipc),
    removeListener: ipc.removeListener.bind(ipc)
  }

  RAW.set(ipc, raw)

  ipc.handle = ((channel: string, listener: IpcListener) => {
    if (isPolicyChannel(channel)) {
      track(raw, 'handle', channel, listener)
    } else {
      raw.handle(channel, listener)
    }
  }) as IpcMain['handle']

  ipc.on = ((channel: string, listener: IpcListener) => {
    if (isPolicyChannel(channel)) {
      track(raw, 'on', channel, listener)
    } else {
      raw.on!(channel, listener)
    }

    return ipc
  }) as IpcMain['on']

  // A module that swaps its own handler (removeHandler, then handle) must not leave a stale tracked copy.
  ipc.removeHandler = ((channel: string) => {
    if (isPolicyChannel(channel)) {
      untrack(channel, 'handle')
    } else {
      raw.removeHandler(channel)
    }
  }) as IpcMain['removeHandler']
}

function untrack(channel: string, kind: TrackedRegistration['kind']): void {
  for (let index = tracked.length - 1; index >= 0; index -= 1) {
    const entry = tracked[index]

    if (entry.channel === channel && entry.kind === kind) {
      setRegistered(entry, false)
      tracked.splice(index, 1)
    }
  }
}

// ── Deep links ───────────────────────────────────────────────────────────────

export function deepLinkAllowed(link: DeepLinkInfo): boolean {
  return seams.deepLink(link)
}

// ── DevTools ─────────────────────────────────────────────────────────────────

/** Whether DevTools may open (F12, the inspect chord, View › Toggle Developer Tools). */
export function devToolsAllowed(): boolean {
  return seams.devTools()
}
