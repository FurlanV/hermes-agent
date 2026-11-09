/**
 * Renderer side of the policy-decisions file (F02 slices 17 and 19): a
 * decision the renderer makes (a refused JSON-RPC call, a report-mode use) is
 * sent to Electron main, which stamps it and appends it to
 * `$HERMES_HOME/athena/policy-decisions.jsonl` (electron/athena/policy-decisions.ts).
 * Outside Electron there is no bridge and nothing is recorded.
 */

import type { FeatureDecisionRecord } from '../../../electron/athena/backend-policy'

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
