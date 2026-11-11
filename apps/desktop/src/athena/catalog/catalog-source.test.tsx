// F03 slice 02: the renderer's one "current catalog" function. It answers the bundled catalog, with or without the
// Athena bridge, the page shows its version and source, and nothing else imports catalog.json.
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
    const expected = { catalog: BUNDLED_CATALOG, error: null, source: 'bundled', version: BUNDLED_CATALOG.catalog_version }
    expect(currentCatalog(undefined)).toEqual(expected)
    expect(currentCatalog({ snapshot: { catalog: null, error: null, source: 'bundled' } })).toEqual(expected)
    ;(window as { athenaDesktop?: unknown }).athenaDesktop = { catalog: { snapshot: { catalog: null, error: null, source: 'bundled' } } }
    expect(currentCatalog()).toEqual(expected)
  })

  test('an answer it does not know falls back to the bundled catalog and says so', () => {
    const current = currentCatalog({ snapshot: { source: 'remote' } })
    expect([current.source, current.catalog]).toEqual(['bundled', BUNDLED_CATALOG])
    expect(current.error).toMatch(/unknown catalog source "remote"/)
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
