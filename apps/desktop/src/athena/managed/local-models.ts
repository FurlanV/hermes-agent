/**
 * Local models in the renderer (F05 slices 07 and 08): what the HPC bridge is doing, and what a pick of a local
 * model that is not connected does.
 *
 * - `$hpcBridge` is the renderer's copy of main's bridge status (`window.athenaDesktop.hpcBridge`,
 *   electron/athena/hpc-bridge-types.ts). Main pushes every change; nothing here decides anything about the
 *   connection. It stays null while feature row F05 is off (main registers no handler then).
 * - While local models are on (the config's `local_models.enabled` and row F05) every picker lists the local models
 *   of the role's config whether or not the bridge is up (`pickerModels`). The model gate does not change: a model
 *   whose server is not connected is still refused at the JSON-RPC and REST seams.
 * - A pick of one that is not connected never reaches hermes (`offerLocalModelConnect`, the first line of the
 *   app's own `selectModel`). It offers to connect instead: the sign-in dialog when main holds nothing to sign in
 *   with, else a plain reconnect. Once the model's server is up the pick is made for the user (`pendingPick`).
 * - A session that is on a local model when the bridge is not up (F05 slice 08): while the bridge is on its way
 *   (connecting, or retrying with a password or key main holds) the session is left alone for up to 30 s
 *   (`localModelGrace`). Otherwise it moves to the role default as for a removed model, with a note that says the
 *   model is not connected and a Connect button that brings the session back to it (`reconnectSession`).
 * - The password is typed into the dialog (local-models-dialog.tsx) and handed to main once, by `signIn`. It is
 *   kept nowhere in the renderer: no store here ever holds it.
 */

import { atom, computed } from 'nanostores'

import { notify } from '@/store/notifications'
import { $activeSessionId } from '@/store/session'

import type { AthenaHpcBridgeApi, HpcBridgeSignIn, HpcBridgeStatus } from '../../../electron/athena/hpc-bridge-types'
import {
  findModelEntry,
  localModelsOn,
  type ManagedModelEntry,
  type ManagedModels,
  sameProvider
} from '../../../electron/athena/model-policy'

import { $clientConfig } from './client-config'

export type { HpcBridgeStatus }

/** What a pick asks for (the app's `ModelSelection`, src/app/shell/use-model-menu-controller.ts). */
export interface LocalModelPick {
  model: string
  provider: string
  sessionId?: null | string
}

/** Main's bridge status; null before the first answer, outside Electron, and while row F05 is off. */
export const $hpcBridge = atom<HpcBridgeStatus | null>(null)

const bridgeApi = (): AthenaHpcBridgeApi | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as { athenaDesktop?: { hpcBridge?: AthenaHpcBridgeApi } }).athenaDesktop?.hpcBridge

const isStatus = (value: unknown): value is HpcBridgeStatus =>
  Boolean(value) && typeof value === 'object' && typeof (value as HpcBridgeStatus).state === 'string'

function setStatus(value: unknown): void {
  if (isStatus(value)) {
    $hpcBridge.set(value)
  }
}

/** Ask main for the status now (after the row came on, the channels exist only from then). */
export function refreshHpcBridge(): void {
  const api = bridgeApi()

  if (!api) {
    return
  }

  void Promise.resolve()
    .then(() => api.status())
    .then(setStatus, () => $hpcBridge.set(null))
}

// ── Which local models a picker lists ───────────────────────────────────────

/** The role's local models that are not connected now (empty while local models are off). */
export function offlineLocalModels(models: ManagedModels | null): readonly ManagedModelEntry[] {
  if (!models || !models.localModels.on) {
    return []
  }

  return models.localModels.configured.filter(entry => !findModelEntry(models, entry.id))
}

/**
 * The list the pickers show: the models that can be called, plus the local models that are not connected, so a user
 * can pick one and be offered the connection. Only `visible` grows; what may be called (`entries`) does not.
 */
export function pickerModels(models: ManagedModels): ManagedModels {
  const offline = offlineLocalModels(models)

  return offline.length > 0 ? { ...models, visible: [...models.visible, ...offline] } : models
}

/** The local model a pick names, when it is one that is not connected. */
export function offlineLocalModel(models: ManagedModels | null, pick: LocalModelPick): ManagedModelEntry | undefined {
  return offlineLocalModels(models).find(
    entry => entry.id === pick.model.trim() && (!pick.provider.trim() || sameProvider(entry.provider, pick.provider))
  )
}

// ── The sign-in dialog ──────────────────────────────────────────────────────

export interface LocalModelsDialogState {
  /** The label of the model the user picked, when the dialog opened from a pick. */
  label?: string
  open: boolean
}

export const $localModelsDialog = atom<LocalModelsDialogState>({ open: false })

export function openLocalModelsDialog(label?: string): void {
  $localModelsDialog.set({ ...(label ? { label } : {}), open: true })
}

/** Close the dialog. `cancelled` also drops the pick that was waiting for the connection. */
export function closeLocalModelsDialog(options: { cancelled?: boolean } = {}): void {
  if (options.cancelled) {
    pending = null
  }

  $localModelsDialog.set({ open: false })
}

/** Why a sign-in or a connect did not go through, as main said it; null when it is connecting or connected. */
export function connectFailure(status: HpcBridgeStatus | null): null | string {
  if (!status) {
    return 'unavailable'
  }

  if (status.state === 'connected' || status.state === 'connecting') {
    return null
  }

  return status.reason ?? status.state
}

/**
 * Hand the dialog's user name and password to main, once. Answers main's status when the attempt has settled. The
 * password is not kept here, and no store sees it.
 */
export async function signInToLocalModels(signIn: HpcBridgeSignIn): Promise<HpcBridgeStatus | null> {
  const api = bridgeApi()

  if (!api) {
    return null
  }

  try {
    const status: unknown = await api.connect({ password: signIn.password, username: signIn.username })

    setStatus(status)

    return isStatus(status) ? status : null
  } catch {
    return null
  }
}

// ── A pick of a local model that is not connected ───────────────────────────

/** How long a pick waits for its model's server to come up before it is dropped. */
export const PENDING_PICK_MS = 120_000

interface PendingPick {
  /** The primary session when the pick was made (a pick without a session id targets it). */
  activeSession: null | string
  at: number
  pick: LocalModelPick
}

let pending: null | PendingPick = null

/** The pick waiting for the connection (tests). */
export const pendingLocalModelPick = (): LocalModelPick | null => pending?.pick ?? null

type Select = (pick: LocalModelPick) => Promise<boolean> | void

let selector: null | Select = null

/** The app's own model pick (`selectModel`), given by the main window's controller (model-switch.tsx). */
export function setLocalModelSelector(select: null | Select): void {
  selector = select
}

/** What the picker's caller is told about a pick that was not made (`null`: the dialog says it). */
export const LOCAL_MODELS_CONNECTING = 'Connecting to local models…'
export const LOCAL_MODELS_UNAVAILABLE = 'Local models are not available right now.'
export const modelServerDownMessage = (label?: string): string =>
  `${label ?? 'This local model'} is not connected: model server not answering. Athena keeps trying.`
export const LOCAL_MODELS_NOT_IN_BUILD =
  'This version of Athena cannot connect to local models. Contact your administrator.'

let managedModelsReader: () => ManagedModels | null = () => null

/** `enforcedModels` of model-policy.ts, given at install (that module imports this one). */
export function setManagedModelsReader(reader: () => ManagedModels | null): void {
  managedModelsReader = reader
}

/**
 * The first line of the app's `selectModel`: true when the pick names a local model that is not connected. The pick
 * is then not made; it waits, and the user is offered the connection:
 * - main holds nothing to sign in with (no password since the app started, or the HPC refused it): the dialog;
 * - main holds a password or a key but is not connected: it is asked to connect now.
 */
export function offerLocalModelConnect(pick: LocalModelPick): boolean {
  const entry = offlineLocalModel(managedModelsReader(), pick)

  if (!entry) {
    return false
  }

  pending = { activeSession: $activeSessionId.get(), at: Date.now(), pick: { ...pick } }
  offerConnect(entry.label)

  return true
}

/** Offer the connection for a local model (from a pick, or from a "Connect" button). */
export function offerConnect(label?: string): void {
  const api = bridgeApi()
  const status = $hpcBridge.get()

  if (!api || !status) {
    pending = null
    notify({ id: 'athena-local-models', kind: 'warning', message: LOCAL_MODELS_UNAVAILABLE })

    return
  }

  if (status.state === 'host_key_unknown') {
    // This build cannot check the login node, so it never contacts it: asking for a password would be for nothing.
    pending = null
    notify({ id: 'athena-local-models', kind: 'warning', message: LOCAL_MODELS_NOT_IN_BUILD })

    return
  }

  const refused = status.reason === 'auth_failed' || status.reason === 'auth_unsupported'
  const held = status.credential ?? (status.state === 'connected' ? 'key' : 'none')

  if (status.state === 'no_key' || held === 'none' || refused) {
    openLocalModelsDialog(label)

    return
  }

  if (status.state === 'connecting') {
    notify({ id: 'athena-local-models', kind: 'info', message: LOCAL_MODELS_CONNECTING })

    return
  }

  if (status.state === 'connected') {
    // The connection to the HPC is there; the model's own server is what is missing. Main asks for it again by
    // itself, and the pick is made when it answers.
    const checking = Object.values(status.servers ?? {}).some(server => server.state === 'checking')

    notify({
      id: 'athena-local-models',
      kind: checking ? 'info' : 'warning',
      message: checking ? LOCAL_MODELS_CONNECTING : modelServerDownMessage(label)
    })

    return
  }

  notify({ id: 'athena-local-models', kind: 'info', message: LOCAL_MODELS_CONNECTING })
  void Promise.resolve()
    .then(() => api.connect())
    .then(setStatus, () => {})
}

/** A "Connect" button on a session that was moved off a local model: connect, then bring the session back to it. */
export function reconnectSession(
  entry: Pick<ManagedModelEntry, 'id' | 'label' | 'provider'>,
  sessionId?: string
): void {
  pending = {
    activeSession: $activeSessionId.get(),
    at: Date.now(),
    pick: { model: entry.id, provider: entry.provider, ...(sessionId ? { sessionId } : {}) }
  }
  offerConnect(entry.label)
  settlePendingPick(managedModelsReader())
}

// ── A session on a local model while the bridge is on its way ───────────────

/** How long a session on a local model waits for the bridge before it is moved to the role default. */
export const LOCAL_MODEL_GRACE_MS = 30_000

let followingSince = Date.now()

/**
 * Whether a session on this local model should be left alone for now: the bridge is connecting, or retrying with
 * what main holds, or main already says the model's server is up (the role's list follows within a moment). Answers
 * how long is left of the 30 s (0: no grace). At launch, before main has said anything, the wait counts from when
 * this window started to follow the bridge.
 */
export function localModelGrace(entry: Pick<ManagedModelEntry, 'server'>, now: number = Date.now()): number {
  if (!$localModelsOn.get() || !bridgeApi()) {
    return 0
  }

  const status = $hpcBridge.get()

  if (!status) {
    return Math.max(0, LOCAL_MODEL_GRACE_MS - (now - followingSince))
  }

  const server = status.servers?.[entry.server ?? 'default']
  const refused = status.reason === 'auth_failed' || status.reason === 'auth_unsupported'
  const held = (status.credential ?? 'none') !== 'none'

  const onItsWay =
    status.state === 'connecting' ||
    (status.state === 'connected' && (server?.state === 'checking' || server?.state === 'up')) ||
    (status.state === 'down' && held && !refused && status.reason !== 'host_key_mismatch')

  if (!onItsWay) {
    return 0
  }

  const since = Date.parse(status.since)

  return Math.max(0, LOCAL_MODEL_GRACE_MS - (now - (Number.isFinite(since) ? since : now)))
}

/** How long after its model is listed a waiting pick is made: hermes learns the provider just after the list does. */
let pickDelayMs = 1500

export function setPendingPickDelay(ms: number): void {
  pickDelayMs = ms
}

let pickTimer: null | ReturnType<typeof setTimeout> = null

/** Make the waiting pick once its model can be called. Called on every change of the role's list. */
export function settlePendingPick(models: ManagedModels | null): void {
  if (!pending) {
    return
  }

  if (Date.now() - pending.at > PENDING_PICK_MS) {
    pending = null

    return
  }

  if (!models || !findModelEntry(models, pending.pick.model) || pickTimer) {
    return
  }

  pickTimer = setTimeout(() => {
    pickTimer = null
    const waiting = pending
    pending = null

    // The primary composer moved to another session meanwhile: the pick was for the one it left.
    if (!waiting || !selector || (!waiting.pick.sessionId && $activeSessionId.get() !== waiting.activeSession)) {
      return
    }

    const select = selector

    void (async () => {
      try {
        await select(waiting.pick)
      } catch {
        // the pick's own error toast said it
      }
    })()
  }, pickDelayMs)
}

/** Forget the waiting pick and the dialog (tests, and the uninstall). */
export function resetLocalModels(): void {
  pending = null

  if (pickTimer) {
    clearTimeout(pickTimer)
    pickTimer = null
  }

  $localModelsDialog.set({ open: false })
  $hpcBridge.set(null)
}

// ── Following main ──────────────────────────────────────────────────────────

/** Whether the current config turns local models on (the switch and row F05). */
export const $localModelsOn = computed($clientConfig, snapshot =>
  Boolean(snapshot && snapshot.variant !== 'stock' && localModelsOn(snapshot.config))
)

/** Follow main's bridge status. Returns the unsubscribe; a no-op without the bridge (outside Electron). */
export function connectHpcBridge(): () => void {
  const api = bridgeApi()

  if (!api) {
    return () => {}
  }

  followingSince = Date.now()
  const offChanged = api.onChanged(setStatus)

  // The channels exist only while the row is on: ask again each time local models come on, forget when they go.
  const offOn = $localModelsOn.subscribe(on => {
    if (on) {
      refreshHpcBridge()
    } else {
      pending = null
      $hpcBridge.set(null)
      $localModelsDialog.set({ open: false })
    }
  })

  return () => {
    offChanged()
    offOn()
  }
}
