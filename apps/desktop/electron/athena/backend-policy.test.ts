// F02 slice 17: a disabled feature is refused at the backend, not just hidden. Table-driven over the registry:
// every REST path, IPC channel and DevTools entry of every row that is off under the bundled default is sent
// straight to main's seams and refused; with the row turned on (dev override / admin `features`) it goes
// through, and IPC handlers come back. PUT/DELETE /api/env of a managed-scope variable is refused in every mode.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { envKeyOf, isManagedScopeEnvKey, restEntries, rpcEntries } from './backend-policy'
import { rowSurfaces, type SurfaceCall } from './backend-surfaces.test-helper'
import { BUNDLED_DEFAULT_CONFIG } from './bundled-config-data'
import { exportedFeatureRegistry, featureStates, rowConfigKeys } from './feature-registry'
import { applyMainPolicies, configureMainPolicies } from './main-policy'
import { PolicyDecisionLog } from './policy-decisions'
import {
  devToolsAllowed,
  guardedIpcMain,
  refuseRestRequest,
  resetIpcTrackingForTests,
  setMainPolicySeams,
  trackedIpcChannels
} from './policy-seams'

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

const withFeatures = (features: Record<string, string>, managed?: Record<string, string>) => ({
  ...bundled,
  features: { ...((bundled.features as Record<string, string>) ?? {}), ...features },
  ...(managed ? { managed: { ...(bundled.managed as object), ...managed } } : {})
})

const offByDefault = (id: string) => !featureStates(bundled).on(id)

let dir: string
let decisions: PolicyDecisionLog

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'athena-policy-'))
  decisions = new PolicyDecisionLog({ coalesceMs: 0, file: path.join(dir, 'policy-decisions.jsonl') })
  configureMainPolicies({ decisions })
})

afterEach(() => {
  setMainPolicySeams(null)
  resetIpcTrackingForTests()
  configureMainPolicies({})
  rmSync(dir, { force: true, recursive: true })
})

const lines = () => {
  try {
    return readFileSync(decisions.file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** Send one call to main's seams; true when it went through. IPC: registered after the policy was installed. */
function send(call: SurfaceCall): boolean {
  if (call.kind === 'rest') {
    return refuseRestRequest({ body: call.body, method: call.method, path: call.path }) === null
  }

  if (call.kind === 'ipc') {
    return guardedIpcMain({ handle: vi.fn(), removeHandler: vi.fn() }).handle(call.channel, () => null)
  }

  if (call.kind === 'devtools') {
    return devToolsAllowed()
  }

  throw new Error(`not a main surface: ${call.entry}`)
}

const MAIN_ROWS = rowSurfaces(['rest', 'ipc', 'devtools'])

describe('every disabled row is refused at REST, IPC and DevTools', () => {
  test('the table covers the audit surfaces', () => {
    const ids = MAIN_ROWS.map(({ row }) => row.id)

    for (const id of ['S77', 'S80', 'S82', 'S84', 'S91', 'S95', 'S97', 'S111', 'S113', 'S117', 'S124', 'S65']) {
      expect(ids, id).toContain(id)
    }
  })

  test.each(MAIN_ROWS.filter(({ row }) => offByDefault(row.id)).map(({ calls, row }) => [row.id, calls] as const))(
    '%s off: each surface is refused, and recorded',
    (id, calls) => {
      applyMainPolicies({ config: bundled })

      for (const call of calls) {
        expect(send(call), `${id} ${call.entry}`).toBe(false)
      }

      const recorded = lines().filter(line => line.surface !== 'ipc')
      expect(recorded.every(line => line.action === 'refused' && line.mode === 'enforce' && line.kind === 'feature')).toBe(
        true
      )
      expect(recorded.length).toBe(calls.filter(call => call.kind !== 'ipc').length)
    }
  )

  test.each(
    MAIN_ROWS.filter(({ row }) => offByDefault(row.id) && row.mark === 'disable').map(
      ({ calls, row }) => [row.id, calls] as const
    )
  )('%s turned on: each surface goes through', (id, calls) => {
    applyMainPolicies({ config: withFeatures({ [id]: 'on' }) })

    for (const call of calls) {
      expect(send(call), `${id} ${call.entry}`).toBe(true)
    }
  })

  test.each(
    MAIN_ROWS.filter(({ row }) => row.mark === 'remove').map(({ calls, row }) => [row.id, calls] as const)
  )('%s (remove) stays refused even with features: {%s: on}', (id, calls) => {
    applyMainPolicies({ config: withFeatures({ [id]: 'on' }) })

    for (const call of calls) {
      expect(send(call), `${id} ${call.entry}`).toBe(false)
    }
  })
})

describe('turning a row on re-opens its IPC within one snapshot', () => {
  test('S84 off → no Hermes Cloud handler; S124 on → terminal handlers registered again, and off again', () => {
    applyMainPolicies({ config: bundled })
    const ipc = { handle: vi.fn(), removeHandler: vi.fn() }
    const guarded = guardedIpcMain(ipc)
    guarded.handle('hermes:terminal:start', () => null)
    guarded.handle('hermes:cloud:login', () => null)
    guarded.handle('hermes:version', () => null)
    expect(ipc.handle.mock.calls.map(([channel]) => channel)).toEqual(['hermes:version'])

    applyMainPolicies({ config: withFeatures({ S124: 'on', S84: 'on' }) })
    expect(ipc.handle.mock.calls.map(([channel]) => channel)).toEqual(['hermes:version', 'hermes:terminal:start'])
    expect(trackedIpcChannels().find(entry => entry.channel === 'hermes:cloud:login')?.registered).toBe(false)

    applyMainPolicies({ config: bundled })
    expect(ipc.removeHandler.mock.calls).toEqual([['hermes:terminal:start']])
  })
})

describe('managed-scope env variables are refused in every mode', () => {
  const modes = [undefined, 'enforce', 'report', 'off']

  test.each(modes)('managed.features %s', mode => {
    const config = mode ? withFeatures({ S80: 'on', S95: 'on' }, { features: mode }) : withFeatures({ S95: 'on' })
    applyMainPolicies({ config })

    for (const key of ['HERMES_MANAGED_DIR', 'hermes_managed_dir', ' HERMES_MANAGED_DIR ', 'HERMES_HOME', 'ATHENA_MANAGED_BASE']) {
      for (const method of ['PUT', 'DELETE']) {
        expect(refuseRestRequest({ body: { key, value: '/tmp/x' }, method, path: '/api/env' }), `${method} ${key}`).not.toBeNull()
      }
    }

    // A tool key goes through once S95 is on (or filtering is off).
    expect(refuseRestRequest({ body: { key: 'BRAVE_API_KEY', value: 'x' }, method: 'PUT', path: '/api/env' })).toBeNull()
    expect(lines().filter(line => line.id === 'managed-scope')).toHaveLength(10)
    expect(lines()[0]).toMatchObject({ action: 'refused', kind: 'feature', source: 'desktop', surface: 'rest' })
  })

  test('reading env vars, and other paths, are not managed-scope writes', () => {
    expect(isManagedScopeEnvKey('HERMES_MANAGED_DIR')).toBe(true)
    expect(isManagedScopeEnvKey('OPENAI_API_KEY')).toBe(false)
    expect(envKeyOf({ method: 'GET', pathname: '/api/env' })).toBeNull()
    expect(envKeyOf({ body: { key: 'X' }, method: 'POST', pathname: '/api/env/reveal' })).toBe('X')
  })
})

describe('entry ids per call', () => {
  test('REST: path, method, WRITE and the env key', () => {
    expect(restEntries({ method: 'PUT', pathname: '/api/model/moa/' })).toEqual([
      'rest:/api/model/moa',
      'rest:PUT /api/model/moa',
      'rest:WRITE /api/model/moa'
    ])
    expect(restEntries({ body: { key: 'SUDO_PASSWORD' }, method: 'PUT', pathname: '/api/env' })).toContain(
      'credential:SUDO_PASSWORD'
    )
    expect(restEntries({ body: { key: 'OPENAI_API_KEY' }, method: 'DELETE', pathname: '/api/env' })).toContain(
      'env:OPENAI_API_KEY'
    )
  })

  test('JSON-RPC: method, action and the slash command a dispatch runs', () => {
    expect(rpcEntries('config.set', { key: 'yolo', value: 'on' })).toEqual(['rpc:config.set', 'rpc:config.set/yolo'])
    expect(rpcEntries('command.dispatch', { name: '/Usage' })).toEqual([
      'rpc:command.dispatch',
      'rpc:command.dispatch/Usage',
      'slash:usage'
    ])
    expect(rpcEntries('slash.exec', { command: '/debug now' })).toContain('slash:debug')
    expect(rpcEntries('plugins.manage', { action: 'install' })).toEqual(['rpc:plugins.manage', 'rpc:plugins.manage/install'])
  })
})

describe('config keys to pin (features.json)', () => {
  test('every row exports its config-field keys, without virtual fields', () => {
    const exported = new Map(exportedFeatureRegistry().features.map(row => [row.id, row.config_keys]))

    expect(exported.get('S44')).toEqual(['approvals.mode', 'approvals.timeout'])
    expect(exported.get('S59')).toEqual(['context.*', 'compression.*', 'auxiliary.compression.*'])
    expect(exported.get('S09')).toEqual([])
    expect(exported.get('S01')).toEqual([])
    expect(rowConfigKeys({ entries: ['config-field:a.b', 'settings:x', 'config-field:model_context_length'] })).toEqual([
      'a.b'
    ])
  })
})

describe('DevTools (S65)', () => {
  test('off by default, refused and recorded; on through the dev override', () => {
    applyMainPolicies({ config: bundled })
    expect(devToolsAllowed()).toBe(false)
    expect(lines()).toEqual([expect.objectContaining({ action: 'refused', id: 'S65', surface: 'devtools' })])

    applyMainPolicies({ config: withFeatures({ S65: 'on' }) })
    expect(devToolsAllowed()).toBe(true)
  })

  test('main.ts asks the seam in toggleDevTools, closes DevTools opened any other way, and hides the menu item', () => {
    const main = readFileSync(path.resolve(import.meta.dirname, '../main.ts'), 'utf8')
    const toggle = main.slice(main.indexOf('function toggleDevTools(window)'))

    expect(toggle.slice(0, 600)).toContain('if (!devToolsAllowed()) {')
    expect(main).toMatch(/'devtools-opened', \(\) => \{\s+if \(!devToolsAllowed\(\)\) \{\s+win\.webContents\.closeDevTools\(\)/)
    expect(main).toMatch(/label: 'Toggle Developer Tools',[\s\S]{0,200}visible: devToolsAllowed\(\),/)
    expect(main).toContain('onMainPoliciesChanged(() => {')
  })
})
