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

import { rpcEntries } from '../../../electron/athena/backend-policy'
import { featureEntryFilter } from '../../../electron/athena/feature-registry'
import { backendDecider } from '../../../electron/athena/tool-install-policy'

import { $clientConfig, type ClientConfigSnapshot } from './client-config'
import { setFeatureDecider } from './feature-use'
import { ALLOW_ALL_FEATURES, setFeatureFilter } from './features'
import { managedModelsForSnapshot, modelRpcAllowed } from './model-policy'
import { recordPolicyDecision } from './policy-decisions'
import { ALLOW_ALL_RPC, type RpcPolicy, setRpcPolicy } from './rpc-seam'

/**
 * The filter for a snapshot. No snapshot yet (or no Electron bridge): the build defaults. The stock variant
 * (`variant: 'stock'`, electron/athena/variant.ts) allows everything: the managed client is the Athena variant's.
 */
export const filterForSnapshot = (snapshot: ClientConfigSnapshot | null) =>
  snapshot?.variant === 'stock' ? ALLOW_ALL_FEATURES : featureEntryFilter(snapshot?.config ?? {})

/**
 * The JSON-RPC policy for a snapshot: a method (or its action) reaching a refused entry is refused and recorded, and
 * so is a model pick outside the role's list.
 */
export function rpcPolicyForSnapshot(snapshot: ClientConfigSnapshot | null): RpcPolicy {
  if (snapshot?.variant === 'stock') {
    return ALLOW_ALL_RPC
  }

  const decide = backendDecider(snapshot?.config ?? {})
  const models = managedModelsForSnapshot(snapshot)

  return (method, params) => {
    const decision = decide(rpcEntries(method, params), 'rpc', method)
    recordPolicyDecision(decision.record)

    // A request that picks a model also asks the role's list (managed.models, slice 20).
    return decision.allowed && modelRpcAllowed(models, method, params)
  }
}

/** Follow `$clientConfig`; returns the unsubscribe (which restores allow-everything). */
export function installFeaturePolicy(): () => void {
  const off = $clientConfig.subscribe(snapshot => {
    setFeatureFilter(filterForSnapshot(snapshot))
    setRpcPolicy(rpcPolicyForSnapshot(snapshot))
    setFeatureDecider(snapshot?.variant === 'stock' ? null : backendDecider(snapshot?.config ?? {}))
  })

  return () => {
    off()
    setFeatureFilter(null)
    setRpcPolicy(null)
    setFeatureDecider(null)
  }
}
