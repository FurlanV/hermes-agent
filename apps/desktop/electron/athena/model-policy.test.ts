// F02 slices 20 and 23: the role's allowed models, read from the client config, shared by main and the renderer.
// The list (hidden entries never listed, config order), the master switch (`managed.models`), the requests that pick
// a model (JSON-RPC and the Settings default over REST), and main's REST seam recording model decisions.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { BUNDLED_DEFAULT_CONFIG } from './bundled-config-data'
import { applyMainPolicies, configureMainPolicies } from './main-policy'
import {
  levelAfterSwitch,
  managedModels,
  managedPickerRows,
  modelReasoning,
  modelUseDecision,
  type PickerRow,
  reasoningUnavailable,
  restModelChoice,
  rpcModelChoice,
  slashModelChoice,
  slashModelReasoning
} from './model-policy'
import { PolicyDecisionLog } from './policy-decisions'
import { refuseRestRequest, setMainPolicySeams } from './policy-seams'

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

const SOL = { id: 'gpt-6-sol', label: 'GPT-6 Sol', note: 'Most capable', reasoning: { default: 'medium', levels: ['none', 'low', 'medium', 'high'] } }
const LUNA = { id: 'gpt-6-luna', label: 'GPT-6 Luna', reasoning: { default: 'low', levels: ['none', 'low', 'medium'] } }
const MOCK = { hidden: true, id: 'mock', label: 'Mock (dev)' }

const config = (mode = 'enforce', allowed: unknown[] = [SOL, LUNA, MOCK], extra: Record<string, unknown> = {}) => ({
  ...bundled,
  managed: { ...(bundled.managed as object), models: mode },
  models: { allowed, default: 'gpt-6-sol', max_turns_limit: 90, ...extra }
})

const CATALOG: (PickerRow & Record<string, unknown>)[] = [
  { capabilities: { 'gpt-6-sol': { fast: false, reasoning: true } }, models: ['gpt-6-luna', 'gpt-4.1'], name: 'Gateway', slug: 'custom:athena-gateway' },
  { models: ['claude-opus-4.8'], name: 'Anthropic', slug: 'anthropic' },
  { models: ['llama-3.3-70b'], name: 'vLLM', slug: 'custom:athena-vllm' }
]

describe('the managed list', () => {
  test('entries in config order; hidden ones allowed but not visible; default, mode, reasoning control', () => {
    const models = managedModels(config())

    expect(models.entries.map(entry => entry.id)).toEqual(['gpt-6-sol', 'gpt-6-luna', 'mock'])
    expect(models.visible.map(entry => entry.label)).toEqual(['GPT-6 Sol', 'GPT-6 Luna'])
    expect(models).toMatchObject({ default: 'gpt-6-sol', mode: 'enforce', reasoningControl: true })
    expect(managedModels(config('enforce', [SOL], { reasoning_control: 'off' })).reasoningControl).toBe(false)
    // A missing or unknown master switch reads as enforce; a stray default falls back to the first visible model.
    expect(managedModels({ models: { allowed: [MOCK, LUNA], default: 'gone' } })).toMatchObject({ default: 'gpt-6-luna', mode: 'enforce' })
    expect(managedModels(bundled).visible.map(entry => entry.id)).toEqual(['gpt-6-luna'])
  })

  test('picker rows: the gateway row carries exactly the visible ids in config order; other providers drop', () => {
    const rows = managedPickerRows(managedModels(config()), CATALOG)

    expect(rows.map(row => [row.slug, row.models])).toEqual([['custom:athena-gateway', ['gpt-6-sol', 'gpt-6-luna']]])
    // The catalog's metadata for the row is kept (capabilities), and every model is a default-visible one.
    expect(rows[0]).toMatchObject({ capabilities: CATALOG[0].capabilities, featured_models: ['gpt-6-sol', 'gpt-6-luna'] })
    // No catalog yet: the gateway row is made up from the config.
    expect(managedPickerRows(managedModels(config()), [])).toEqual([
      expect.objectContaining({ models: ['gpt-6-sol', 'gpt-6-luna'], slug: 'custom:athena-gateway' })
    ])
    // A row lists only the models its own provider serves (F05 slice 05): a gateway model the catalog also shows
    // under athena-vllm stays on the gateway row alone, and a pick of it there is refused. Nothing visible: no rows.
    const llama = { id: 'llama-3.3-70b', label: 'Llama 3.3' }
    const withLlama = managedModels(config('enforce', [LUNA, llama]))
    expect(managedPickerRows(withLlama, CATALOG).map(row => [row.slug, row.models])).toEqual([
      ['custom:athena-gateway', ['gpt-6-luna', 'llama-3.3-70b']]
    ])
    expect(modelUseDecision(withLlama, { model: 'llama-3.3-70b', provider: 'custom:athena-vllm' }, 'rpc', 'config.set').allowed).toBe(false)
    expect(modelUseDecision(withLlama, { model: 'llama-3.3-70b', provider: 'athena-gateway' }, 'rpc', 'config.set').allowed).toBe(true)
    expect(managedPickerRows(managedModels(config('enforce', [MOCK])), CATALOG)).toEqual([])
  })
})

describe('model uses under the master switch', () => {
  const pick = (mode: string, model: string, provider?: string) =>
    modelUseDecision(managedModels(config(mode)), provider ? { model, provider } : { model }, 'rpc', 'config.set')

  test('enforce: outside the list is refused and recorded; allowed, hidden and subcommands pass', () => {
    expect(pick('enforce', 'gpt-4.1')).toEqual({
      allowed: false,
      record: { action: 'refused', id: 'gpt-4.1', mode: 'enforce', surface: 'rpc', target: 'config.set' }
    })
    expect(pick('enforce', 'gpt-6-sol', 'openrouter').allowed).toBe(false)
    expect(pick('enforce', 'gpt-6-sol', 'custom:athena-gateway')).toEqual({ allowed: true, record: null })
    expect(pick('enforce', 'mock')).toEqual({ allowed: true, record: null })
    expect(pick('enforce', 'reset')).toEqual({ allowed: true, record: null })
  })

  test('report: allowed, and a pick outside the list recorded; off: allowed, nothing recorded', () => {
    expect(pick('report', 'gpt-4.1')).toEqual({
      allowed: true,
      record: { action: 'allowed_in_report', id: 'gpt-4.1', mode: 'report', surface: 'rpc', target: 'config.set' }
    })
    expect(pick('report', 'gpt-6-luna')).toEqual({ allowed: true, record: null })
    expect(pick('off', 'gpt-4.1')).toEqual({ allowed: true, record: null })
  })

  test('the requests that pick a model', () => {
    expect(rpcModelChoice('config.set', { key: 'model', value: 'gpt-6-sol --provider custom:athena-gateway --session' })).toEqual({
      model: 'gpt-6-sol',
      provider: 'custom:athena-gateway'
    })
    expect(rpcModelChoice('config.set', { key: 'reasoning', value: 'high' })).toBeNull()
    expect(rpcModelChoice('slash.exec', { command: '/model gpt-4.1' })).toEqual({ model: 'gpt-4.1' })
    expect(rpcModelChoice('slash.exec', { command: 'model --reasoning high gpt-6-luna' })).toEqual({ model: 'gpt-6-luna' })
    expect(rpcModelChoice('slash.exec', { command: '/models' })).toBeNull()
    expect(rpcModelChoice('command.dispatch', { arg: 'gpt-4.1', name: 'model' })).toEqual({ model: 'gpt-4.1' })
    expect(rpcModelChoice('session.model', { model: 'gpt-6-luna', provider: 'custom:athena-gateway' })).toEqual({
      model: 'gpt-6-luna',
      provider: 'custom:athena-gateway'
    })
    expect(rpcModelChoice('prompt.submit', { text: '/model gpt-4.1' })).toBeNull()
    expect(slashModelChoice('--provider custom:athena-gateway gpt-6-sol')).toEqual({ model: 'gpt-6-sol', provider: 'custom:athena-gateway' })
    expect(slashModelReasoning('gpt-6-luna --reasoning HIGH')).toBe('high')
    expect(restModelChoice('POST', '/api/model/set', { model: 'gpt-4.1', provider: 'openai', scope: 'main' })).toEqual({
      model: 'gpt-4.1',
      provider: 'openai'
    })
    expect(restModelChoice('POST', '/api/model/set', { model: 'x', provider: 'y', scope: 'compression' })).toBeNull()
    expect(restModelChoice('GET', '/api/model/info', null)).toBeNull()
  })
})

describe('reasoning levels per model (slice 23)', () => {
  const models = managedModels(config())

  test('levels and default from the config; none-only reads as unavailable; unknown models say nothing', () => {
    expect(modelReasoning(models, 'gpt-6-sol')).toEqual({ defaultLevel: 'medium', levels: ['none', 'low', 'medium', 'high'] })
    expect(modelReasoning(models, 'gpt-4.1')).toBeNull()
    expect(modelReasoning(models, 'mock')).toEqual({ defaultLevel: 'none', levels: ['none'] })
    expect(reasoningUnavailable(modelReasoning(models, 'mock'))).toBe(true)
    expect(reasoningUnavailable(modelReasoning(models, 'gpt-6-luna'))).toBe(false)
  })

  test('switching keeps a level the model offers and resets any other to its default', () => {
    const luna = modelReasoning(models, 'gpt-6-luna')!

    expect(levelAfterSwitch(luna, 'high')).toBe('low')
    expect(levelAfterSwitch(luna, 'medium')).toBe('medium')
    expect(levelAfterSwitch(luna, 'false')).toBe('none')
    expect(levelAfterSwitch(luna, '')).toBe('low')
  })
})

describe("main's REST seam: the Settings default model", () => {
  let dir: string
  let log: PolicyDecisionLog

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'athena-models-'))
    log = new PolicyDecisionLog({ file: path.join(dir, 'policy-decisions.jsonl') })
    configureMainPolicies({ decisions: log })
  })

  afterEach(() => {
    setMainPolicySeams(null)
    configureMainPolicies({})
    rmSync(dir, { force: true, recursive: true })
  })

  const lines = () => {
    try {
      return readFileSync(log.file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch {
      return []
    }
  }

  const setDefault = (model: string, provider = 'custom:athena-gateway') =>
    refuseRestRequest({ body: { model, provider, scope: 'main' }, method: 'POST', path: '/api/model/set' })

  test('enforce refuses a default outside the list (recorded once); report lets it through and records it', () => {
    applyMainPolicies({ config: config('enforce') })
    expect(setDefault('gpt-6-luna')).toBeNull()
    expect(setDefault('gpt-4.1', 'openai')).not.toBeNull()

    applyMainPolicies({ config: config('report') })
    expect(setDefault('gpt-4.1', 'openai')).toBeNull()

    applyMainPolicies({ config: config('off') })
    expect(setDefault('gpt-4.1', 'openai')).toBeNull()

    expect(lines().map(line => [line.kind, line.id, line.action, line.mode, line.surface, line.target])).toEqual([
      ['model', 'gpt-4.1', 'refused', 'enforce', 'rest', 'POST /api/model/set'],
      ['model', 'gpt-4.1', 'allowed_in_report', 'report', 'rest', 'POST /api/model/set']
    ])
  })
})
