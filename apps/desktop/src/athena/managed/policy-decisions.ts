/**
 * Renderer side of the policy-decisions file (F02 slices 17 and 19): a
 * decision the renderer makes (a refused JSON-RPC call, a report-mode use) is
 * sent to Electron main, which stamps it and appends it to
 * `$HERMES_HOME/athena/policy-decisions.jsonl` (electron/athena/policy-decisions.ts).
 * Outside Electron there is no bridge and nothing is recorded.
 */

import type { FeatureDecisionRecord } from '../../../electron/athena/backend-policy'
import type { ModelDecisionRecord } from '../../../electron/athena/model-policy'

interface AthenaPolicyBridge {
  record: (decision: unknown) => void
}

const bridge = (): AthenaPolicyBridge | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as { athenaDesktop?: { policy?: AthenaPolicyBridge } }).athenaDesktop?.policy

export function recordPolicyDecision(record: FeatureDecisionRecord | null): void {
  if (!record) {
    return
  }

  try {
    bridge()?.record({ kind: 'feature', ...record })
  } catch {
    // a closing window: the decision is lost, the call is still decided
  }
}

/** A model use worth recording (slice 20): a pick outside the role's list, refused or let through in report mode. */
export function recordModelDecision(record: ModelDecisionRecord | null): void {
  if (!record) {
    return
  }

  try {
    bridge()?.record({ kind: 'model', ...record })
  } catch {
    // a closing window: the decision is lost, the pick is still decided
  }
}
