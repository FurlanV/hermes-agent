// F02 slice 19: the managed.features master switch in Electron main. `enforce` hides and refuses (and records the
// refusal); `report` lets everything through and appends one athena:policy_decision line per use of a disabled
// feature; `off` neither refuses nor records. Remove rows stay refused in every mode. The lines follow the shared
// policy-decisions.jsonl contract (policy-decisions.ts).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { featureDecider } from './backend-policy'
import { BUNDLED_DEFAULT_CONFIG } from './bundled-config-data'
import { featureEntryFilter, featureMode, managedMode } from './feature-registry'
import { applyMainPolicies, configureMainPolicies } from './main-policy'
import { parsePolicyDecision, PolicyDecisionLog } from './policy-decisions'
import {
  deepLinkAllowed,
  devToolsAllowed,
  guardedIpcMain,
  refuseRestRequest,
  resetIpcTrackingForTests,
  setMainPolicySeams
} from './policy-seams'

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

const withMode = (mode?: string, features: Record<string, string> = {}) => ({
  ...bundled,
  features: { ...((bundled.features as Record<string, string>) ?? {}), ...features },
  managed: { ...(bundled.managed as object), ...(mode ? { features: mode } : {}) }
})

let dir: string
let log: PolicyDecisionLog
let now = 0

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'athena-report-'))
  now = Date.parse('2026-11-09T20:00:00Z')
  log = new PolicyDecisionLog({ file: path.join(dir, 'policy-decisions.jsonl'), now: () => now })
  configureMainPolicies({ decisions: log })
})

afterEach(() => {
  setMainPolicySeams(null)
  resetIpcTrackingForTests()
  configureMainPolicies({})
  rmSync(dir, { force: true, recursive: true })
})

const lines = (): Record<string, unknown>[] => {
  try {
    return readFileSync(log.file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

const localModels = { method: 'GET', path: '/api/local-models/status' }
const billingPortal = { method: 'GET', path: '/api/portal/session' }

describe('managed.features: enforce | report | off', () => {
  test('a missing or unknown switch reads as enforce; models and tools read the same way', () => {
    expect(featureMode({})).toBe('enforce')
    expect(featureMode({ managed: { features: 'loose' } })).toBe('enforce')
    expect(featureMode(withMode('report'))).toBe('report')
    expect(managedMode({ managed: { models: 'off', tools: 'report' } }, 'models')).toBe('off')
    expect(managedMode({ managed: { models: 'off', tools: 'report' } }, 'tools')).toBe('report')
  })

  test('enforce hides and refuses, and records each refusal', () => {
    applyMainPolicies({ config: withMode('enforce') })

    expect(featureEntryFilter(withMode('enforce'))('settings:providers/local')).toBe(false)
    expect(refuseRestRequest(localModels)).not.toBeNull()
    expect(devToolsAllowed()).toBe(false)
    expect(lines().map(line => [line.id, line.action, line.mode, line.surface])).toEqual([
      ['S82', 'refused', 'enforce', 'rest'],
      ['S65', 'refused', 'enforce', 'devtools']
    ])
  })

  test('report hides and refuses nothing and emits one athena:policy_decision per use', () => {
    applyMainPolicies({ config: withMode('report') })

    expect(featureEntryFilter(withMode('report'))('settings:providers/local')).toBe(true)
    expect(refuseRestRequest(localModels)).toBeNull()
    expect(lines()).toEqual([
      {
        action: 'allowed_in_report',
        id: 'S82',
        kind: 'feature',
        mode: 'report',
        source: 'desktop',
        surface: 'rest',
        target: 'GET /api/local-models/status',
        ts: '2026-11-09T20:00:00.000Z'
      }
    ])

    // The same feature again within the coalescing window (a page polling): still one line. Later: one more.
    expect(refuseRestRequest(localModels)).toBeNull()
    expect(lines()).toHaveLength(1)
    now += 6000
    expect(refuseRestRequest(localModels)).toBeNull()
    expect(lines()).toHaveLength(2)

    // A feature row that is on is not recorded.
    expect(refuseRestRequest({ method: 'GET', path: '/api/config' })).toBeNull()
    expect(lines()).toHaveLength(2)
  })

  test('report registers disabled IPC channels and records each use; DevTools and deep links too', () => {
    applyMainPolicies({ config: withMode('report') })
    const ipc = { handle: vi.fn(), removeHandler: vi.fn() }
    const listener = vi.fn(() => 'started')

    expect(guardedIpcMain(ipc).handle('hermes:terminal:start', listener)).toBe(true)
    expect(lines()).toEqual([]) // registering is not a use
    const registered = ipc.handle.mock.calls[0][1] as (...args: unknown[]) => unknown
    expect(registered({}, { cols: 80 })).toBe('started')
    expect(devToolsAllowed()).toBe(true)
    expect(deepLinkAllowed({ kind: 'open', name: 'cron', params: {} })).toBe(true)

    expect(lines().map(line => [line.id, line.action, line.surface, line.target])).toEqual([
      ['S124', 'allowed_in_report', 'ipc', 'hermes:terminal:start'],
      ['S65', 'allowed_in_report', 'devtools', 'devtools'],
      ['S113', 'allowed_in_report', 'deep-link', 'open/cron']
    ])
  })

  test('off neither hides, refuses nor records', () => {
    applyMainPolicies({ config: withMode('off') })

    expect(featureEntryFilter(withMode('off'))('settings:providers/local')).toBe(true)
    expect(refuseRestRequest(localModels)).toBeNull()
    expect(devToolsAllowed()).toBe(true)
    expect(guardedIpcMain({ handle: vi.fn(), removeHandler: vi.fn() }).handle('hermes:terminal:start', () => null)).toBe(
      true
    )
    expect(lines()).toEqual([])
  })

  test.each(['enforce', 'report', 'off'])('%s: remove rows stay refused (recorded unless off)', mode => {
    applyMainPolicies({ config: withMode(mode, { S77: 'on' }) })

    expect(featureEntryFilter(withMode(mode))('settings:billing')).toBe(false)
    expect(refuseRestRequest(billingPortal)).not.toBeNull()
    expect(lines().map(line => [line.id, line.action])).toEqual(mode === 'off' ? [] : [['S77', 'refused']])
  })

  test('a row an admin turned on is not recorded in report mode', () => {
    const decide = featureDecider(withMode('report', { S82: 'on' }))

    expect(decide(['rest:/api/local-models/status'], 'rest', 'GET /api/local-models/status')).toEqual({
      allowed: true,
      record: null
    })
  })
})

describe('the policy-decisions.jsonl contract', () => {
  test('renderer records are validated before they are written', () => {
    expect(parsePolicyDecision({ action: 'allowed_in_report', id: 'S82', mode: 'report', surface: 'rpc' })).toEqual({
      action: 'allowed_in_report',
      id: 'S82',
      kind: 'feature',
      mode: 'report',
      surface: 'rpc'
    })
    expect(parsePolicyDecision({ action: 'x', id: 'S82', mode: 'loose', surface: 'rpc' })).toBeNull()
    expect(parsePolicyDecision({ action: 'x', id: '', mode: 'report', surface: 'rpc' })).toBeNull()
    expect(parsePolicyDecision({ action: 'x', id: 'a', kind: 'other', mode: 'report', surface: 'rpc' })).toBeNull()
    expect(parsePolicyDecision('nope')).toBeNull()
  })

  test('a file past its size cap is started over (the Shipper notices the truncation)', () => {
    const small = new PolicyDecisionLog({ coalesceMs: 0, file: path.join(dir, 'small.jsonl'), maxBytes: 300 })
    const decision = { action: 'refused', id: 'S82', kind: 'feature' as const, mode: 'enforce' as const, surface: 'rest' }

    for (let index = 0; index < 5; index += 1) {
      small.record({ ...decision, target: `GET /api/local-models/${index}` })
    }

    const kept = readFileSync(small.file, 'utf8').trim().split('\n')
    expect(kept.length).toBeLessThan(5)
    expect(JSON.parse(kept.at(-1)!)).toMatchObject({ target: 'GET /api/local-models/4' })
  })
})

describe('coalescing', () => {
  test('a refusal polled in the background is written once per 10 minutes; a report-mode use once per 5 s', () => {
    applyMainPolicies({ config: withMode('enforce') })

    for (let tick = 0; tick < 10; tick += 1) {
      refuseRestRequest(localModels)
      now += 60_000
    }

    expect(lines().filter(line => line.id === 'S82')).toHaveLength(1)
    now += 60_000
    refuseRestRequest(localModels)
    expect(lines().filter(line => line.id === 'S82')).toHaveLength(2)

    applyMainPolicies({ config: withMode('report') })
    refuseRestRequest(localModels)
    now += 5_000
    refuseRestRequest(localModels)
    expect(lines().filter(line => line.action === 'allowed_in_report')).toHaveLength(2)
  })
})
