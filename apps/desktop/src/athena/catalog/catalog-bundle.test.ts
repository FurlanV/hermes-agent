// @vitest-environment node
// The bundled catalog is a byte copy of the athena repo's `client/catalog/catalog.json` (built by
// `athena-build-catalog`). Compared when an athena checkout is present (ATHENA_REPO, else the usual path).
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { BUNDLED_CATALOG } from './catalog'

const bundled = path.join(import.meta.dirname, 'catalog.json')
const athenaRepo = process.env.ATHENA_REPO ?? path.join(homedir(), 'Documents/Projects/sickkids/athena')
const upstream = path.join(athenaRepo, 'client', 'catalog', 'catalog.json')

describe('the bundled tool catalog', () => {
  test('has the entries the page needs, each with its sha256', () => {
    expect(BUNDLED_CATALOG.catalog_version).toMatch(/^\d{4}\.\d{1,2}\.\d+$/)

    for (const [id, entry] of Object.entries(BUNDLED_CATALOG.entries)) {
      expect(entry.id).toBe(id)
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.title && entry.summary && entry.version && entry.group).toBeTruthy()
    }

    // hermes's clarify and project toolsets are locked-on entries since slice 28.
    expect(BUNDLED_CATALOG.entries.clarify?.provides.toolsets).toEqual(['clarify'])
    expect(BUNDLED_CATALOG.entries['desktop-projects']?.provides.toolsets).toEqual(['project'])
  })

  test.skipIf(!existsSync(upstream))('matches the athena repo byte for byte', () => {
    expect(readFileSync(bundled, 'utf8')).toBe(readFileSync(upstream, 'utf8'))
  })
})
