// F02 slice 18: the remove rows are left out of the Athena variant. Every entry only remove rows list is
// unreachable, even with `features: {<id>: "on"}` from the server or the dev override; the last Nous surfaces are
// not mounted (onboarding, the free-tier dialog, strips and terms bar, the usage-stats consent, Hermes Cloud in the
// mode control, the diagnostics upload, "Check now", Advanced Delegation's install); opening Settings asks nothing
// about billing. The stock variant keeps everything (the managed client is inert there).
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as ConfigRecord from '@/app/hooks/use-config-record'
import type * as OverlayLayout from '@/app/overlays/overlay-split-layout'
import type * as HermesApi from '@/hermes'

import { BUNDLED_DEFAULT_CONFIG } from '../../../electron/athena/bundled-config-data'
import { FEATURE_ROWS, rowsForEntry } from '../../../electron/athena/feature-registry'
import { applyMainPolicies, ignoredRemoveRows } from '../../../electron/athena/main-policy'
import {
  guardedIpcMain,
  refuseRestRequest,
  resetIpcTrackingForTests,
  setMainPolicySeams
} from '../../../electron/athena/policy-seams'

import { $clientConfig, type ClientConfigSnapshot, setClientConfigSnapshot } from './client-config'
import { filterForSnapshot, installFeaturePolicy, rpcPolicyForSnapshot } from './feature-policy'
import { $featureFilter } from './features'

const requestGateway = vi.hoisted(() => vi.fn(async (_method: string, _params?: unknown) => ({})))

vi.mock('@/app/gateway/hooks/use-gateway-request', () => ({ useGatewayRequest: () => ({ requestGateway }) }))
vi.mock('@/app/overlays/overlay-split-layout', async importOriginal => ({
  ...(await importOriginal<typeof OverlayLayout>()),
  OverlayNav: () => null
}))
vi.mock('@/app/settings/config-settings', () => ({ ConfigSettings: () => null }))
vi.mock('@/app/settings/about-settings', () => ({ AboutSettings: () => null }))
vi.mock('@/app/hooks/use-config-record', async importOriginal => ({
  ...(await importOriginal<typeof ConfigRecord>()),
  useHermesConfigRecord: () => ({ data: {}, isError: false, isFetching: false })
}))
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getEnvVars: vi.fn(async () => ({})),
  getHermesConfigRecord: vi.fn(async () => ({})),
  getHermesConfigSchema: vi.fn(async () => ({ category_order: [], fields: {} })),
  listAllProfileSessions: vi.fn(async () => ({ sessions: [], total: 0 }))
}))

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>
const REMOVE_ROWS = FEATURE_ROWS.filter(row => row.mark === 'remove')

const snapshot = (
  features: Record<string, string> = {},
  extra: Partial<ClientConfigSnapshot> = {}
): ClientConfigSnapshot => ({
  config: { ...bundled, features: { ...((bundled.features as Record<string, string>) ?? {}), ...features } },
  configVersion: 7,
  devOverridesActive: false,
  error: null,
  role: 'researcher',
  source: 'server',
  verifiedAt: '2026-11-09T00:00:00.000Z',
  ...extra
})

/** Entries no row other than a remove row lists: what "left out of the build" covers. */
const removedOnly = (rowId: string) =>
  (FEATURE_ROWS.find(row => row.id === rowId)?.entries ?? []).filter(entry =>
    (rowsForEntry(entry) ?? []).every(id => FEATURE_ROWS.find(row => row.id === id)?.mark === 'remove')
  )

let uninstall: () => void

beforeEach(() => {
  requestGateway.mockClear()
  uninstall = installFeaturePolicy()
})

afterEach(() => {
  cleanup()
  uninstall()
  $clientConfig.set(null)
  setMainPolicySeams(null)
  resetIpcTrackingForTests()
})

describe('every remove row is unreachable in the Athena variant', () => {
  test('there are 22 remove rows, each with something to leave out', () => {
    expect(REMOVE_ROWS).toHaveLength(22)

    for (const row of REMOVE_ROWS) {
      expect(removedOnly(row.id).length, row.id).toBeGreaterThan(0)
    }
  })

  test.each(REMOVE_ROWS.map(row => [row.id] as const))('%s stays off with features: {%s: "on"}', id => {
    const cases = {
      'dev override': snapshot({ [id]: 'on' }, { devOverridesActive: true }),
      default: snapshot(),
      server: snapshot({ [id]: 'on' })
    }

    for (const [source, snap] of Object.entries(cases)) {
      const filter = filterForSnapshot(snap)

      for (const entry of removedOnly(id)) {
        expect(filter(entry), `${source}: ${entry}`).toBe(false)
      }

      // The master switch off does not bring a removed feature back either.
      const off = filterForSnapshot(snapshot({ [id]: 'on' }, { config: { ...snap.config, managed: { features: 'off' } } }))

      for (const entry of removedOnly(id)) {
        expect(off(entry), `off: ${entry}`).toBe(false)
      }
    }
  })

  test('a config turning a remove row on is noticed (main logs it and ignores it)', () => {
    expect(ignoredRemoveRows({ features: { S77: 'on', S82: 'on', S84: 'off', S91: 'on' } })).toEqual(['S77', 'S91'])
    expect(ignoredRemoveRows({})).toEqual([])
  })
})

function wrapper(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }
}

describe('opening Settings', () => {
  const billingCalls = () =>
    requestGateway.mock.calls.map(([method]) => method).filter(method => /^(billing|subscription)\./.test(String(method)))

  test('asks nothing about billing or subscriptions in the Athena variant', async () => {
    setClientConfigSnapshot(snapshot())
    const { SettingsView } = await import('@/app/settings')
    const view = render(<SettingsView onClose={() => {}} />, { wrapper: wrapper('/settings?tab=about') })
    await waitFor(() => expect(view.container.innerHTML).not.toBe(''))
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(billingCalls()).toEqual([])
  }, 60_000)

  test('the stock variant still reads billing.state and subscription.state', async () => {
    setClientConfigSnapshot(snapshot({}, { variant: 'stock' }))
    const { SettingsView } = await import('@/app/settings')
    render(<SettingsView onClose={() => {}} />, { wrapper: wrapper('/settings?tab=about') })

    await waitFor(() => expect(billingCalls()).toEqual(expect.arrayContaining(['billing.state', 'subscription.state'])))
  }, 60_000)
})

describe('the stock variant is untouched', () => {
  test('filter, JSON-RPC and main seams allow every remove and disable row', () => {
    const stock = snapshot({}, { variant: 'stock' })
    setClientConfigSnapshot(stock)
    applyMainPolicies(stock)

    expect(['settings:billing', 'settings:web-access', 'settings-control:gateway-mode-cloud', 'dialog:onboarding'].every(
      $featureFilter.get()
    )).toBe(true)
    expect(rpcPolicyForSnapshot(stock)('billing.state', {})).toBe(true)
    expect(refuseRestRequest({ method: 'GET', path: '/api/webapp-access/status' })).toBeNull()
    expect(guardedIpcMain({ handle: vi.fn(), removeHandler: vi.fn() }).handle('hermes:cloud:login', () => null)).toBe(
      true
    )
  })

  test('the Athena variant (and an older snapshot without a variant) refuses them', () => {
    for (const snap of [snapshot({}, { variant: 'athena' }), snapshot()]) {
      setClientConfigSnapshot(snap)
      applyMainPolicies(snap)
      expect($featureFilter.get()('settings:billing')).toBe(false)
      expect(refuseRestRequest({ method: 'GET', path: '/api/webapp-access/status' })).not.toBeNull()
    }
  })
})

describe('upstream hooks that leave the last Nous surfaces unmounted', () => {
  const desktop = path.resolve(import.meta.dirname, '../../..')
  const source = (file: string) => readFileSync(path.join(desktop, file), 'utf8')

  test.each([
    ['src/app/contrib/wiring.tsx', "!isMainWindow() || !isFeatureAllowed('dialog:onboarding')"],
    ['src/app/contrib/wiring.tsx', '{!isAuxiliaryWindow() && onboardingAllowed && ('],
    ['src/app/contrib/wiring.tsx', '{!isAuxiliaryWindow() && onboardingAllowed && <OnboardingEnd />}'],
    ['src/app/contrib/wiring.tsx', '{!isAuxiliaryWindow() && sharedMetricsAllowed && ('],
    ['src/app/contrib/wiring.tsx', '{!isAuxiliaryWindow() && freeTierAllowed && <FreeTierSignInDialog'],
    ['src/app/contrib/controller.tsx', '<FeatureGate entry="dialog:portal-terms">'],
    ['src/app/chat/composer/status-stack/index.tsx', "freeTierNotice && featureFilter('dialog:free-tier-notice')"],
    ['src/app/chat/composer/status-stack/index.tsx', "sharedMetricsOffer && featureFilter('dialog:shared-metrics-consent')"],
    ['src/app/settings/gateway-settings.tsx', '<FeatureGate entry="settings-control:gateway-mode-cloud">'],
    ['src/app/settings/gateway-settings.tsx', '<FeatureGate entry="settings-control:gateway-mode-local">'],
    ['src/app/settings/delegation/routing-section.tsx', "useFeatureEntry('settings-control:delegation-routing')"],
    ['src/app/settings/delegation/routing-section.tsx', "state === 'missing' && !installAllowed ? null"],
    ['src/components/update-status.tsx', '<FeatureGate entry="settings-control:updates-check-now">'],
    ['src/app/update-error-report.tsx', '{!diagnosticsAllowed ? null : !report ? ('],
    ['src/components/error-boundary.tsx', '{diagnosticsAllowed && ('],
    ['src/components/assistant-ui/thread/assistant-message.tsx', "useFeatureEntry('dialog:send-diagnostics')"],
    ['src/app/settings/index.tsx', 'useBillingState(billingAllowed)']
  ])('%s: %s', (file, hook) => {
    expect(source(file)).toContain(hook)
  })

  test('each gate names an entry a remove row (or the mode rows) lists', () => {
    const filter = filterForSnapshot(snapshot())

    for (const entry of [
      'dialog:onboarding',
      'dialog:shared-metrics-consent',
      'dialog:free-tier-sign-in',
      'dialog:free-tier-notice',
      'dialog:portal-terms',
      'settings-control:gateway-mode-cloud',
      'settings-control:delegation-install-plugin',
      'settings-control:updates-check-now',
      'dialog:send-diagnostics',
      'settings:billing'
    ]) {
      expect(rowsForEntry(entry), entry).not.toBeNull()
      expect(filter(entry), entry).toBe(false)
    }

    // Local stays choosable whenever another mode is offered.
    expect(filterForSnapshot(snapshot({ S85: 'on' }))('settings-control:gateway-mode-local')).toBe(true)
    expect(filterForSnapshot(snapshot({ S85: 'on' }))('settings-control:gateway-mode-cloud')).toBe(false)
    expect(filterForSnapshot(snapshot({ S13: 'on' }))('settings-control:delegation-routing')).toBe(true)
  })
})
