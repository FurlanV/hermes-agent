// F03 slices 02 and 19: the renderer's one "current catalog" function. It answers the bundled catalog, with or
// without the Athena bridge, merges the remote packages main verified (never over a built-in), the page shows its
// version and source, and nothing else imports catalog.json.
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { catalogCards } from './catalog'
import { CatalogDiagnostics } from './catalog-page'
import { BUNDLED_CATALOG, currentCatalog } from './catalog-source'

const DESKTOP = path.resolve(import.meta.dirname, '../../..')

afterEach(() => {
  cleanup()
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

describe('the current catalog in the renderer', () => {
  test('is the bundled catalog, with or without the bridge', () => {
    const expected = {
      catalog: BUNDLED_CATALOG,
      error: null,
      rejected: [],
      remoteIds: new Set(),
      remoteVersion: null,
      source: 'bundled',
      version: BUNDLED_CATALOG.catalog_version
    }
    expect(currentCatalog(undefined)).toEqual(expected)
    expect(currentCatalog({ snapshot: { catalog: null, error: null, source: 'bundled' } })).toEqual(expected)
    ;(window as { athenaDesktop?: unknown }).athenaDesktop = { catalog: { snapshot: { catalog: null, error: null, source: 'bundled' } } }
    expect(currentCatalog()).toEqual(expected)
  })

  test('an answer it does not know falls back to the bundled catalog and says so', () => {
    const current = currentCatalog({ snapshot: { source: 'peer-to-peer' } })
    expect([current.source, current.catalog]).toEqual(['bundled', BUNDLED_CATALOG])
    expect(current.error).toMatch(/unknown catalog source "peer-to-peer"/)
  })

  test('a remote answer adds its packages over the bundled ones, never over a built-in', () => {
    const remote = { ...BUNDLED_CATALOG.entries['stub-echo'], id: 'remote-echo', title: 'Remote echo' }
    const forgedFiles = { ...BUNDLED_CATALOG.entries.files, category: 'agent', title: 'Not the real Files' }
    const snapshot = {
      catalog: { catalog_version: '2026.11.4', entries: { files: forgedFiles, 'remote-echo': remote } },
      error: null,
      rejected: [{ id: 'sneaky-mcp', reason: 'kind_not_allowed' }],
      source: 'remote'
    }
    const current = currentCatalog({ snapshot })
    expect([current.source, current.remoteVersion]).toEqual(['remote', '2026.11.4'])
    expect(current.catalog.entries['remote-echo'].title).toBe('Remote echo')
    expect(current.catalog.entries.files).toBe(BUNDLED_CATALOG.entries.files)
    expect([...current.remoteIds]).toEqual(['remote-echo'])
    expect(current.rejected).toEqual([{ id: 'sneaky-mcp', reason: 'kind_not_allowed' }, { id: 'files', reason: 'built_in' }])
    render(<CatalogDiagnostics current={current} />)
    expect(screen.getByText(/source: remote/).textContent).toContain('+ remote 2026.11.4')
    expect(screen.getByText(/2 remote entries refused/)).toBeTruthy()
  })

  test('the cards come from it', () => {
    const config = { tools: { available: ['files', 'python'], default_on: ['files'], locked_on: [] } }
    expect(catalogCards(config).map(card => card.entry)).toEqual([BUNDLED_CATALOG.entries.files, BUNDLED_CATALOG.entries.python])
  })

  test('the page diagnostics show the catalog version and source', () => {
    render(<CatalogDiagnostics current={currentCatalog(undefined)} />)
    expect(screen.getByText(`Catalog ${BUNDLED_CATALOG.catalog_version} · source: bundled`)).toBeTruthy()
  })

  test('only catalog-source.ts imports catalog.json', () => {
    // git grep (tracked and untracked files) is fast enough for the whole of src/ and electron/.
    const out = execFileSync(
      'git',
      ['grep', '--untracked', '-l', '-E', String.raw`from[[:space:]]+['"][^'"]*/catalog\.json['"]`, '--', 'src', 'electron'],
      { cwd: DESKTOP, encoding: 'utf8' }
    )

    const importers = out
      .split('\n')
      .filter(Boolean)
      .filter(file => !/\.test\.tsx?$/.test(file))

    expect(importers).toEqual(['src/athena/catalog/catalog-source.ts'])
  })
})
