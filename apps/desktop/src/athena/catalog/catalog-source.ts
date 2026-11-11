/**
 * The tool catalog in force, in the renderer (F03 slice 02): the one place the Capabilities page gets it.
 *
 * Electron main decides the source (`electron/athena/catalog-source.ts`) and preload hands its answer over
 * `window.athenaDesktop.catalog`. Today main always answers `bundled`, so `currentCatalog()` returns this build's
 * bundled `catalog.json` (a byte copy of the athena repo's, checked by `catalog-bundle.test.ts`). Without the Athena
 * bridge (a browser or a test host) it is the bundled catalog too. The signed remote catalog (F03 slice 19) adds
 * main's verified entries on top of the bundled built-ins here, and nowhere else.
 *
 * Nothing else under `src/` or `electron/` imports `catalog.json` (`catalog-source.test.ts` checks).
 */

import type { CatalogSourceName, CatalogSourceSnapshot } from '../../../electron/athena/catalog-source-types'

import type { Catalog } from './catalog'
import catalogJson from './catalog.json'

export type { CatalogSourceName, CatalogSourceSnapshot }

/** This build's catalog; built-in entries always come from here. */
export const BUNDLED_CATALOG = catalogJson as unknown as Catalog

export interface AthenaCatalogBridge {
  get?: () => Promise<unknown>
  snapshot?: unknown
}

export interface CurrentCatalog {
  catalog: Catalog
  /** Why the bundled catalog stands in for what main reported (null when main said `bundled`, or no bridge). */
  error: null | string
  source: CatalogSourceName
  version: string
}

/** The bridge preload exposes (`window.athenaDesktop.catalog`); undefined outside Electron. */
export function catalogBridge(): AthenaCatalogBridge | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  return (window as { athenaDesktop?: { catalog?: AthenaCatalogBridge } }).athenaDesktop?.catalog
}

const reportedSource = (snapshot: unknown): unknown =>
  snapshot && typeof snapshot === 'object' ? (snapshot as Partial<CatalogSourceSnapshot>).source : undefined

/** The catalog in force and where it came from. */
export function currentCatalog(bridge: AthenaCatalogBridge | undefined = catalogBridge()): CurrentCatalog {
  const reported = bridge ? reportedSource(bridge.snapshot) : 'bundled'

  return {
    catalog: BUNDLED_CATALOG,
    error: reported === 'bundled' ? null : `unknown catalog source ${JSON.stringify(reported ?? null)}; using bundled`,
    source: 'bundled',
    version: BUNDLED_CATALOG.catalog_version
  }
}
