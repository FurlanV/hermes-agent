// F13 slice 17: a chat-only model (`models.allowed[].provider: gateway-chat`) is a Model gateway model on hermes's
// second gateway provider, `custom:athena-gateway-chat`, which athena's applier writes with the gateway's address and
// token command on Chat Completions. The Desktop learns it as it learned the bridge provider (F05 slice 02): the
// picker lists it on its own row, a pick on its own provider passes, a pick outside the role's list (or on the
// other gateway provider) is refused and recorded at both seams. Unlike a bridge model it may be the default.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { BUNDLED_DEFAULT_CONFIG } from './bundled-config-data'
import { applyMainPolicies, configureMainPolicies } from './main-policy'
import {
  ATHENA_GATEWAY_CHAT_PROVIDER,
  ATHENA_GATEWAY_PROVIDER,
  findModelEntry,
  GATEWAY_CHAT_MODEL_PROVIDER,
  isAthenaProvider,
  isBridgeProvider,
  managedModels,
  managedPickerRows,
  MODEL_PROVIDERS,
  modelUseDecision,
  rpcModelChoice
} from './model-policy'
import { PolicyDecisionLog } from './policy-decisions'
import { refuseRestRequest, setMainPolicySeams } from './policy-seams'

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

const SOL = { id: 'gpt-6-sol', label: 'GPT-6 Sol' }
const LUNA = { id: 'gpt-6-luna', label: 'GPT-6 Luna' }

const ACME = {
  id: 'acme-chat-1',
  label: 'Acme Chat',
  note: 'Chat only',
  provider: 'gateway-chat',
  reasoning: { default: 'none', levels: ['none'] }
}

const config = (allowed: unknown[], defaultId = 'gpt-6-sol') => ({
  ...bundled,
  models: { allowed, default: defaultId, max_turns_limit: 90 }
})

describe('a config that offers a chat-only model', () => {
  test('it is on the second gateway provider, listed on its own row after the gateway models', () => {
    const models = managedModels(config([SOL, ACME, LUNA]))

    expect(MODEL_PROVIDERS[GATEWAY_CHAT_MODEL_PROVIDER].slug).toBe(ATHENA_GATEWAY_CHAT_PROVIDER)
    expect(models.visible.map(entry => [entry.id, entry.provider])).toEqual([
      ['gpt-6-sol', ATHENA_GATEWAY_PROVIDER],
      ['acme-chat-1', ATHENA_GATEWAY_CHAT_PROVIDER],
      ['gpt-6-luna', ATHENA_GATEWAY_PROVIDER]
    ])
    expect(findModelEntry(models, 'acme-chat-1')).toMatchObject({ configId: 'acme-chat-1', label: 'Acme Chat' })
    expect(models.default).toBe('gpt-6-sol')
    expect(managedPickerRows(models, []).map(row => [row.slug, row.models])).toEqual([
      [ATHENA_GATEWAY_PROVIDER, ['gpt-6-sol', 'gpt-6-luna']],
      [ATHENA_GATEWAY_CHAT_PROVIDER, ['acme-chat-1']]
    ])
    expect(managedPickerRows(models, [])[1]).toMatchObject({ name: 'Athena gateway (chat)' })
    // Hermes lists the provider as `athena-gateway-chat`: its row is kept and carries exactly the role's model.
    expect(
      managedPickerRows(models, [
        { models: ['gpt-4.1'], slug: 'athena-gateway' },
        { models: ['acme-chat-1', 'other'], slug: 'athena-gateway-chat' }
      ]).map(row => [row.slug, row.models])
    ).toEqual([
      ['athena-gateway', ['gpt-6-sol', 'gpt-6-luna']],
      ['athena-gateway-chat', ['acme-chat-1']]
    ])
    // An Athena provider (the admin's note is its badge), not a model server's.
    expect(isAthenaProvider(ATHENA_GATEWAY_CHAT_PROVIDER)).toBe(true)
    expect(isAthenaProvider('athena-gateway-chat')).toBe(true)
    expect(isBridgeProvider(ATHENA_GATEWAY_CHAT_PROVIDER)).toBe(false)
  })

  test('it may be the role default (open question Q6)', () => {
    expect(managedModels(config([SOL, ACME], 'acme-chat-1')).default).toBe('acme-chat-1')
    expect(managedModels(config([ACME], 'acme-chat-1')).default).toBe('acme-chat-1')
  })

  test('a pick is accepted on its own provider only; one outside the list is refused and recorded', () => {
    const models = managedModels(config([SOL, ACME, LUNA]))

    const decide = (model: string, provider?: string) => modelUseDecision(models, { model, provider }, 'rpc', 'config.set')

    expect(decide('acme-chat-1', ATHENA_GATEWAY_CHAT_PROVIDER)).toEqual({ allowed: true, record: null })
    expect(decide('acme-chat-1', 'athena-gateway-chat').allowed).toBe(true)
    expect(decide('acme-chat-1').allowed).toBe(true)
    // On the other gateway provider hermes would call it on the Responses route, which it does not serve.
    expect(decide('acme-chat-1', ATHENA_GATEWAY_PROVIDER)).toEqual({
      allowed: false,
      record: { action: 'refused', id: 'acme-chat-1', mode: 'enforce', surface: 'rpc', target: 'config.set' }
    })
    expect(decide('gpt-6-sol', ATHENA_GATEWAY_CHAT_PROVIDER).allowed).toBe(false)
    expect(
      rpcModelChoice('config.set', { key: 'model', value: `acme-chat-1 --provider ${ATHENA_GATEWAY_CHAT_PROVIDER}` })
    ).toEqual({ model: 'acme-chat-1', provider: ATHENA_GATEWAY_CHAT_PROVIDER })

    // A role whose list does not offer it: refused and recorded, as for a gateway model.
    const other = managedModels(config([SOL, LUNA]))
    expect(modelUseDecision(other, { model: 'acme-chat-1', provider: ATHENA_GATEWAY_CHAT_PROVIDER }, 'slash', '/model'))
      .toEqual({
        allowed: false,
        record: { action: 'refused', id: 'acme-chat-1', mode: 'enforce', surface: 'slash', target: '/model' }
      })
    expect(managedPickerRows(other, []).flatMap(row => row.models)).toEqual(['gpt-6-sol', 'gpt-6-luna'])
  })

  test('a build that does not know the provider leaves the model out and keeps every other one', () => {
    // What this build did before slice 17, and what it does for any later provider: the same rule.
    const models = managedModels(config([SOL, { ...ACME, provider: 'gateway-later' }, LUNA], ACME.id))

    expect(models.visible.map(entry => entry.id)).toEqual(['gpt-6-sol', 'gpt-6-luna'])
    expect(models.default).toBe('gpt-6-sol')
    expect(modelUseDecision(models, { model: ACME.id }, 'rpc', 'config.set').allowed).toBe(false)
  })
})

// The Settings default goes through main's REST seam (`POST /api/model/set`): a chat-only model passes it on its own
// provider while the role offers it; otherwise it is refused and recorded like any other model.
describe("main's REST seam and a chat-only model", () => {
  const setDefault = (provider: string, model = ACME.id) => ({
    body: { model, provider, scope: 'main' },
    method: 'POST',
    path: '/api/model/set'
  })

  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'athena-gateway-chat-'))
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

  test('accepted on its own provider while offered; on the other gateway provider refused and recorded', () => {
    applyMainPolicies({ config: config([SOL, ACME, LUNA]) })

    expect(refuseRestRequest(setDefault(ATHENA_GATEWAY_CHAT_PROVIDER))).toBeNull()
    expect(recorded()).toEqual([])
    expect(refuseRestRequest(setDefault(ATHENA_GATEWAY_PROVIDER))).not.toBeNull()
    expect(recorded().map(row => [row.kind, row.action, row.id, row.surface, row.target])).toEqual([
      ['model', 'refused', ACME.id, 'rest', 'POST /api/model/set']
    ])
  })

  test('a role that does not offer it: refused and recorded', () => {
    applyMainPolicies({ config: config([SOL, LUNA]) })

    expect(refuseRestRequest(setDefault(ATHENA_GATEWAY_CHAT_PROVIDER))).not.toBeNull()
    expect(recorded()).toEqual([
      expect.objectContaining({ action: 'refused', id: ACME.id, kind: 'model', mode: 'enforce', surface: 'rest' })
    ])
  })
})
