// Athena: main-process policies built from the verified client config (F02 slices 16 and 17).
//
// Each new snapshot installs every main seam (policy-seams.ts) from the feature
// registry, through one decider (backend-policy.ts):
// - deep links: an OS deep link that reaches a refused feature
//   (`hermes://open/settings?tab=billing`, `hermes://open/cron`, a refused
//   `hermes://<kind>/…`) is dropped by `handleDeepLink` with a log line;
// - REST: `hermes:api` refuses a call reaching a refused `rest:`, `credential:`
//   or `env:` entry, and always refuses `PUT`/`DELETE /api/env` of a
//   managed-scope variable;
// - IPC: a refused `ipc:` channel is unregistered, and re-registered when its
//   row turns on (the next snapshot after a sync);
// - DevTools: refused while S65 is off;
// - the Settings default model (`POST /api/model/set`): refused outside the
//   role's list under `managed.models: enforce`, recorded under `report`.
// Decisions worth recording go to the policy-decisions file
// (policy-decisions.ts) when one is configured.

import { deepLinkEntries, type DeepLinkLike } from './app-locations'
import {
  type FeatureDecider,
  type FeatureDecisionRecord,
  ipcEntries,
  isManagedScopeEnvWrite,
  restEntries
} from './backend-policy'
import type { ClientConfigSnapshot } from './client-config-types'
import { FEATURE_ROW_BY_ID, featureEntryFilter, featureMode } from './feature-registry'
import { managedModels, modelUseDecision, restModelChoice } from './model-policy'
import type { PolicyDecisionLog } from './policy-decisions'
import { type MainPolicySeams, type RestRequestInfo, setMainPolicySeams } from './policy-seams'
import { backendDecider } from './tool-install-policy'

export function deepLinkPolicy(config: unknown): (link: DeepLinkLike) => boolean {
  const filter = featureEntryFilter(config)

  return link => deepLinkEntries(link).every(filter)
}

let decisions: null | PolicyDecisionLog = null

let log: (line: string) => void = () => {}
const listeners = new Set<() => void>()

/** Where decisions are recorded and listener failures logged (installAthenaClientConfig sets it up). */
export function configureMainPolicies(options: { decisions?: null | PolicyDecisionLog; log?: (line: string) => void }) {
  decisions = options.decisions ?? null
  log = options.log ?? (() => {})
}

/** Run `listener` after every policy change (the app menu rebuilds its DevTools item). Returns the unsubscribe. */
export function onMainPoliciesChanged(listener: () => void): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

export function recordFeatureDecision(record: FeatureDecisionRecord | null): void {
  if (record) {
    decisions?.record({ kind: 'feature', ...record })
  }
}

/** The main seams for one effective client config. The decider also refuses install paths under `managed.tools` (slice 29). */
export function mainPolicySeams(config: unknown, decide: FeatureDecider = backendDecider(config)): MainPolicySeams {
  const mode = featureMode(config)
  const models = managedModels(config)

  const decided = (entries: readonly string[], surface: string, target: string) => {
    const decision = decide(entries, surface, target)
    recordFeatureDecision(decision.record)

    return decision.allowed
  }

  return {
    deepLink: link => decided(deepLinkEntries(link), 'deep-link', `${link.kind}/${link.name}`),
    devTools: () => decided(['devtools:open'], 'devtools', 'devtools'),
    // Asked at registration and on every change: nothing was called, so nothing is recorded.
    ipcChannel: channel => decide(ipcEntries(channel), 'ipc', channel).allowed,
    // A registered tracked channel was used: recorded only when the policy lets through what it would refuse.
    ipcUse: channel => {
      const decision = decide(ipcEntries(channel), 'ipc', channel)

      if (decision.allowed) {
        recordFeatureDecision(decision.record)
      }
    },
    rest: (request: RestRequestInfo) => {
      if (isManagedScopeEnvWrite(request)) {
        const key = (request.body as undefined | { key?: unknown })?.key
        decisions?.record({
          action: 'refused',
          id: 'managed-scope',
          kind: 'feature',
          mode,
          surface: 'rest',
          target: `${request.method} ${request.pathname} ${String(key)}`
        })

        return false
      }

      if (!decided(restEntries(request), 'rest', `${request.method} ${request.pathname}`)) {
        return false
      }

      // Settings › Model's default (S06) asks the role's list (managed.models, slice 20).
      const choice = restModelChoice(request.method, request.pathname, request.body)

      if (!choice) {
        return true
      }

      const decision = modelUseDecision(models, choice, 'rest', `${request.method} ${request.pathname}`)

      if (decision.record) {
        decisions?.record({ kind: 'model', ...decision.record })
      }

      return decision.allowed
    }
  }
}

/** Remove-row ids a config asks to turn on (ignored: remove rows have no flag). */
export function ignoredRemoveRows(config: unknown): string[] {
  const features =
    config && typeof config === 'object' ? (config as { features?: unknown }).features : undefined

  if (!features || typeof features !== 'object') {
    return []
  }

  return Object.entries(features as Record<string, unknown>)
    .filter(([id, value]) => value === 'on' && FEATURE_ROW_BY_ID.get(id)?.mark === 'remove')
    .map(([id]) => id)
}

/** Install main's seams for a snapshot. The stock variant gets allow-all seams (variant.ts). */
export function applyMainPolicies(snapshot: Pick<ClientConfigSnapshot, 'config' | 'variant'>): void {
  setMainPolicySeams(snapshot.variant === 'stock' ? null : mainPolicySeams(snapshot.config))

  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      log(`[athena] policy listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
