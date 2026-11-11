// Athena catalog-source types shared by main and the renderer (no runtime imports, so the renderer can use them).

/**
 * Where the tool catalog in force came from (F03 slices 02 and 19): `bundled` (the build's catalog alone: the
 * client config's `catalog.remote` is off, or no signed remote catalog verifies), `remote` (the verified signed
 * catalog the shipper stored is merged in), `last_good` (the same, while the shipper's last sync failed).
 */
export type CatalogSourceName = 'bundled' | 'last_good' | 'remote'

/** The packages main verified, to merge over the bundled catalog (the renderer holds the bundled copy). */
export interface RemoteCatalogEntries {
  catalog_version: string
  /** Accepted entries, by id, as `catalog.json` holds them. */
  entries: Record<string, Record<string, unknown>>
}

/** What main answers on `athena:catalog:snapshot` / `athena:catalog:get`. */
export interface CatalogSourceSnapshot {
  /** The verified remote packages (null with source `bundled`). Built-ins always come from the bundled copy. */
  catalog: null | RemoteCatalogEntries
  /** Why the remote catalog is not in use, or why the last good copy stands in (null when all is well). */
  error: null | string
  /** Remote entries main refused, with the reason (`kind_not_allowed`, `skill_hash_mismatch`, ...). */
  rejected?: { id: string; reason: string }[]
  source: CatalogSourceName
}
