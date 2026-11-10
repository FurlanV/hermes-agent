/**
 * The session side of reasoning effort per model (F02 slice 23): which model a
 * slash command's session runs, and the reset of a level the session's model
 * does not offer. Kept apart from `model-reasoning.ts` so the menus that show
 * the levels do not load the session stores.
 */

import { DEFAULT_REASONING_EFFORT } from '@hermes/shared'
import { useEffect, useRef } from 'react'

import { applyModelPreset } from '@/store/model-presets'
import { $activeSessionId, $currentModel, $currentReasoningEffort, $defaultReasoningEffort } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { levelAfterSwitch, modelReasoning, normalizeEffort } from '../../../electron/athena/model-policy'

import { $managedModels, enforcedModels } from './model-policy'

export type RequestGateway = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

/** The model of the session a slash command runs in: a tile's own, else the primary composer's. */
export function sessionModel(sessionId: null | string | undefined): string {
  const tile = sessionId && sessionId !== $activeSessionId.get() ? $sessionStates.get()[sessionId]?.model : ''

  return tile || $currentModel.get()
}

const attempted = new Set<string>()

/** Forget every reset attempt (tests). */
export function resetReasoningResets(): void {
  attempted.clear()
}

interface EffortHolder {
  effort: string
  key: string
  model: string
  primary: boolean
  sessionId: null | string
}

function effortHolders(): EffortHolder[] {
  const primary = $activeSessionId.get()
  const states = $sessionStates.get()

  const holders: EffortHolder[] = [
    {
      effort: $currentReasoningEffort.get(),
      key: primary ?? 'draft',
      model: $currentModel.get(),
      primary: true,
      sessionId: primary
    }
  ]

  for (const [id, state] of Object.entries(states)) {
    if (id !== primary) {
      holders.push({ effort: state.reasoningEffort, key: id, model: state.model, primary: false, sessionId: id })
    }
  }

  return holders
}

/**
 * One pass: every open session whose level its model does not offer gets the
 * model's default (an empty level inherits the profile default, which is
 * checked the same way). Each (session, model, level) is reset once.
 */
export function reconcileReasoningLevels(request: RequestGateway): void {
  const models = enforcedModels()

  if (!models || !models.reasoningControl) {
    return
  }

  for (const holder of effortHolders()) {
    const reasoning = holder.model.trim() ? modelReasoning(models, holder.model) : null

    if (!reasoning) {
      continue
    }

    const current = normalizeEffort(holder.effort || $defaultReasoningEffort.get() || DEFAULT_REASONING_EFFORT)
    const next = levelAfterSwitch(reasoning, current)
    const attempt = `${holder.key}\u0000${holder.model}\u0000${current}`

    if (next === current || attempted.has(attempt)) {
      continue
    }

    attempted.add(attempt)
    void applyModelPreset(
      { effort: next },
      { failMessage: 'Could not reset reasoning effort', primary: holder.primary, request, sessionId: holder.sessionId }
    )
  }
}

/** Follow the role's list and the open sessions; reset levels a model does not offer. Mounted by the controller. */
export function useManagedReasoningReset(request: RequestGateway): void {
  const requestRef = useRef(request)
  requestRef.current = request

  useEffect(() => {
    const run = () => reconcileReasoningLevels((method, params) => requestRef.current(method, params))

    const offs = [$managedModels, $sessionStates, $currentModel, $currentReasoningEffort, $activeSessionId].map(store =>
      store.listen(run)
    )

    run()

    return () => offs.forEach(off => off())
  }, [])
}
