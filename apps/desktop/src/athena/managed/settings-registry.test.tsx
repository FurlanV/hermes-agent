// F02 slice 15: every Settings row of the feature audit, driven from the
// registry. The lists are captured once with everything allowed (the real nav,
// palette rows and search catalog), then each row is turned off (every other
// row on) and on (every other row off) through the same filter functions the
// app uses, so a registry line that misses a surface fails here.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as ConfigRecord from '@/app/hooks/use-config-record'
import type * as OverlayLayout from '@/app/overlays/overlay-split-layout'
import type { OverlayNavGroup } from '@/app/overlays/overlay-split-layout'
import type * as BillingState from '@/app/settings/billing/use-billing-state'
import { SECTIONS } from '@/app/settings/constants'
import { sectionFieldEntries } from '@/app/settings/helpers'
import type { SettingsSearchEntry } from '@/app/settings/settings-search'
import { settingsSubpageForTarget } from '@/app/settings/subpages'
import { useSettingsSearchCatalog } from '@/app/settings/use-settings-search'
import type * as WebAccess from '@/app/settings/web-access-settings'
import type * as HermesApi from '@/hermes'
import { $commandPaletteOpen, $commandPalettePage } from '@/store/command-palette'
import { $notifications } from '@/store/notifications'

import { FEATURE_ROWS, featureEntryFilter, type FeatureRow, rowsForEntry } from '../../../electron/athena/feature-registry'

import { $clientConfig, type ClientConfigSnapshot } from './client-config'
import { installFeaturePolicy } from './feature-policy'
import { type FeatureFilter, setFeatureFilter } from './features'
import { hiddenRowsCss } from './hidden-rows'
import {
  allowedSettingsSearchEntries,
  filterSettingsNav,
  isSettingsTabAllowed,
  SUB_VIEW_PARAMS
} from './settings-entries'
import { FEATURE_UNAVAILABLE_NOTICE_ID, settingsRouteVerdict } from './settings-route-guard'

const navCapture = vi.hoisted(() => ({ groups: [] as OverlayNavGroup[] }))
const requestGateway = vi.hoisted(() => async () => ({}))

vi.mock('@/app/overlays/overlay-split-layout', async importOriginal => ({
  ...(await importOriginal<typeof OverlayLayout>()),
  OverlayNav: ({ groups }: { groups: OverlayNavGroup[] }) => {
    navCapture.groups = groups

    return null
  }
}))

vi.mock('@/app/settings/config-settings', () => ({ ConfigSettings: () => null }))
vi.mock('@/app/settings/about-settings', () => ({ AboutSettings: () => null }))

vi.mock('@/app/settings/billing/use-billing-state', async importOriginal => ({
  ...(await importOriginal<typeof BillingState>()),
  useBillingState: () => ({ data: undefined }),
  useSubscriptionState: () => ({ data: undefined })
}))

vi.mock('@/app/settings/web-access-settings', async importOriginal => ({
  ...(await importOriginal<typeof WebAccess>()),
  useWebAccessAvailable: () => true
}))

vi.mock('@/app/gateway/hooks/use-gateway-request', () => ({
  useGatewayRequest: () => ({ requestGateway })
}))

vi.mock('@/store/local-models-flag', async () => {
  const { atom } = await import('nanostores')

  return { $localModelsEnabled: atom(true) }
})

// Every config key Settings lists, so every field row exists in search.
const config: Record<string, unknown> = {}

for (const key of SECTIONS.flatMap(section => section.keys)) {
  const parts = key.split('.')
  let node = config

  for (const part of parts.slice(0, -1)) {
    node = (node[part] ??= {}) as Record<string, unknown>
  }

  node[parts.at(-1)!] = 'x'
}

vi.mock('@/app/hooks/use-config-record', async importOriginal => ({
  ...(await importOriginal<typeof ConfigRecord>()),
  useHermesConfigRecord: () => ({ data: config, isError: false, isFetching: false })
}))

const envVar = (category: string) => ({ category, description: '', is_set: false, redacted_value: null, url: null })

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getEnvVars: vi.fn(async () => ({
    API_SERVER_KEY: envVar('messaging'),
    BRAVE_API_KEY: envVar('tool'),
    HERMES_PREFILL_MESSAGES_FILE: envVar('setting'),
    SUDO_PASSWORD: envVar('setting'),
    TOOL_GATEWAY_URL: envVar('tool'),
    WEBHOOK_SECRET: envVar('messaging')
  })),
  getHermesConfigRecord: vi.fn(async () => config),
  getHermesConfigSchema: vi.fn(async () => ({ category_order: [], fields: {} })),
  listAllProfileSessions: vi.fn(async () => ({ sessions: [], total: 0 }))
}))

function wrapper(initialEntry: string, probe?: (search: string) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  function Probe() {
    const { search } = useLocation()
    probe?.(search)

    return null
  }

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialEntry]}>
          {children}
          <Probe />
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
}

async function renderSettings(tab: string, probe?: (search: string) => void) {
  const { SettingsView } = await import('@/app/settings')
  navCapture.groups = []
  render(<SettingsView onClose={() => {}} />, { wrapper: wrapper(`/settings?${tab}`, probe) })
  await waitFor(() => expect(navCapture.groups.length).toBeGreaterThan(0))

  return navCapture.groups
}

async function paletteTabs(): Promise<string[]> {
  const { CommandPalette } = await import('@/app/command-palette')
  render(<CommandPalette />, { wrapper: wrapper('/') })
  act(() => {
    $commandPalettePage.set(null)
    $commandPaletteOpen.set(true)
  })

  return waitFor(() => {
    const tabs = screen
      .getAllByRole('option')
      .filter(item => item.closest('[cmdk-group]')?.querySelector('[cmdk-group-heading]')?.textContent === 'Settings')
      .map(item => (item.getAttribute('data-value') ?? '').split('\u0001')[1]?.replace(/^set-/, '') ?? '')

    expect(tabs.length).toBeGreaterThan(0)

    return tabs
  })
}

async function searchEntries(): Promise<SettingsSearchEntry[]> {
  const wrap = wrapper('/')
  const { result } = renderHook(() => useSettingsSearchCatalog(true), { wrapper: wrap })
  await waitFor(() => expect(result.current.credentialEntries.length).toBeGreaterThan(0))
  await waitFor(() => expect(result.current.configEntries.length).toBeGreaterThan(0))
  const r = result.current

  return [...r.configEntries, ...r.credentialEntries, ...r.settingEntries, ...r.subpageEntries] as SettingsSearchEntry[]
}

// ── Items and the entry id each one is ──────────────────────────────────────

interface Item {
  entry: string
  key: string
  visible: (filter: FeatureFilter) => boolean
}

function navItems(groups: OverlayNavGroup[]): Item[] {
  const ids = (filter: FeatureFilter) =>
    new Set(filterSettingsNav(groups, filter).flatMap(g => [g.id, ...(g.children ?? []).map(c => `${g.id}>${c.id}`)]))

  return groups.flatMap(group => [
    { entry: `settings:${group.id}`, key: `nav ${group.id}`, visible: (f: FeatureFilter) => ids(f).has(group.id) },
    ...(group.children ?? []).map(child => {
      const prefix = [group.id, SUB_VIEW_PARAMS[group.id]].find(p => p && child.id.startsWith(`${p}:`))
      const page = prefix ? child.id.slice(prefix.length + 1) : child.id

      return {
        entry: `settings:${group.id}/${page}`,
        key: `nav ${group.id}>${child.id}`,
        visible: (f: FeatureFilter) => ids(f).has(`${group.id}>${child.id}`)
      }
    })
  ])
}

function paletteItems(tabs: string[]): Item[] {
  return tabs.map(tab => {
    const params = new URLSearchParams(`tab=${tab}`)
    const view = params.get('tab')!
    const page = params.get(SUB_VIEW_PARAMS[view] ?? 'page')

    return {
      entry: page ? `settings:${view}/${page}` : `settings:${view}`,
      key: `palette ${tab}`,
      visible: (f: FeatureFilter) => isSettingsTabAllowed(tab, f)
    }
  })
}

function searchItems(entries: SettingsSearchEntry[]): Item[] {
  return entries.map(entry => ({
    entry: entry.id.startsWith('settings-page:')
      ? `settings:${entry.target.view}/${entry.target.subpage}`
      : entry.id,
    key: `search ${entry.id}`,
    visible: (f: FeatureFilter) => allowedSettingsSearchEntries([entry], settingsSubpageForTarget, f).length === 1
  }))
}

function fieldItems(): Item[] {
  const schema = Object.fromEntries(SECTIONS.flatMap(s => s.keys).map(key => [key, { type: 'string' }])) as never

  return SECTIONS.flatMap(section =>
    section.keys.map(key => ({
      entry: `config-field:${key}`,
      key: `field ${key}`,
      visible: (f: FeatureFilter) => {
        setFeatureFilter(f)

        try {
          return (sectionFieldEntries(schema, {}).get(section.id) ?? []).some(([k]) => k === key)
        } finally {
          setFeatureFilter(null)
        }
      }
    }))
  )
}

function inPageItems(): Item[] {
  return FEATURE_ROWS.flatMap(row =>
    row.entries
      .filter(entry => /^(setting|credential):/.test(entry))
      .map(entry => ({
        entry,
        key: `in-page ${entry}`,
        visible: (f: FeatureFilter) => {
          const [kind, rest] = [entry.split(':')[0], entry.slice(entry.indexOf(':') + 1)]
          const dom = `${kind === 'setting' ? 'setting-field-' : 'credential-key-'}${rest.replace(/\*$/, '')}`

          return !hiddenRowsCss(f).includes(`"${dom}"`)
        }
      }))
  )
}

const onlyOff = (row: FeatureRow) =>
  featureEntryFilter({ features: { ...Object.fromEntries(FEATURE_ROWS.map(r => [r.id, 'on'])), [row.id]: 'off' } })

const onlyOn = (row: FeatureRow) =>
  featureEntryFilter({ features: { ...Object.fromEntries(FEATURE_ROWS.map(r => [r.id, 'off'])), [row.id]: 'on' } })

const reaches = (row: FeatureRow, entry: string) => rowsForEntry(entry)?.includes(row.id) ?? false

const exclusive = (row: FeatureRow, entry: string) => {
  const rows = rowsForEntry(entry)

  return rows !== null && rows.every(id => id === row.id)
}

const routeFor = (entry: string): null | string => {
  const match = /^settings:([^/]+)(?:\/(.+))?$/.exec(entry)

  if (!match) {
    return null
  }

  const [, view, page] = match

  return page ? `?tab=${view}&${SUB_VIEW_PARAMS[view] ?? 'page'}=${page}` : `?tab=${view}`
}

const SETTINGS_ROWS = FEATURE_ROWS.filter(row => Number(row.id.slice(1).replace(/[ab]$/, '')) <= 108)
let items: Item[] = []

beforeAll(async () => {
  const groups = await renderSettings('tab=about')
  cleanup()
  const tabs = await paletteTabs()
  cleanup()
  items = [...navItems(groups), ...paletteItems(tabs), ...searchItems(await searchEntries()), ...fieldItems(), ...inPageItems()]
  cleanup()
})

beforeEach(() => {
  $commandPaletteOpen.set(false)
  $commandPalettePage.set(null)
})

afterEach(() => {
  cleanup()
  setFeatureFilter(null)
  $clientConfig.set(null)
})

afterAll(() => setFeatureFilter(null))

describe('every Settings row of the audit', () => {
  test('every registered row reaches at least one surface it is listed for', () => {
    // Rows whose only reach is a page they share, or a surface outside these lists, are named here.
    const reach = new Map(SETTINGS_ROWS.map(row => [row.id, items.filter(item => reaches(row, item.entry))]))
    const unreached = SETTINGS_ROWS.filter(row => row.entries.length && !reach.get(row.id)!.length).map(r => r.id)

    // Only rows with a Settings-list entry must show up here: settings-control entries are FeatureGate'd in-page
    // controls, and entries outside Settings (palette, status bar, slash…) are entry-points.test.tsx's (slice 16).
    const SETTINGS_LIST = /^(settings|config-field|setting|credential):/
    const listed = (id: string) => SETTINGS_ROWS.find(r => r.id === id)!.entries.some(e => SETTINGS_LIST.test(e))

    expect(unreached.filter(listed)).toEqual([])
  })

  test('every config field Settings lists belongs to an audit row', () => {
    const unaudited = SECTIONS.flatMap(s => s.keys).filter(key => rowsForEntry(`config-field:${key}`) === null)

    expect(unaudited).toEqual([])
  })

  test.each(SETTINGS_ROWS.map(row => [row.id, row.mark, row] as const))(
    '%s (%s): off → gone from nav, palette, search, fields and its page; its route redirects. On → visible',
    (_id, mark, row) => {
      const off = onlyOff(row)
      const on = onlyOn(row)
      const own = items.filter(item => reaches(row, item.entry))
      const gone = own.filter(item => exclusive(row, item.entry))

      for (const item of gone) {
        expect(item.visible(off), `${item.key} still visible with ${row.id} off`).toBe(false)
      }

      for (const entry of row.entries.filter(e => exclusive(row, e))) {
        expect(off(entry), entry).toBe(false)
        const route = routeFor(entry)

        if (route) {
          expect(settingsRouteVerdict(route, off), `${route} with ${row.id} off`).not.toBe('ok')
        }
      }

      if (mark === 'remove') {
        // No flag: "on" in a config cannot bring it back.
        for (const item of gone) {
          expect(item.visible(on), `${item.key} visible for a remove row`).toBe(false)
        }

        return
      }

      for (const item of own) {
        expect(item.visible(on), `${item.key} hidden with only ${row.id} on`).toBe(true)
      }

      for (const entry of row.entries) {
        expect(on(entry), entry).toBe(true)
        const route = routeFor(entry)

        if (route) {
          // `first-child`: the page opens its first allowed child (Providers → Local models).
          expect(settingsRouteVerdict(route, on), `${route} with only ${row.id} on`).not.toBe('home')
        }
      }
    }
  )

  test('keep rows are visible with the build defaults; disable and remove rows are not', () => {
    const defaults = featureEntryFilter({})

    for (const row of SETTINGS_ROWS) {
      for (const item of items.filter(i => reaches(row, i.entry))) {
        if (row.mark === 'keep') {
          expect(item.visible(defaults), `${row.id} ${item.key}`).toBe(true)
        } else if (exclusive(row, item.entry)) {
          expect(item.visible(defaults), `${row.id} ${item.key}`).toBe(false)
        }
      }
    }
  })
})

const snapshot = (features: Record<string, string>, role = 'researcher', version = 118): ClientConfigSnapshot => ({
  config: { features, managed: { features: 'enforce' } },
  configVersion: version,
  devOverridesActive: false,
  error: null,
  role,
  source: 'server',
  verifiedAt: null
})

const navIds = (groups: OverlayNavGroup[]) => groups.flatMap(g => [g.id, ...(g.children ?? []).map(c => c.id)])

describe('live config in the real Settings view', () => {
  test('S82 on for the researcher shows Local models (only); the clinician config keeps it hidden', async () => {
    const off = installFeaturePolicy()

    try {
      $clientConfig.set(snapshot({}, 'clinician'))
      let nav = navIds(await renderSettings('tab=about'))
      expect(nav).not.toContain('providers')
      expect(nav).not.toContain('pview:local')

      // A new poll arrives: the open Settings re-filters without a reload.
      act(() => $clientConfig.set(snapshot({ S82: 'on' }, 'researcher', 119)))
      await waitFor(() => expect(navIds(navCapture.groups)).toContain('pview:local'))
      nav = navIds(navCapture.groups)
      expect(nav).toContain('providers')
      expect(nav.filter(id => id.startsWith('pview:'))).toEqual(['pview:local'])
    } finally {
      off()
    }
  })

  test('a route to a refused page lands on the Settings home with a quiet notice', async () => {
    const off = installFeaturePolicy()
    let search = ''

    try {
      $clientConfig.set(snapshot({}))
      await renderSettings('tab=billing', value => (search = value))
      await waitFor(() => expect(new URLSearchParams(search).get('tab')).toBeNull())
      expect($notifications.get().some(n => n.id === FEATURE_UNAVAILABLE_NOTICE_ID)).toBe(true)
    } finally {
      off()
    }
  })

  test('an open page that becomes refused closes to the Settings home', async () => {
    const off = installFeaturePolicy()
    let search = ''

    try {
      $clientConfig.set(snapshot({ S82: 'on' }))
      await renderSettings('tab=providers&pview=local', value => (search = value))
      expect(search).toBe('?tab=providers&pview=local')

      act(() => $clientConfig.set(snapshot({}, 'researcher', 120)))
      await waitFor(() => expect(new URLSearchParams(search).get('tab')).toBeNull())
    } finally {
      off()
    }
  })

  test('Providers with only Local models on opens Local models, not the refused Accounts view', async () => {
    const off = installFeaturePolicy()
    let search = ''

    try {
      $clientConfig.set(snapshot({ S82: 'on' }))
      await renderSettings('tab=providers', value => (search = value))
      await waitFor(() => expect(new URLSearchParams(search).get('pview')).toBe('local'))
    } finally {
      off()
    }
  })

  test('hosts with no Electron bridge get the build defaults', async () => {
    const off = installFeaturePolicy()

    try {
      const nav = navIds(await renderSettings('tab=about'))
      expect(nav).not.toContain('billing')
      expect(nav).not.toContain('web-access')
      expect(nav).toContain('keybinds')
    } finally {
      off()
    }
  })
})
