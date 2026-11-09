// Opt-in end-to-end check against the running athena compose stack (F02 slices 14 and 15):
//   admin API PATCH → `athena config sync` (the Shipper's step) → Electron main's verifier → feature filter.
// Run with ATHENA_E2E=1 (and ATHENA_REPO if the athena checkout is elsewhere):
//   ATHENA_E2E=1 pnpm exec vitest run --project electron electron/athena/client-config.e2e.test.ts
// It turns S82 on for the researcher role, checks the researcher's Desktop sees it within the poll interval plus
// 1 s while the clinician's does not, and resets S82 afterwards.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, test, vi } from 'vitest'

import { AthenaClientConfig, type ClientConfigSnapshot } from './client-config'
import { featureEntryFilter } from './feature-registry'

const E2E = process.env.ATHENA_E2E === '1'
const ATHENA = process.env.ATHENA_REPO ?? path.join(homedir(), 'Documents/Projects/sickkids/athena')
const ISSUER = process.env.ATHENA_DEV_ISSUER ?? 'http://localhost:9000'
const ADMIN = process.env.ATHENA_ADMIN_URL ?? 'http://localhost:8002'
const INGEST = process.env.ATHENA_INGEST_URL ?? 'http://localhost:8001'

async function token(oid: string, roles: string[] = []): Promise<string> {
  const resp = await fetch(`${ISSUER}/token`, {
    body: JSON.stringify({ oid, roles }),
    headers: { 'content-type': 'application/json' },
    method: 'POST'
  })

  return ((await resp.json()) as { access_token: string }).access_token
}

async function patchResearcher(features: Record<string, null | string>) {
  const resp = await fetch(`${ADMIN}/client-configs/researcher`, {
    body: JSON.stringify({ features }),
    headers: { authorization: `Bearer ${await token('demo-admin', ['Athena.Admin'])}`, 'content-type': 'application/json' },
    method: 'PATCH'
  })

  expect(resp.status, await resp.clone().text()).toBe(200)

  return (await resp.json()) as { config_version: number }
}

function sync(home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ATHENA_INGEST_URL: INGEST, HERMES_HOME: home }
  delete env.VIRTUAL_ENV

  try {
    execFileSync('uv', ['run', '--project', ATHENA, 'athena', 'config', 'sync'], { cwd: ATHENA, env, stdio: 'pipe' })
  } catch (error) {
    // Exit 1: the last good copy or the bundled default stands in; the test then sees it in the snapshot.
    if ((error as { status?: number }).status !== 1) {
      throw error
    }
  }
}

const root = E2E ? mkdtempSync(path.join(tmpdir(), 'athena-e2e-')) : ''

afterAll(async () => {
  if (E2E) {
    await patchResearcher({ S82: null })
    rmSync(root, { force: true, recursive: true })
  }
})

describe.skipIf(!E2E)('admin API → athena config sync → Electron main (compose)', () => {
  test('S82 on for the researcher reaches the researcher within the poll interval + 1 s, not the clinician', async () => {
    const profiles: Record<string, { cc: AthenaClientConfig; home: string; seen: ClientConfigSnapshot[] }> = {}

    for (const role of ['researcher', 'clinician']) {
      const home = path.join(root, role)
      mkdirSync(path.join(home, 'athena'), { recursive: true })
      writeFileSync(
        path.join(home, 'athena', 'token.json'),
        JSON.stringify({ access_token: await token(`demo-${role}`), expires_at: Date.now() / 1000 + 3600, idp: 'dev' })
      )
      sync(home)
      const seen: ClientConfigSnapshot[] = []
      const cc = new AthenaClientConfig({ athenaDir: path.join(home, 'athena'), onChange: s => seen.push(s) })
      expect(cc.snapshot()).toMatchObject({ source: 'server', role, error: null })
      cc.start(1000)
      profiles[role] = { cc, home, seen }
    }

    try {
      const { config_version: version } = await patchResearcher({ S82: 'on' })

      for (const { home } of Object.values(profiles)) {
        sync(home)
      }

      const synced = Date.now()
      const researcher = profiles.researcher

      await vi.waitFor(() => expect(researcher.cc.snapshot().configVersion).toBe(version), { interval: 50, timeout: 1500 })
      expect(Date.now() - synced).toBeLessThanOrEqual(1500)
      expect(researcher.seen.at(-1)).toMatchObject({ configVersion: version, role: 'researcher', source: 'server' })
      expect(featureEntryFilter(researcher.cc.snapshot().config)('settings:providers/local')).toBe(true)

      // The clinician's config moves to the same global version but keeps S82 off.
      const clinician = profiles.clinician
      await vi.waitFor(() => expect(clinician.cc.snapshot().configVersion).toBe(version), { interval: 50, timeout: 1500 })
      expect(clinician.cc.snapshot().role).toBe('clinician')
      expect(featureEntryFilter(clinician.cc.snapshot().config)('settings:providers/local')).toBe(false)
    } finally {
      for (const { cc } of Object.values(profiles)) {
        cc.stop()
      }
    }
  }, 60_000)
})
