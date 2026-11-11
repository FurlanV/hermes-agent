/**
 * The tool catalog in force, in the renderer (F03 slices 02 and 19): the one place the Capabilities page gets it.
 *
 * Electron main decides the source (`electron/athena/catalog-source.ts`) and preload hands its answer over
 * `window.athenaDesktop.catalog`. `bundled`: this build's bundled `catalog.json` alone (a byte copy of the athena
 * repo's, checked by `catalog-bundle.test.ts`). `remote` or `last_good`: main verified the signed remote catalog and
 * sends the gateway and skill packages it accepted; they are merged over the bundled entries here, except any id
 * that is a bundled built-in (built-ins always come from this build), which is dropped and reported. Without the
 * Athena bridge (a browser or a test host) it is the bundled catalog.
 *
 * Nothing else under `src/` or `electron/` imports `catalog.json` (`catalog-source.test.ts` checks).
 */

import type {
  CatalogSourceName,
  CatalogSourceSnapshot,
  RemoteCatalogEntries
} from '../../../electron/athena/catalog-source-types'

import type { Catalog, CatalogEntry } from './catalog'
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
  /** Why the bundled catalog stands in, or the last good copy (null when all is well, or no bridge). */
  error: null | string
  /** Remote entries refused by main or here, with the reason. */
  rejected: { id: string; reason: string }[]
  /** Ids whose entry came from the remote catalog. */
  remoteIds: ReadonlySet<string>
  /** The remote catalog's own version (null when bundled). */
  remoteVersion: null | string
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const SOURCES: ReadonlySet<string> = new Set(['bundled', 'last_good', 'remote'])

function bundled(error: null | string = null): CurrentCatalog {
  return {
    catalog: BUNDLED_CATALOG,
    error,
    rejected: [],
    remoteIds: new Set(),
    remoteVersion: null,
    source: 'bundled',
    version: BUNDLED_CATALOG.catalog_version
  }
}

const isBuiltIn = (entry: CatalogEntry | undefined) => Boolean(entry) && (entry!.category ?? 'built-in') === 'built-in'

/** The catalog in force for a main answer (`snapshot`, from preload or `get()`). */
export function catalogFromSnapshot(snapshot: unknown, bundledCatalog: Catalog = BUNDLED_CATALOG): CurrentCatalog {
  if (!isRecord(snapshot) || !SOURCES.has(String(snapshot.source))) {
    return bundled(`unknown catalog source ${JSON.stringify(isRecord(snapshot) ? (snapshot.source ?? null) : null)}; using bundled`)
  }

  const error = typeof snapshot.error === 'string' ? snapshot.error : null
  const remote = snapshot.catalog as null | RemoteCatalogEntries

  if (snapshot.source === 'bundled' || !isRecord(remote) || !isRecord(remote.entries)) {
    return bundled(error)
  }

  const rejected = Array.isArray(snapshot.rejected)
    ? snapshot.rejected.filter((r): r is { id: string; reason: string } => isRecord(r) && typeof r.id === 'string')
    : []

  const entries: Record<string, CatalogEntry> = { ...bundledCatalog.entries }
  const remoteIds = new Set<string>()

  for (const [id, raw] of Object.entries(remote.entries)) {
    if (isBuiltIn(bundledCatalog.entries[id])) {
      rejected.push({ id, reason: 'built_in' })
    } else {
      entries[id] = raw as unknown as CatalogEntry
      remoteIds.add(id)
    }
  }

  return {
    catalog: { ...bundledCatalog, entries },
    error,
    rejected,
    remoteIds,
    remoteVersion: typeof remote.catalog_version === 'string' ? remote.catalog_version : null,
    source: snapshot.source as CatalogSourceName,
    version: bundledCatalog.catalog_version
  }
}

/** The catalog in force and where it came from (main's answer at preload time). */
export function currentCatalog(bridge: AthenaCatalogBridge | undefined = catalogBridge()): CurrentCatalog {
  return bridge ? catalogFromSnapshot(bridge.snapshot) : bundled()
}

/** Ask main again (the page does on mount): a catalog synced while the app ran shows without a restart. */
export async function refreshCatalog(bridge: AthenaCatalogBridge | undefined = catalogBridge()): Promise<CurrentCatalog> {
  if (!bridge?.get) {
    return currentCatalog(bridge)
  }

  try {
    return catalogFromSnapshot(await bridge.get())
  } catch {
    return currentCatalog(bridge)
  }
}
