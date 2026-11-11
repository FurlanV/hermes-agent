// @vitest-environment jsdom
// F03 slice 26: a gateway package the user holds no grant for shows Request access in place of Install or the switch;
// requesting (with an optional reason) goes through main (`athena config tool <id> request --reason …`) and the card
// shows Requested; once the next sync brings the grant, the card shows its switch, on. A partial grant shows the
// scopes still pending. Without word from the platform the page shows no access state at all.
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'

import { $clientConfig } from '../managed/client-config'

import { BUNDLED_CATALOG, cardAccess, catalogCards } from './catalog'
import { $installedPackages, $packageAccess, $toolPrefs, type PackageAccess } from './tool-prefs'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getOfficialSkills: async () => ({ skills: [] }),
  getProfiles: async () => ({ profiles: [{ is_default: true, name: 'default' }] }),
  getSkills: async () => [],
  getToolsets: async () => []
}))

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

const { CapabilitiesView } = await import('@/app/capabilities')

const STUB = BUNDLED_CATALOG.entries['stub-echo']

const TOOLS = { available: ['files', 'stub-echo'], default_on: ['files'], experimental: ['stub-echo'], locked_on: [] }

const accessOf = (scopes: Record<string, 'granted' | 'none' | 'requested'>, state: 'active' | 'suspended' = 'active'): PackageAccess => ({
  packages: { 'stub-echo': { scopes, state } }
})

function bridge(initial: PackageAccess) {
  let access = initial
  let enabled: Record<string, boolean> = {}
  let installed: Record<string, unknown> = {}

  const tools = {
    getAccess: vi.fn(async () => access),
    getInstalled: vi.fn(async () => installed),
    getPrefs: vi.fn(async () => enabled),
    grant: (next: PackageAccess) => {
      access = next
    },
    package: vi.fn(async (id: string, action: string) => {
      installed = { ...installed, [id]: { sha256: 'a'.repeat(64), version: '0.2.0' } }
      enabled = { ...enabled, [id]: true }

      if (action === 'request') {
        access = accessOf({ 'echo.basic': 'requested', 'echo.reverse': 'requested' })
      }

      return { access, applied: true, enabled, installed, message: 'requested', ok: true }
    }),
    set: vi.fn(async () => ({ applied: true, enabled, message: '', ok: true }))
  }

  const catalog = { catalog: { catalog_version: '2026.11.4', entries: {} }, error: null, rejected: [], source: 'bundled' }
  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { catalog: { get: async () => catalog, snapshot: catalog }, tools }

  return tools
}

async function renderPage() {
  $clientConfig.set({
    config: { managed: { features: 'enforce', models: 'enforce', tools: 'enforce' }, tools: TOOLS },
    configVersion: 9,
    devOverridesActive: false,
    error: null,
    role: 'researcher',
    source: 'server',
    verifiedAt: null
  })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/capabilities']}>
          <CapabilitiesView />
        </MemoryRouter>
      </QueryClientProvider>
    )
  })
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-slot="athena-catalog-card"][data-entry="${id}"]`)

const tab = async (name: 'Browse' | 'Installed') => {
  await act(async () => fireEvent.click(screen.getByRole('tab', { name })))
}

beforeEach(() => {
  $toolPrefs.set({})
  $installedPackages.set({})
  $packageAccess.set(null)
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  $clientConfig.set(null)
  $packageAccess.set(null)
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

describe('access state of a card', () => {
  test('blocked without a granted scope or while suspended; pending and missing scopes by title', () => {
    expect(cardAccess(STUB, null)).toBeNull()
    expect(cardAccess(STUB, { packages: {} })).toBeNull()
    expect(cardAccess(BUNDLED_CATALOG.entries.files, accessOf({}))).toBeNull()
    expect(cardAccess(STUB, accessOf({ 'echo.basic': 'requested' }))).toEqual({
      blocked: true,
      missing: ['Reverse'],
      pending: ['Echo'],
      suspended: false
    })
    expect(cardAccess(STUB, accessOf({ 'echo.basic': 'granted', 'echo.reverse': 'none' }))?.blocked).toBe(false)
    expect(cardAccess(STUB, accessOf({ 'echo.basic': 'granted' }, 'suspended'))?.blocked).toBe(true)
  })

  test('a blocked package is off for new chats even when its switch is on, as the applier leaves it out', () => {
    const config = { tools: TOOLS }
    const [, stub] = catalogCards(config, { 'stub-echo': true }, BUNDLED_CATALOG, {}, 'researcher', accessOf({ 'echo.basic': 'none' }))
    expect(stub.on).toBe(false)
    const [, granted] = catalogCards(config, { 'stub-echo': true }, BUNDLED_CATALOG, {}, 'researcher', accessOf({ 'echo.basic': 'granted' }))
    expect(granted.on).toBe(true)
  })
})

describe('Request access', { timeout: 30_000 }, () => {
  test('Browse offers Request access, then Requested; the grant at the next sync turns the card on', async () => {
    const tools = bridge(accessOf({ 'echo.basic': 'none', 'echo.reverse': 'none' }))
    await renderPage()
    await tab('Browse')
    const stub = card('stub-echo')!
    expect(within(stub).queryByRole('button', { name: /^Install/ })).toBeNull()
    fireEvent.click(within(stub).getByRole('button', { name: 'Request access to Stub echo (dev)' }))
    fireEvent.change(within(stub).getByLabelText('Why you need Stub echo (dev) (optional)'), {
      target: { value: 'To test the gateway.' }
    })
    await act(async () => fireEvent.click(within(stub).getByRole('button', { name: 'Send request' })))
    expect(tools.package).toHaveBeenCalledWith('stub-echo', 'request', { reason: 'To test the gateway.' })
    await tab('Installed')
    await waitFor(() => expect(within(card('stub-echo')!).getByText('Requested')).toBeTruthy())
    expect(within(card('stub-echo')!).queryByRole('switch')).toBeNull()

    // The next sync brings the grant: the page reads the access file again on its next visit.
    tools.grant(accessOf({ 'echo.basic': 'granted', 'echo.reverse': 'requested' }))
    cleanup()
    await renderPage()
    await waitFor(() => expect(within(card('stub-echo')!).getByRole('switch').getAttribute('aria-checked')).toBe('true'))
    expect(card('stub-echo')!.querySelector('[data-slot="athena-catalog-pending"]')?.textContent).toContain(
      'Not granted yet: Reverse (requested)'
    )
  })

  test('without word from the platform the card is as before; a suspended package says so', async () => {
    bridge({ packages: {} })
    await renderPage()
    await tab('Browse')
    expect(within(card('stub-echo')!).getByRole('button', { name: 'Install Stub echo (dev)' })).toBeTruthy()
    cleanup()
    bridge(accessOf({ 'echo.basic': 'granted' }, 'suspended'))
    await renderPage()
    await tab('Browse')
    expect(within(card('stub-echo')!).getByText('Suspended')).toBeTruthy()
    expect(card('stub-echo')!.querySelector('[data-slot="athena-catalog-suspended-note"]')).not.toBeNull()
  })
})
