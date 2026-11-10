// Opt-in end-to-end check of the role's model list against the running athena compose stack (F02 slice 20):
//   admin API PATCH → `athena config sync` (the Shipper's step) → Electron main's verifier → the picker rows.
// Run with ATHENA_E2E=1 (and ATHENA_REPO if the athena checkout is elsewhere):
//   ATHENA_E2E=1 pnpm exec vitest run --project electron electron/athena/managed-models.e2e.test.ts
// 1. Adding gpt-6-sol to the clinician role shows in the clinician's picker rows within the poll interval + 1 s,
//    built from the config alone (an empty catalog: no "Refresh Models").
// 2. With `managed.models: report`, a pick outside the list is allowed and recorded, and the model gateway still
//    refuses the call (404 model_not_found).
// The clinician overlay is restored afterwards.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, test, vi } from 'vitest'

import { AthenaClientConfig } from './client-config'
import { managedModels, managedPickerRows, modelUseDecision } from './model-policy'

const E2E = process.env.ATHENA_E2E === '1'
const ATHENA = process.env.ATHENA_REPO ?? path.join(homedir(), 'Documents/Projects/sickkids/athena')
const ISSUER = process.env.ATHENA_DEV_ISSUER ?? 'http://localhost:9000'
const ADMIN = process.env.ATHENA_ADMIN_URL ?? 'http://localhost:8002'
const INGEST = process.env.ATHENA_INGEST_URL ?? 'http://localhost:8001'
const GATEWAY = process.env.ATHENA_GATEWAY_URL ?? 'http://localhost:8003'

const SOL = { id: 'gpt-6-sol', label: 'GPT-6 Sol', note: 'Most capable', reasoning: { default: 'medium', levels: ['none', 'low', 'medium', 'high'] } }
const LUNA = { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: 'Faster', reasoning: { default: 'low', levels: ['none', 'low', 'medium'] } }
const MOCK = { hidden: true, id: 'mock', label: 'Mock (dev)', note: 'The compose mock LLM, for tests' }

async function token(oid: string, roles: string[] = []): Promise<string> {
  const resp = await fetch(`${ISSUER}/token`, {
    body: JSON.stringify({ oid, roles }),
    headers: { 'content-type': 'application/json' },
    method: 'POST'
  })

  return ((await resp.json()) as { access_token: string }).access_token
}

async function patchClinician(patch: Record<string, unknown>) {
  const resp = await fetch(`${ADMIN}/client-configs/clinician`, {
    body: JSON.stringify(patch),
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
    if ((error as { status?: number }).status !== 1) {
      throw error
    }
  }
}

const root = E2E ? mkdtempSync(path.join(tmpdir(), 'athena-models-e2e-')) : ''

afterAll(async () => {
  if (E2E) {
    await patchClinician({ managed: null, models: null })
    rmSync(root, { force: true, recursive: true })
  }
})

describe.skipIf(!E2E)('admin API → athena config sync → picker rows (compose)', () => {
  test('an added model shows within one poll; report mode records an outside pick and the gateway refuses it', async () => {
    const home = path.join(root, 'clinician')
    mkdirSync(path.join(home, 'athena'), { recursive: true })
    const clinicianToken = await token('demo-clinician')
    writeFileSync(
      path.join(home, 'athena', 'token.json'),
      JSON.stringify({ access_token: clinicianToken, expires_at: Date.now() / 1000 + 3600, idp: 'dev' })
    )
    sync(home)
    const cc = new AthenaClientConfig({ athenaDir: path.join(home, 'athena') })
    const rows = () => managedPickerRows(managedModels(cc.snapshot().config), []).flatMap(row => row.models ?? [])
    expect(cc.snapshot()).toMatchObject({ error: null, role: 'clinician', source: 'server' })
    expect(rows()).toEqual(['gpt-6-luna'])
    cc.start(1000)

    try {
      const added = await patchClinician({ models: { allowed: [LUNA, SOL, MOCK], default: 'gpt-6-luna' } })
      sync(home)
      const synced = Date.now()
      await vi.waitFor(() => expect(cc.snapshot().configVersion).toBe(added.config_version), { interval: 50, timeout: 1500 })
      expect(Date.now() - synced).toBeLessThanOrEqual(1500)
      expect(rows()).toEqual(['gpt-6-luna', 'gpt-6-sol'])
      expect(managedModels(cc.snapshot().config).visible.map(entry => entry.label)).toEqual(['GPT-6 Luna', 'GPT-6 Sol'])

      const report = await patchClinician({ managed: { models: 'report' }, models: null })
      sync(home)
      await vi.waitFor(() => expect(cc.snapshot().configVersion).toBe(report.config_version), { interval: 50, timeout: 1500 })
      const models = managedModels(cc.snapshot().config)
      expect(models.mode).toBe('report')
      expect(modelUseDecision(models, { model: 'gpt-6-sol', provider: 'custom:athena-gateway' }, 'rpc', 'config.set')).toEqual({
        allowed: true,
        record: { action: 'allowed_in_report', id: 'gpt-6-sol', mode: 'report', surface: 'rpc', target: 'config.set' }
      })

      // The gateway enforces the role list whatever the client's master switch says.
      const call = await fetch(`${GATEWAY}/v1/chat/completions`, {
        body: JSON.stringify({ messages: [{ content: 'hi', role: 'user' }], model: 'gpt-6-sol' }),
        headers: { authorization: `Bearer ${clinicianToken}`, 'content-type': 'application/json' },
        method: 'POST'
      })

      expect(call.status).toBe(404)
      expect(JSON.stringify(await call.json())).toContain('model_not_found')
    } finally {
      cc.stop()
    }
  }, 60_000)
})
