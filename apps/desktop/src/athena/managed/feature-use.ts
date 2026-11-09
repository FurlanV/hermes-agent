/**
 * Uses of a feature (F02 slice 19), as opposed to listing it. A list (nav,
 * palette, search, the key map, error-card buttons) asks the visibility
 * filter (`$featureFilter`); a use (a page opened, a shortcut run, a slash
 * command sent, a JSON-RPC call) asks `decideUse`, which applies the master
 * switch `managed.features`:
 * - `enforce`: refused, and the refusal recorded;
 * - `report`: allowed, and recorded as `allowed_in_report`;
 * - `off`: allowed, nothing recorded.
 * Records go to Electron main (policy-decisions.ts), which appends them to
 * `$HERMES_HOME/athena/policy-decisions.jsonl` for the Shipper.
 */

import { atom } from 'nanostores'

import type { FeatureDecider } from '../../../electron/athena/backend-policy'

import { $featureFilter } from './features'
import { recordPolicyDecision } from './policy-decisions'

export const ALLOW_ALL_DECIDER: FeatureDecider = () => ({ allowed: true, record: null })

export const $featureDecider = atom<FeatureDecider>(ALLOW_ALL_DECIDER)

/** Install a decider (`null` restores allow-everything, recording nothing). */
export function setFeatureDecider(decider: FeatureDecider | null): void {
  $featureDecider.set(decider ?? ALLOW_ALL_DECIDER)
}

/**
 * Whether a use may go ahead; records the decision when there is one to record. The visibility filter still has
 * its say (it and the decider come from the same snapshot; a filter installed on its own, as tests do, governs).
 */
export function decideUse(entries: readonly string[], surface: string, target: string): boolean {
  const decision = $featureDecider.get()(entries, surface, target)
  recordPolicyDecision(decision.record)

  return decision.allowed && entries.every($featureFilter.get())
}
