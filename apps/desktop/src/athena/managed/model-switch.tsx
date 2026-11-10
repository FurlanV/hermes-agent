/**
 * Move open sessions off a removed model (F02 slice 21).
 *
 * When a new client config arrives (`managed.models: enforce`), every open
 * session whose model is no longer on the role's list switches to the role
 * default between turns, through the app's own model pick (`selectModel` in
 * `use-model-controls.ts`: `config.set key=model … --provider
 * custom:athena-gateway`, which the canonical protocol sends as the fenced
 * `session.mutate operation=model` slice 08 recorded, retried once on a fence
 * refusal). A busy session waits for its turn to end; that turn keeps the D07
 * behaviour (the gateway refuses, hermes falls back within the turn). One
 * toast per session: "GPT-6 Sol is no longer available. Switched to GPT-6 Luna."
 *
 * If the switch fails, or no model is left to pick, the composer shows "No
 * model available. Contact your administrator" and cancels sends through a
 * `composer.middleware` contribution (the pattern the Athena desktop plugin's
 * first-run notice uses). Slash commands still go through: they call no model.
 */

import { useStore } from '@nanostores/react'
import { atom, computed } from 'nanostores'
import { useEffect, useRef } from 'react'

import type { ComposerDraft, ComposerMiddleware } from '@/app/chat/composer/contrib'
import type { ModelSelection } from '@/app/shell/model-menu-panel'
import { registry } from '@/contrib/registry'
import { notify } from '@/store/notifications'
import { $activeSessionId, $currentModel, $currentProvider } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { ATHENA_GATEWAY_PROVIDER, findModelEntry, type ManagedModels } from '../../../electron/athena/model-policy'

import { $managedModels, enforcedModels } from './model-policy'

export const NO_MODEL_MESSAGE = 'No model available. Contact your administrator.'

/** The key of the primary composer while it has no live session. */
const DRAFT = 'draft'

/** Sessions whose switch off a removed model failed (runtime id, or `draft`). */
const $failedSwitches = atom<ReadonlySet<string>>(new Set())

/** True while the active composer must not send: no model left to pick, or its switch failed. */
export const $noModelAvailable = computed(
  [$managedModels, $failedSwitches, $activeSessionId],
  (models, failed, active) => {
    const enforced = enforcedModels(models)

    return Boolean(enforced) && (switchTarget(enforced!) === null || failed.has(active ?? DRAFT))
  }
)

/** The model a session moves to: the role default when users may pick it, else the first listed model. */
export function switchTarget(models: ManagedModels): null | string {
  const visible = models.visible.map(entry => entry.id)

  if (visible.length === 0) {
    return null
  }

  return models.default && visible.includes(models.default) ? models.default : visible[0]
}

// Labels of every model a config ever listed: the removed one is gone from the new config.
const knownLabels = new Map<string, string>()
const labelOf = (model: string) => knownLabels.get(model) ?? model
const attempted = new Set<string>()
const toasted = new Set<string>()
const inFlight = new Set<string>()

/** Forget every attempt, toast and failure (tests, and the hook's unmount). */
export function resetModelSwitches(): void {
  attempted.clear()
  toasted.clear()
  inFlight.clear()
  $failedSwitches.set(new Set())
}

function setFailed(key: string, failed: boolean): void {
  const current = $failedSwitches.get()

  if (current.has(key) === failed) {
    return
  }

  const next = new Set(current)

  if (failed) {
    next.add(key)
  } else {
    next.delete(key)
  }

  $failedSwitches.set(next)
}

interface OpenSession {
  busy: boolean
  /** `draft` or the runtime id. */
  key: string
  model: string
  /** Undefined for the primary composer (its pick targets `$activeSessionId`). */
  sessionId?: string
}

function openSessions(): OpenSession[] {
  const primary = $activeSessionId.get()
  const states = $sessionStates.get()

  const sessions: OpenSession[] = [
    { busy: Boolean(primary && states[primary]?.busy), key: primary ?? DRAFT, model: $currentModel.get() }
  ]

  for (const [id, state] of Object.entries(states)) {
    if (id !== primary) {
      sessions.push({ busy: state.busy, key: id, model: state.model, sessionId: id })
    }
  }

  return sessions
}

export type SelectModel = (selection: ModelSelection) => Promise<boolean>

/**
 * One pass: switch every idle open session whose model left the role's list.
 * Safe to call on every store change; each (session, removed model, target)
 * is tried once.
 */
export function reconcileModelSessions(select: SelectModel): void {
  const models = enforcedModels()

  if (!models) {
    return
  }

  for (const entry of models.entries) {
    knownLabels.set(entry.id, entry.label)
  }

  const target = switchTarget(models)

  for (const session of openSessions()) {
    const model = session.model.trim()

    // Only the model id is compared: hermes may report the gateway entry as `custom`.
    if (!model || findModelEntry(models, model)) {
      setFailed(session.key, false)

      continue
    }

    if (!target) {
      continue
    }

    const attempt = `${session.key}\u0000${model}\u0000${target}`

    if (session.busy || attempted.has(attempt) || inFlight.has(session.key)) {
      continue
    }

    attempted.add(attempt)
    inFlight.add(session.key)

    const selection: ModelSelection = {
      model: target,
      provider: ATHENA_GATEWAY_PROVIDER,
      ...(session.sessionId ? { sessionId: session.sessionId } : {})
    }

    void select(selection)
      .catch(() => false)
      .then(applied => {
        inFlight.delete(session.key)
        setFailed(session.key, !applied)

        const toast = `${session.key}\u0000${model}`

        if (applied && !toasted.has(toast)) {
          toasted.add(toast)
          notify({
            id: `athena-model-removed-${session.key}`,
            kind: 'info',
            message: `${labelOf(model)} is no longer available. Switched to ${labelOf(target)}.`
          })
        }
      })
  }
}

// ── The composer gate ───────────────────────────────────────────────────────

const middleware: ComposerMiddleware = {
  handler: (draft: ComposerDraft) => {
    if (!$noModelAvailable.get() || draft.text.trim().startsWith('/')) {
      return draft
    }

    notify({ id: 'athena-no-model', kind: 'warning', message: NO_MODEL_MESSAGE })

    return null
  }
}

function NoModelBanner() {
  const blocked = useStore($noModelAvailable)

  return blocked ? (
    <div
      className="mx-3 mb-1 rounded-md border border-(--ui-border-subtle) px-3 py-2 text-xs text-(--ui-text-secondary)"
      data-testid="athena-no-model"
      role="alert"
    >
      {NO_MODEL_MESSAGE}
    </div>
  ) : null
}

/** Register the composer gate (middleware first in the chain, and the banner above the input). Returns the removal. */
export function installNoModelGate(): () => void {
  return registry.registerMany([
    { area: 'composer.middleware', data: middleware, id: 'athena-no-model-gate', order: -1000, source: 'athena' },
    { area: 'composer.top', id: 'athena-no-model-banner', order: -1000, render: () => <NoModelBanner />, source: 'athena' }
  ])
}

/**
 * Follow the role's list and the open sessions; switch sessions off removed
 * models with `select` (the app's own model pick). Mounted once, by the main
 * window's controller.
 */
export function useManagedModelSwitch(select: SelectModel): void {
  const selectRef = useRef(select)
  selectRef.current = select

  useEffect(() => {
    const removeGate = installNoModelGate()
    const run = () => reconcileModelSessions(selection => selectRef.current(selection))

    const offs = [$managedModels, $sessionStates, $currentModel, $currentProvider, $activeSessionId].map(store =>
      store.listen(run)
    )

    run()

    return () => {
      offs.forEach(off => off())
      removeGate()
    }
  }, [])
}
