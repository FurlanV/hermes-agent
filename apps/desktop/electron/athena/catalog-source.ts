// Athena: which tool catalog is in force, decided in main (F03 slice 02).
//
// `currentCatalogSource()` is main's one "current catalog" function. Today it always answers the build's bundled
// catalog (`source: 'bundled'`); the renderer resolves that to its bundled `catalog.json` through its own one
// function (`src/athena/catalog/catalog-source.ts`). The signed remote catalog (F03 slice 19) fills this in: main
// verifies the signed document (as it does the client config), keeps a last-good copy and hands the renderer the
// verified gateway-backed entries. Built-ins always stay the bundled copy's.
//
// Channels (main ⇄ renderer, Athena-owned), installed with the client config (client-config-ipc.ts):
// - `athena:catalog:snapshot` (sendSync): read by preload before the first paint;
// - `athena:catalog:get` (invoke): the same, on demand.

import type { IpcMain } from 'electron'

import type { CatalogSourceName, CatalogSourceSnapshot } from './catalog-source-types'

export type { CatalogSourceName, CatalogSourceSnapshot }

export const CATALOG_CHANNELS = Object.freeze({
  get: 'athena:catalog:get',
  snapshot: 'athena:catalog:snapshot'
} as const)

/** The catalog in force: the build's bundled catalog. */
export function currentCatalogSource(): CatalogSourceSnapshot {
  return { catalog: null, error: null, source: 'bundled' }
}

export function installAthenaCatalogSource(ipcMain: Pick<IpcMain, 'handle' | 'on'>, log: (line: string) => void): void {
  ipcMain.on(CATALOG_CHANNELS.snapshot, event => {
    event.returnValue = currentCatalogSource()
  })
  ipcMain.handle(CATALOG_CHANNELS.get, () => currentCatalogSource())
  log(`[athena] tool catalog: ${currentCatalogSource().source}`)
}
