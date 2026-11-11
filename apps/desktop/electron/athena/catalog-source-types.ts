// Athena catalog-source types shared by main and the renderer (no runtime imports, so the renderer can use them).

/** Where the tool catalog in force came from. The signed remote catalog (F03 slice 19) adds `remote`/`last_good`. */
export type CatalogSourceName = 'bundled'

/** What main answers on `athena:catalog:snapshot` / `athena:catalog:get`. */
export interface CatalogSourceSnapshot {
  /**
   * Entries main verified on top of the build's bundled catalog: always null today. Built-in entries always come from
   * the bundled copy, which the renderer holds (`src/athena/catalog/catalog.json`).
   */
  catalog: null
  /** Why main fell back to the bundled catalog (null: it is the only source today). */
  error: null | string
  source: CatalogSourceName
}
