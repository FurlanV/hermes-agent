// Athena: which tool catalog is in force, decided in main (F03 slices 02 and 19).
//
// `AthenaCatalogSource.current()` is main's one "current catalog" function. It answers the build's bundled catalog
// (`source: 'bundled'`, `catalog: null`; the renderer holds the bundled copy) unless the verified client config's
// `catalog.remote` is on and `$HERMES_HOME/athena/catalog.jws` (the signed remote catalog the shipper stored)
// verifies here, against the app's own trusted keys (remote-catalog.ts). Then it answers the accepted gateway and
// skill packages (`remote`, or `last_good` while the shipper's last sync failed), and the refused ones with reasons.
// Built-ins always stay the bundled copy's: the renderer merges, and drops any bundled built-in id.
//
// Replay floor: the highest `catalog_version` main accepted is kept in `$HERMES_HOME/athena/desktop-catalog.json`,
// next to the shipper's `catalog.state.json` `high_water`; a copy below either is refused (`replayed_version`) and the
// bundled catalog stands in. Each answer re-reads the two small files (the page asks on mount).
//
// Channels (main ⇄ renderer, Athena-owned), installed with the client config (client-config-ipc.ts):
// - `athena:catalog:snapshot` (sendSync): read by preload before the first paint;
// - `athena:catalog:get` (invoke): the same, on demand (the Capabilities page asks each time it opens).

import type { KeyObject } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { IpcMain } from 'electron'

import type { CatalogSourceName, CatalogSourceSnapshot } from './catalog-source-types'
import { bundledTrustedKeys } from './client-config'
import { acceptRemote, CatalogRefused, compareVersions, verifyRemoteCatalog, versionTuple } from './remote-catalog'

export type { CatalogSourceName, CatalogSourceSnapshot }

export const CATALOG_CHANNELS = Object.freeze({
  get: 'athena:catalog:get',
  snapshot: 'athena:catalog:snapshot'
} as const)

export const CATALOG_FILE = 'catalog.jws'
export const CATALOG_STATE_FILE = 'catalog.state.json'
export const DESKTOP_CATALOG_FILE = 'desktop-catalog.json'

const BUNDLED: CatalogSourceSnapshot = Object.freeze({ catalog: null, error: null, source: 'bundled' })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** The client config's `catalog.remote` switch (off when missing). */
export function remoteCatalogOn(config: unknown): boolean {
  return isRecord(config) && isRecord(config.catalog) && config.catalog.remote === true
}

export interface CatalogSourceOptions {
  athenaDir: string
  /** The verified client config in force (its `catalog.remote` decides). */
  config: () => unknown
  log?: (line: string) => void
  now?: () => number
  trusted?: ReadonlyMap<string, KeyObject>
}

export class AthenaCatalogSource {
  private readonly options: CatalogSourceOptions
  private readonly trusted: ReadonlyMap<string, KeyObject>

  constructor(options: CatalogSourceOptions) {
    this.options = options
    this.trusted = options.trusted ?? bundledTrustedKeys()
  }

  private file(name: string): string {
    return path.join(this.options.athenaDir, name)
  }

  private floor(): null | string {
    const candidates = [readJson(this.file(CATALOG_STATE_FILE)), readJson(this.file(DESKTOP_CATALOG_FILE))]
      .map(data => (isRecord(data) ? (data.high_water ?? data.catalog_version_seen) : null))
      .filter((v): v is string => versionTuple(v) !== null)

    return candidates.sort((a, b) => compareVersions(versionTuple(b)!, versionTuple(a)!))[0] ?? null
  }

  private remember(version: string): void {
    const seen = readJson(this.file(DESKTOP_CATALOG_FILE))
    const held = isRecord(seen) ? versionTuple(seen.catalog_version_seen) : null

    if (held && compareVersions(versionTuple(version)!, held) <= 0) {
      return
    }

    try {
      mkdirSync(this.options.athenaDir, { recursive: true })
      const tmp = `${this.file(DESKTOP_CATALOG_FILE)}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ catalog_version_seen: version }, null, 2)}\n`)
      renameSync(tmp, this.file(DESKTOP_CATALOG_FILE))
    } catch (error) {
      this.options.log?.(`[athena] could not write ${DESKTOP_CATALOG_FILE}: ${String(error)}`)
    }
  }

  current(): CatalogSourceSnapshot {
    if (!remoteCatalogOn(this.options.config())) {
      return BUNDLED
    }

    let token: string

    try {
      token = readFileSync(this.file(CATALOG_FILE), 'utf8')
    } catch {
      return { ...BUNDLED, error: 'no_catalog' }
    }

    try {
      const doc = verifyRemoteCatalog(token, this.trusted, this.floor(), (this.options.now ?? Date.now)())
      this.remember(doc.catalog_version)
      const { accepted, rejected } = acceptRemote(doc)
      const state = readJson(this.file(CATALOG_STATE_FILE))
      const syncError = isRecord(state) && typeof state.error === 'string' ? state.error : null

      return {
        catalog: { catalog_version: doc.catalog_version, entries: accepted },
        error: syncError,
        rejected,
        source: syncError ? 'last_good' : 'remote'
      }
    } catch (error) {
      if (error instanceof CatalogRefused) {
        return { ...BUNDLED, error: error.reason }
      }

      throw error
    }
  }
}

/** Main's catalog before the client config is installed (and in tests): the bundled catalog. */
export function currentCatalogSource(): CatalogSourceSnapshot {
  return BUNDLED
}

export function installAthenaCatalogSource(
  ipcMain: Pick<IpcMain, 'handle' | 'on'>,
  log: (line: string) => void,
  source?: AthenaCatalogSource
): void {
  const current = () => {
    try {
      return source ? source.current() : currentCatalogSource()
    } catch (error) {
      log(`[athena] tool catalog: ${String(error)}; using bundled`)

      return { ...BUNDLED, error: 'internal_error' }
    }
  }

  ipcMain.on(CATALOG_CHANNELS.snapshot, event => {
    event.returnValue = current()
  })
  ipcMain.handle(CATALOG_CHANNELS.get, () => current())
  const first = current()
  log(`[athena] tool catalog: ${first.source}${first.catalog ? ` ${first.catalog.catalog_version}` : ''}${first.error ? ` (${first.error})` : ''}`)
}
