import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { $clientConfig, type AthenaClientConfigBridge, type ClientConfigSnapshot, connectClientConfig, managedByLine } from './client-config'
import { AthenaManagedLine } from './managed-line'

const snapshot = (overrides: Partial<ClientConfigSnapshot> = {}): ClientConfigSnapshot => ({
  config: { features: {} },
  configVersion: 118,
  devOverridesActive: false,
  error: null,
  role: 'researcher',
  source: 'server',
  verifiedAt: '2026-11-09T19:00:00Z',
  ...overrides
})

function fakeBridge(initial: unknown) {
  const listeners = new Set<(next: unknown) => void>()

  const bridge: AthenaClientConfigBridge = {
    snapshot: initial,
    get: async () => initial,
    onChanged: callback => {
      listeners.add(callback)

      return () => listeners.delete(callback)
    }
  }

  return { bridge, push: (next: unknown) => listeners.forEach(listener => listener(next)) }
}

afterEach(() => $clientConfig.set(null))

describe('the About line', () => {
  test.each([
    [snapshot(), 'Managed by SickKids · role researcher · config v118 (server)'],
    [snapshot({ source: 'last-good', error: 'bad_signature' }), 'Managed by SickKids · role researcher · config v118 (last good)'],
    [snapshot({ configVersion: null, role: null, source: 'bundled', error: 'missing' }), 'Managed by SickKids · no role · config built-in defaults'],
    [snapshot({ devOverridesActive: true }), 'Managed by SickKids · role researcher · config v118 (server) · dev overrides'],
    [null, 'Managed by SickKids · config not loaded']
  ])('%#: %s', (snap, line) => {
    expect(managedByLine(snap)).toBe(line)
  })

  test('follows main: a pushed config updates the line without a reload', async () => {
    const { bridge, push } = fakeBridge(snapshot())
    const off = connectClientConfig(bridge)
    render(<AthenaManagedLine />)

    expect(screen.getByText('Managed by SickKids · role researcher · config v118 (server)')).toBeTruthy()
    act(() => push(snapshot({ configVersion: 119, role: 'clinician' })))
    expect(screen.getByText('Managed by SickKids · role clinician · config v119 (server)')).toBeTruthy()

    // Junk from the bridge is ignored.
    act(() => push({ nope: true }))
    expect(screen.getByText('Managed by SickKids · role clinician · config v119 (server)')).toBeTruthy()
    off()
  })

  test('without the Electron bridge there is nothing to follow', () => {
    expect(() => connectClientConfig(undefined)()).not.toThrow()
    expect($clientConfig.get()).toBeNull()
  })
})
