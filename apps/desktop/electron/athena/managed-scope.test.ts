// F13 slice 18: a Model gateway model reaches the pickers only once hermes managed scope declares it.
//
// The Shipper stores a new signed config, then rewrites managed scope after its catalog and package syncs; hermes
// refuses a pick of a gateway model its provider does not declare (docs/hermes-findings.md 9.1). So under
// `managed.models: enforce` the Desktop lists the config's gateway models less those managed scope does not declare
// yet: a new model appears once declared, a removed one leaves with the config, bridge models keep their own rule,
// and without the managed file the config's list stands.
//
// The fixtures in `fixtures/managed-scope/` were written by athena's applier (`ManagedScope.desired`, F13 slices 16
// and 17) for the researcher's seed config with `gpt-6-sol` (a context length), `gpt-6-luna`, the chat-only
// `acme-chat-1` and the hidden `mock` (v42), then the same plus a new gateway model `acme-next-1` as the default and
// a new chat-only `acme-chat-2` (v43). From the athena checkout, with a scratch `$HERMES_HOME` whose `config.yaml`
// has the launcher's `providers.athena-gateway` (`base_url`, `api_mode: codex_responses`, `key_cmd: athena token`):
//   PYTHONPATH=. uv run python -c 'from athena_shipper.managed import ManagedScope; ...desired(config)'
// `client-config-v<N>.json` is each config, `managed-v<N>.yaml` the managed file the applier wrote for it.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { BUNDLED_DEFAULT_CONFIG } from './bundled-config-data'
import { AthenaClientConfig, type ClientConfigSnapshot, deepMerge } from './client-config'
import { applyMainPolicies, configureMainPolicies } from './main-policy'
import { MANAGED_DIR_ENV, managedDirFor, managedScopeModels, readManagedScopeModels } from './managed-scope'
import {
  ATHENA_GATEWAY_CHAT_PROVIDER,
  ATHENA_GATEWAY_PROVIDER,
  managedModels,
  managedPickerRows,
  modelUseDecision,
  snapshotModelsState
} from './model-policy'
import { PolicyDecisionLog } from './policy-decisions'
import { refuseRestRequest, setMainPolicySeams } from './policy-seams'

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'managed-scope')
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8')
const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

/** A config version as main would hold it: the bundled default under the signed document. */
const clientConfig = (version: 42 | 43) => deepMerge(bundled, JSON.parse(fixture(`client-config-v${version}.json`)))
const managedFile = (version: 42 | 43) => fixture(`managed-v${version}.yaml`)
const scopeOf = (version: 42 | 43) => managedScopeModels(parseYaml(managedFile(version)))

const snapshot = (version: 42 | 43, scope: 42 | 43 | null): Pick<ClientConfigSnapshot, 'config' | 'managedScope'> => ({
  config: clientConfig(version),
  ...(scope === null ? {} : { managedScope: scopeOf(scope)! })
})

const modelsFor = (version: 42 | 43, scope: 42 | 43 | null) => {
  const shot = snapshot(version, scope)

  return managedModels(shot.config, snapshotModelsState(shot))
}

const listed = (models: ReturnType<typeof managedModels>) =>
  managedPickerRows(models, []).map(row => [row.slug, row.models])

describe("reading the applier's managed file", () => {
  test('the declared ids of both gateway providers, and the default hermes starts on', () => {
    expect(scopeOf(42)).toEqual({
      declared: { 'athena-gateway': ['gpt-6-sol', 'gpt-6-luna'], 'athena-gateway-chat': ['acme-chat-1'] },
      default: 'gpt-6-sol'
    })
    expect(scopeOf(43)).toEqual({
      declared: {
        'athena-gateway': ['gpt-6-sol', 'gpt-6-luna', 'acme-next-1'],
        'athena-gateway-chat': ['acme-chat-1', 'acme-chat-2']
      },
      default: 'acme-next-1'
    })
  })

  test("an older applier's list shape, a config with no model, and no chat-only provider", () => {
    expect(
      managedScopeModels(
        parseYaml('model: {default: gpt-6-sol}\nproviders: {athena-gateway: {models: [gpt-6-sol, gpt-6-luna]}}')
      )
    ).toEqual({ declared: { 'athena-gateway': ['gpt-6-sol', 'gpt-6-luna'] }, default: 'gpt-6-sol' })
    // `no_model_pins`: the gateway provider with an empty list, no model name.
    expect(
      managedScopeModels(
        parseYaml('model: {provider: custom:athena-gateway}\nproviders: {athena-gateway: {models: []}}')
      )
    ).toEqual({ declared: { 'athena-gateway': [] }, default: null })
    expect(managedScopeModels({ nous: { guest: false } })).toEqual({ declared: {}, default: null })
  })

  test('a missing, unparseable or non-mapping file gives nothing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'athena-managed-'))

    try {
      expect(readManagedScopeModels(dir)).toBeNull()
      writeFileSync(path.join(dir, 'config.yaml'), 'providers: {athena-gateway: {models: [a, b}\n')
      expect(readManagedScopeModels(dir)).toBeNull()
      writeFileSync(path.join(dir, 'config.yaml'), '- just\n- a list\n')
      expect(readManagedScopeModels(dir)).toBeNull()
      writeFileSync(path.join(dir, 'config.yaml'), managedFile(43))
      expect(readManagedScopeModels(dir)).toEqual(scopeOf(43))
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("hermes's folder: HERMES_MANAGED_DIR when the launcher sets it, else the Profile's", () => {
    expect(managedDirFor('/h/athena', {})).toBe(path.join('/h/athena', 'managed'))
    expect(managedDirFor('/h/athena', { [MANAGED_DIR_ENV]: ' /elsewhere ' })).toBe('/elsewhere')
    expect(managedDirFor('/h/athena', { [MANAGED_DIR_ENV]: '' })).toBe(path.join('/h/athena', 'managed'))
  })
})

describe('the role list under enforce, against managed scope', () => {
  test('a new model is not listed while managed scope does not declare it; once declared, it is', () => {
    // The Desktop saw v43 before the Shipper rewrote managed scope.
    const early = modelsFor(43, 42)
    expect(listed(early)).toEqual([
      [ATHENA_GATEWAY_PROVIDER, ['gpt-6-sol', 'gpt-6-luna']],
      [ATHENA_GATEWAY_CHAT_PROVIDER, ['acme-chat-1']]
    ])
    // The config's new default is not declared yet: the default stays the one hermes has, not the first listed.
    expect(early.default).toBe('gpt-6-sol')
    // A pick of it (a typed `/model`) is refused like any model off the list: hermes would refuse it too.
    expect(
      modelUseDecision(early, { model: 'acme-next-1', provider: ATHENA_GATEWAY_PROVIDER }, 'slash', '/model')
    ).toEqual({
      allowed: false,
      record: { action: 'refused', id: 'acme-next-1', mode: 'enforce', surface: 'slash', target: '/model' }
    })
    // The hidden alias is never declared and never listed, and stays callable.
    expect(modelUseDecision(early, { model: 'mock' }, 'rpc', 'config.set').allowed).toBe(true)

    const declared = modelsFor(43, 43)
    expect(listed(declared)).toEqual([
      [ATHENA_GATEWAY_PROVIDER, ['gpt-6-sol', 'gpt-6-luna', 'acme-next-1']],
      [ATHENA_GATEWAY_CHAT_PROVIDER, ['acme-chat-1', 'acme-chat-2']]
    ])
    expect(declared.default).toBe('acme-next-1')
    expect(
      modelUseDecision(declared, { model: 'acme-next-1', provider: ATHENA_GATEWAY_PROVIDER }, 'picker', 'x')
    ).toEqual({ allowed: true, record: null })
    expect(
      modelUseDecision(declared, { model: 'acme-chat-2', provider: ATHENA_GATEWAY_CHAT_PROVIDER }, 'picker', 'x')
    ).toEqual({ allowed: true, record: null })
  })

  test('a model declared on the other gateway provider only is not declared on its own', () => {
    const scope = {
      declared: { 'athena-gateway': ['gpt-6-sol', 'gpt-6-luna', 'acme-chat-2'], 'athena-gateway-chat': [] },
      default: null
    }

    const models = managedModels(clientConfig(43), { managedScope: scope })

    expect(models.visible.map(entry => entry.id)).toEqual(['gpt-6-sol', 'gpt-6-luna'])
  })

  test('a removed model leaves at once, without waiting for managed scope', () => {
    // The admin took acme-next-1 and acme-chat-2 off (v42 again); managed scope still declares them.
    const models = modelsFor(42, 43)

    expect(listed(models)).toEqual([
      [ATHENA_GATEWAY_PROVIDER, ['gpt-6-sol', 'gpt-6-luna']],
      [ATHENA_GATEWAY_CHAT_PROVIDER, ['acme-chat-1']]
    ])
    expect(models.default).toBe('gpt-6-sol')
    expect(modelUseDecision(models, { model: 'acme-next-1' }, 'rpc', 'config.set').allowed).toBe(false)
  })

  test('without the managed file the config list stands', () => {
    const models = modelsFor(43, null)

    expect(listed(models)).toEqual([
      [ATHENA_GATEWAY_PROVIDER, ['gpt-6-sol', 'gpt-6-luna', 'acme-next-1']],
      [ATHENA_GATEWAY_CHAT_PROVIDER, ['acme-chat-1', 'acme-chat-2']]
    ])
    expect(models.default).toBe('acme-next-1')
    expect(managedModels(clientConfig(43), { managedScope: null }).visible).toEqual(models.visible)
  })

  test('a managed default that left the list is not kept: the first listed model is', () => {
    // v43's default is not declared yet, and managed scope's default is a model the config no longer offers.
    const scope = { ...scopeOf(42)!, default: 'gpt-5-retired' }

    expect(managedModels(clientConfig(43), { managedScope: scope }).default).toBe('gpt-6-sol')
  })

  test('under report and off the list is not narrowed by managed scope', () => {
    for (const mode of ['report', 'off'] as const) {
      const config = deepMerge(clientConfig(43), { managed: { models: mode } })
      const models = managedModels(config, { managedScope: scopeOf(42) })

      expect(models.visible.map(entry => entry.id)).toContain('acme-next-1')
      expect(modelUseDecision(models, { model: 'acme-next-1' }, 'rpc', 'config.set')).toEqual({
        allowed: true,
        record: null
      })
    }
  })

  test('bridge models keep their own rule: managed scope does not filter them', () => {
    const NAME = 'DevQuasar/Qwen.Qwen3.8-27B-GGUF'

    const config = deepMerge(clientConfig(42), {
      features: { F05: 'on' },
      local_models: {
        enabled: true,
        login_host: 'login5.ccm.sickkids.ca',
        models: { qwen: { name: NAME } },
        target_host: 'cn3825.ccm.sickkids.ca',
        target_port: 9931
      }
    })

    const models = (config.models as { allowed: unknown[] }).allowed
    models.push({ id: 'qwen', label: 'Qwen (local)', provider: 'bridge' })

    // Managed scope's gateway entries never name a bridge model; only the bridge decides.
    expect(
      managedModels(config, { bridgeUp: true, managedScope: scopeOf(42) }).visible.map(entry => entry.id)
    ).toContain(NAME)
    expect(
      managedModels(config, { bridgeUp: false, managedScope: scopeOf(42) }).visible.map(entry => entry.id)
    ).not.toContain(NAME)
  })
})

// The Settings default goes through main's REST seam (`POST /api/model/set`), which decides on the same list.
describe("main's REST seam and a model managed scope has just declared", () => {
  const setDefault = (model: string, provider = ATHENA_GATEWAY_PROVIDER) => ({
    body: { model, provider, scope: 'main' },
    method: 'POST',
    path: '/api/model/set'
  })

  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'athena-managed-seam-'))
    configureMainPolicies({ decisions: new PolicyDecisionLog({ file: path.join(dir, 'decisions.jsonl') }) })
  })

  afterEach(() => {
    setMainPolicySeams(null)
    configureMainPolicies({})
    rmSync(dir, { force: true, recursive: true })
  })

  const recorded = () => {
    try {
      return readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
    } catch {
      return []
    }
  }

  test('refused while undeclared, accepted from the first snapshot that declares it', () => {
    applyMainPolicies(snapshot(43, 42))
    expect(refuseRestRequest(setDefault('acme-next-1'))).not.toBeNull()
    expect(recorded().map(row => [row.kind, row.action, row.id])).toEqual([['model', 'refused', 'acme-next-1']])

    applyMainPolicies(snapshot(43, 43))
    expect(refuseRestRequest(setDefault('acme-next-1'))).toBeNull()
    expect(refuseRestRequest(setDefault('acme-chat-2', ATHENA_GATEWAY_CHAT_PROVIDER))).toBeNull()
    expect(recorded()).toHaveLength(1)
  })

  test('without the managed file, the config list decides', () => {
    applyMainPolicies(snapshot(43, null))
    expect(refuseRestRequest(setDefault('acme-next-1'))).toBeNull()
    expect(recorded()).toEqual([])
  })
})

// Main reads the managed file with the client config's other inputs: the poll that follows a rewrite pushes it.
describe('the client-config snapshot follows managed scope', () => {
  let athenaDir: string
  let managedDir: string

  beforeEach(() => {
    athenaDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'athena-managed-cc-')), 'athena')
    managedDir = path.join(athenaDir, 'managed')
    mkdirSync(managedDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(path.dirname(athenaDir), { force: true, recursive: true })
  })

  const writeManaged = (text: string) => {
    // As the applier writes it: a temp file renamed over the old one.
    const tmp = path.join(managedDir, '.config.yaml.tmp')
    writeFileSync(tmp, text)
    renameSync(tmp, path.join(managedDir, 'config.yaml'))
  }

  test('absent without the file; the next poll after each rewrite carries what it declares', () => {
    const seen: ClientConfigSnapshot[] = []
    const source = new AthenaClientConfig({ athenaDir, managedDir, onChange: next => seen.push(next) })
    source.start(60_000)

    try {
      expect('managedScope' in source.snapshot()).toBe(false)

      writeManaged(managedFile(42))
      source.tick()
      expect(seen.map(next => next.managedScope?.declared['athena-gateway'])).toEqual([['gpt-6-sol', 'gpt-6-luna']])
      source.tick()
      expect(seen).toHaveLength(1)

      writeManaged(managedFile(43))
      source.tick()
      expect(seen.at(-1)?.managedScope).toEqual(scopeOf(43))

      rmSync(path.join(managedDir, 'config.yaml'))
      source.tick()
      expect(seen).toHaveLength(3)
      expect(seen.at(-1)?.managedScope).toBeUndefined()
    } finally {
      source.stop()
    }
  })

  test('the default folder is the Profile `athena/managed` folder', () => {
    writeManaged(managedFile(42))

    expect(new AthenaClientConfig({ athenaDir }).snapshot().managedScope).toEqual(scopeOf(42))
  })
})
