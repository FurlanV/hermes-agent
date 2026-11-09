// The Settings lists (nav, command palette rows, settings search, subpages)
// as the user sees them. The snapshot was recorded before the Athena feature
// filter was wired in, so it pins "allow everything looks exactly as before".
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as ConfigRecord from '@/app/hooks/use-config-record'
import type * as OverlayLayout from '@/app/overlays/overlay-split-layout'
import type { OverlayNavGroup, OverlayNavLink } from '@/app/overlays/overlay-split-layout'
import type * as BillingState from '@/app/settings/billing/use-billing-state'
import { settingsSubpages } from '@/app/settings/subpages'
import { useSettingsSearchCatalog } from '@/app/settings/use-settings-search'
import type * as WebAccess from '@/app/settings/web-access-settings'
import type * as HermesApi from '@/hermes'
import { $commandPaletteOpen, $commandPalettePage } from '@/store/command-palette'

import { setFeatureFilter } from './features'

const navCapture = vi.hoisted(() => ({ groups: [] as OverlayNavGroup[] }))
// Stable identity: a fresh function per render re-runs every effect keyed on it.
const requestGateway = vi.hoisted(() => async () => ({}))

vi.mock('@/app/overlays/overlay-split-layout', async importOriginal => ({
  ...(await importOriginal<typeof OverlayLayout>()),
  OverlayNav: ({ groups }: { groups: OverlayNavGroup[] }) => {
    navCapture.groups = groups

    return null
  }
}))

// Page bodies are not under test; only the lists around them are.
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

const config = {
  model_context_length: 0,
  timezone: 'UTC',
  agent: { max_turns: 90 },
  memory: { memory_enabled: true },
  voice: { auto_tts: false },
  updates: { non_interactive_local_changes: 'stash' }
}

vi.mock('@/app/hooks/use-config-record', async importOriginal => ({
  ...(await importOriginal<typeof ConfigRecord>()),
  useHermesConfigRecord: () => ({ data: config, isError: false, isFetching: false })
}))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getEnvVars: vi.fn(async () => ({
    BRAVE_API_KEY: { category: 'tool', description: 'Search', is_set: false, redacted_value: null, url: null },
    HTTPS_PROXY: { category: 'setting', description: 'Proxy', is_set: false, redacted_value: null, url: null }
  })),
  getHermesConfigRecord: vi.fn(async () => config),
  getHermesConfigSchema: vi.fn(async () => ({ category_order: [], fields: {} })),
  listAllProfileSessions: vi.fn(async () => ({ sessions: [], total: 0 }))
}))

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

interface NavRow {
  children?: NavRow[]
  id: string
  label: string
}

const navRows = (links: readonly OverlayNavLink[]): NavRow[] =>
  links.map(link => ({
    id: link.id,
    label: link.label,
    ...(link.children?.length ? { children: navRows(link.children) } : {})
  }))

async function renderSettingsNav(tab = 'about'): Promise<NavRow[]> {
  const { SettingsView } = await import('@/app/settings')
  const Wrapper = wrapper(`/settings?tab=${tab}`)
  navCapture.groups = []
  render(<SettingsView onClose={() => {}} />, { wrapper: Wrapper })
  await waitFor(() => expect(navCapture.groups.length).toBeGreaterThan(0))

  return navRows(navCapture.groups)
}

interface PaletteRow {
  group: string
  label: string
  value: string
}

async function renderPaletteSettingsRows(page: 'settings' | null): Promise<PaletteRow[]> {
  const { CommandPalette } = await import('@/app/command-palette')
  const Wrapper = wrapper('/')
  render(<CommandPalette />, { wrapper: Wrapper })
  act(() => {
    $commandPalettePage.set(page)
    $commandPaletteOpen.set(true)
  })

  const settingsHeading = 'Settings'

  return waitFor(() => {
    const found = screen
      .getAllByRole('option')
      .filter(
        item => item.closest('[cmdk-group]')?.querySelector('[cmdk-group-heading]')?.textContent === settingsHeading
      )
      .map(item => ({
        group: settingsHeading,
        label: item.textContent ?? '',
        value: (item.getAttribute('data-value') ?? '').split('\u0001')[1] ?? ''
      }))

    expect(found.length).toBeGreaterThan(0)

    return found
  })
}

async function searchCatalog() {
  const { result } = renderHook(() => useSettingsSearchCatalog(true), { wrapper: wrapper('/') })
  await waitFor(() => expect(result.current.credentialEntries.length).toBeGreaterThan(0))
  await waitFor(() => expect(result.current.configEntries.length).toBeGreaterThan(0))

  const ids = (entries: { id: string }[]) => entries.map(entry => entry.id)

  return {
    configEntries: ids(result.current.configEntries),
    credentialEntries: ids(result.current.credentialEntries),
    pluginEntries: ids(result.current.pluginEntries),
    settingEntries: ids(result.current.settingEntries),
    subpageEntries: ids(result.current.subpageEntries)
  }
}

beforeEach(() => {
  $commandPaletteOpen.set(false)
  $commandPalettePage.set(null)
})

afterEach(() => {
  cleanup()
  $commandPaletteOpen.set(false)
  setFeatureFilter(null)
})

describe('Settings lists with every feature allowed', () => {
  test('the Settings nav is unchanged', async () => {
    expect(await renderSettingsNav()).toMatchSnapshot()
  })

  test('the command palette Settings rows are unchanged (root and Settings page)', async () => {
    expect(await renderPaletteSettingsRows(null)).toMatchSnapshot()
    cleanup()
    $commandPaletteOpen.set(false)
    expect(await renderPaletteSettingsRows('settings')).toMatchSnapshot()
  })

  test('the settings search catalog is unchanged', async () => {
    expect(await searchCatalog()).toMatchSnapshot()
  })
})

const flatIds = (rows: NavRow[]): string[] => rows.flatMap(row => [row.id, ...flatIds(row.children ?? [])])

describe('one denied entry id leaves every Settings list at once', () => {
  test('a denied page (settings:gateway) leaves nav, palette, search and subpages', async () => {
    setFeatureFilter(id => id !== 'settings:gateway')

    const nav = flatIds(await renderSettingsNav())
    expect(nav).not.toContain('gateway')
    expect(nav.some(id => id.startsWith('gateway:'))).toBe(false)
    expect(nav).toContain('keybinds')
    cleanup()

    const palette = (await renderPaletteSettingsRows(null)).map(row => row.value)
    expect(palette).not.toContain('set-gateway')
    expect(palette).toContain('set-keys&kview=tools')
    cleanup()
    $commandPaletteOpen.set(false)

    const settingsPage = (await renderPaletteSettingsRows('settings')).map(row => row.value)
    expect(settingsPage).not.toContain('sp-gateway')
    cleanup()

    const search = await searchCatalog()
    expect(search.subpageEntries.filter(id => id.startsWith('settings-page:gateway:'))).toEqual([])
    expect(search.settingEntries.filter(id => id.startsWith('setting:gateway.'))).toEqual([])
    expect(search.subpageEntries).toContain('settings-page:keybinds:shortcuts')

    expect(settingsSubpages('gateway')).toEqual([])
  })

  test('a denied subpage (settings:about/updates) leaves nav, search and the subpage registry', async () => {
    setFeatureFilter(id => id !== 'settings:about/updates')

    const nav = flatIds(await renderSettingsNav('sessions'))
    expect(nav).toContain('about')
    expect(nav).not.toContain('about:updates')
    expect(nav).toContain('about:uninstall')
    cleanup()

    const search = await searchCatalog()
    expect(search.subpageEntries).not.toContain('settings-page:about:updates')
    expect(search.subpageEntries).toContain('settings-page:about:uninstall')
    // The manifest row on that subpage goes with it.
    expect(search.settingEntries).not.toContain('setting:about.updates')

    expect(settingsSubpages('about').map(page => page.id)).toEqual(['uninstall'])
  })

  test('a denied sub-view (settings:providers/keys) leaves the nav child and its palette row', async () => {
    setFeatureFilter(id => id !== 'settings:providers/keys')

    const nav = flatIds(await renderSettingsNav())
    expect(nav).toContain('pview:accounts')
    expect(nav).not.toContain('pview:keys')
    cleanup()

    const palette = (await renderPaletteSettingsRows(null)).map(row => row.value)
    expect(palette).toContain('set-providers&pview=accounts')
    expect(palette).not.toContain('set-providers&pview=keys')
  })

  test('a denied config section (settings:config:voice) leaves nav, palette and its fields in search', async () => {
    setFeatureFilter(id => id !== 'settings:config:voice')

    expect(flatIds(await renderSettingsNav())).not.toContain('config:voice')
    cleanup()

    expect((await renderPaletteSettingsRows(null)).map(row => row.value)).not.toContain('set-config-voice')
    cleanup()

    const search = await searchCatalog()
    expect(search.configEntries).not.toContain('config-field:voice.auto_tts')
    expect(search.configEntries).toContain('config-field:timezone')
    expect(search.subpageEntries.filter(id => id.startsWith('settings-page:config:voice:'))).toEqual([])
  })

  test('a denied config field (config-field:timezone) leaves search and the section field list', async () => {
    setFeatureFilter(id => id !== 'config-field:timezone')

    const { sectionFieldEntries } = await import('@/app/settings/helpers')
    const chatFields = (sectionFieldEntries({}, config).get('chat') ?? []).map(([key]) => key)
    expect(chatFields).not.toContain('timezone')

    const search = await searchCatalog()
    expect(search.configEntries).not.toContain('config-field:timezone')
    expect(search.configEntries).toContain('config-field:model_context_length')
  })
})
