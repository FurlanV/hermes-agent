// F02 slice 19: the managed.features master switch in the renderer. A list asks the visibility filter; a use (a
// JSON-RPC call, a slash command, a shortcut, a page opened) asks `decideUse`. `enforce` hides, refuses and records
// the refusal; `report` hides and refuses nothing and records each use of a disabled feature once; `off` neither
// hides nor records.
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { BUNDLED_DEFAULT_CONFIG } from '../../../electron/athena/bundled-config-data'

import { $clientConfig, type ClientConfigSnapshot, setClientConfigSnapshot } from './client-config'
import { useAppRouteGuard } from './entry-point-guards'
import { isKeybindAllowed, isSlashCommandAllowed, isSlashCommandOffered } from './entry-points'
import { installFeaturePolicy } from './feature-policy'
import { $featureFilter } from './features'
import { PolicyRefusedError } from './policy-refusal'
import { assertRpcAllowed } from './rpc-seam'

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

const snapshot = (mode: string): ClientConfigSnapshot => ({
  config: { ...bundled, managed: { ...(bundled.managed as object), features: mode } },
  configVersion: 3,
  devOverridesActive: true,
  error: null,
  role: 'researcher',
  source: 'server',
  verifiedAt: null
})

const record = vi.fn()
let uninstall: () => void

beforeEach(() => {
  record.mockReset()
  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { policy: { record } }
  uninstall = installFeaturePolicy()
})

afterEach(() => {
  cleanup()
  uninstall()
  $clientConfig.set(null)
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

const recorded = () => record.mock.calls.map(([line]) => [line.id, line.action, line.mode, line.surface, line.target])

/** One use per surface, each of a disabled row: S53 (vault RPC), S119 (/tools), S113 (cron shortcut and page). */
function exerciseEachSurface(): Record<string, boolean> {
  const results: Record<string, boolean> = {}

  try {
    assertRpcAllowed('vault.list', {})
    results.rpc = true
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyRefusedError)
    results.rpc = false
  }

  results.slash = isSlashCommandAllowed(['tools'])
  results.keybind = isKeybindAllowed('nav.cron')
  const goHome = vi.fn()
  renderHook(() => useAppRouteGuard('/cron', '', goHome))
  results.route = goHome.mock.calls.length === 0

  return results
}

describe('managed.features in the renderer', () => {
  test('enforce: hidden, refused, each refusal recorded', () => {
    setClientConfigSnapshot(snapshot('enforce'))

    expect($featureFilter.get()('settings:vault')).toBe(false)
    expect(isSlashCommandOffered(['tools'])).toBe(false)
    expect(exerciseEachSurface()).toEqual({ keybind: false, route: false, rpc: false, slash: false })
    expect(recorded()).toEqual([
      ['S53', 'refused', 'enforce', 'rpc', 'vault.list'],
      ['S119', 'refused', 'enforce', 'slash', 'tools'],
      ['S113', 'refused', 'enforce', 'keybind', 'nav.cron'],
      ['S113', 'refused', 'enforce', 'route', '/cron']
    ])
  })

  test('report: nothing hidden or refused, one allowed_in_report record per use', () => {
    setClientConfigSnapshot(snapshot('report'))

    expect($featureFilter.get()('settings:vault')).toBe(true)
    expect(isSlashCommandOffered(['tools'])).toBe(true) // a list: nothing recorded
    expect(record).not.toHaveBeenCalled()
    expect(exerciseEachSurface()).toEqual({ keybind: true, route: true, rpc: true, slash: true })
    expect(recorded()).toEqual([
      ['S53', 'allowed_in_report', 'report', 'rpc', 'vault.list'],
      ['S119', 'allowed_in_report', 'report', 'slash', 'tools'],
      ['S113', 'allowed_in_report', 'report', 'keybind', 'nav.cron'],
      ['S113', 'allowed_in_report', 'report', 'route', '/cron']
    ])
    expect(record.mock.calls[0][0]).toEqual({
      action: 'allowed_in_report',
      id: 'S53',
      kind: 'feature',
      mode: 'report',
      surface: 'rpc',
      target: 'vault.list'
    })
  })

  test('report: a removed feature stays refused (and is recorded as refused)', () => {
    setClientConfigSnapshot(snapshot('report'))

    expect($featureFilter.get()('settings:billing')).toBe(false)
    expect(() => assertRpcAllowed('billing.state', {})).toThrow(PolicyRefusedError)
    expect(recorded()).toEqual([['S77', 'refused', 'report', 'rpc', 'billing.state']])
  })

  test('off: nothing hidden, refused or recorded (remove rows still out)', () => {
    setClientConfigSnapshot(snapshot('off'))

    expect($featureFilter.get()('settings:vault')).toBe(true)
    expect(exerciseEachSurface()).toEqual({ keybind: true, route: true, rpc: true, slash: true })
    expect(() => assertRpcAllowed('billing.state', {})).toThrow(PolicyRefusedError)
    expect(record).not.toHaveBeenCalled()
  })
})
