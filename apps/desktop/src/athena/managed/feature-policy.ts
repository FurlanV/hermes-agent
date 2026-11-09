/**
 * Install the feature policy from the verified client config (F02 slices 15 and 17).
 *
 * The registry (`electron/athena/feature-registry.ts`, shared with main) maps
 * each audit row to its entry ids; the config's `features` holds the per-role
 * exceptions, already layered by main (bundled default < server < dev
 * override). Every Settings list, the palette, search and the route guard ask
 * the one `$featureFilter`, and every gateway JSON-RPC request (desktop
 * plugins' `host.request` included) asks the JSON-RPC seam, so a new config
 * re-filters and re-opens them all at once.
 */

import { featureDecider, rpcEntries } from '../../../electron/athena/backend-policy'
import { featureEntryFilter } from '../../../electron/athena/feature-registry'

import { $clientConfig, type ClientConfigSnapshot } from './client-config'
import { setFeatureFilter } from './features'
import { recordPolicyDecision } from './policy-decisions'
import { type RpcPolicy, setRpcPolicy } from './rpc-seam'

/** The filter for a snapshot. No snapshot yet (or no Electron bridge): the build defaults. */
export const filterForSnapshot = (snapshot: ClientConfigSnapshot | null) => featureEntryFilter(snapshot?.config ?? {})

/** The JSON-RPC policy for a snapshot: a method (or its action) reaching a refused entry is refused and recorded. */
export function rpcPolicyForSnapshot(snapshot: ClientConfigSnapshot | null): RpcPolicy {
  const decide = featureDecider(snapshot?.config ?? {})

  return (method, params) => {
    const decision = decide(rpcEntries(method, params), 'rpc', method)
    recordPolicyDecision(decision.record)

    return decision.allowed
  }
}

/** Follow `$clientConfig`; returns the unsubscribe (which restores allow-everything). */
export function installFeaturePolicy(): () => void {
  const off = $clientConfig.subscribe(snapshot => {
    setFeatureFilter(filterForSnapshot(snapshot))
    setRpcPolicy(rpcPolicyForSnapshot(snapshot))
  })

  return () => {
    off()
    setFeatureFilter(null)
    setRpcPolicy(null)
  }
}
