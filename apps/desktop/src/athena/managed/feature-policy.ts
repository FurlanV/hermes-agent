/**
 * Install the feature filter from the verified client config (F02 slice 15).
 *
 * The registry (`electron/athena/feature-registry.ts`, shared with main) maps
 * each audit row to its entry ids; the config's `features` holds the per-role
 * exceptions, already layered by main (bundled default < server < dev
 * override). Every Settings list, the palette, search and the route guard ask
 * the one `$featureFilter`, so a new config re-filters them all at once.
 */

import { featureEntryFilter } from '../../../electron/athena/feature-registry'

import { $clientConfig, type ClientConfigSnapshot } from './client-config'
import { setFeatureFilter } from './features'

/** The filter for a snapshot. No snapshot yet (or no Electron bridge): the build defaults. */
export const filterForSnapshot = (snapshot: ClientConfigSnapshot | null) => featureEntryFilter(snapshot?.config ?? {})

/** Follow `$clientConfig`; returns the unsubscribe (which restores allow-everything). */
export function installFeaturePolicy(): () => void {
  const off = $clientConfig.subscribe(snapshot => setFeatureFilter(filterForSnapshot(snapshot)))

  return () => {
    off()
    setFeatureFilter(null)
  }
}
