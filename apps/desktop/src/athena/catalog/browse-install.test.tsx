// @vitest-environment jsdom
// F03 slices 19 and 20: a remote package from the verified remote catalog shows in Browse with Install and not in
// Installed; Install goes through main (`athena config tool <id> install`) and the package then shows in Installed,
// switched on. Search by name and publisher and the category filter narrow Browse; a package the role may not see
// is absent; built-ins have no Install.
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'

import { $clientConfig } from '../managed/client-config'

import { BUNDLED_CATALOG } from './catalog'
import { $installedPackages, $toolPrefs } from './tool-prefs'

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

const REMOTE = {
  ...STUB,
  examples: ['Echo "hello" back to me.'],
  id: 'remote-echo',
  publisher: { contact: 'genomics@example.org', name: 'Genomics Core', team: 'genomics' },
  title: 'Remote echo'
}

const HIDDEN = { ...STUB, id: 'admin-only', roles: ['admin'], title: 'Admin only' }

const TOOLS = {
  available: ['files', 'python', 'stub-echo', 'remote-echo', 'admin-only'],
  default_on: ['files', 'python'],
  experimental: ['stub-echo', 'remote-echo', 'admin-only'],
  locked_on: []
}

function bridge(entries: Record<string, unknown> = {}) {
  let enabled: Record<string, boolean> = {}
  let installed: Record<string, unknown> = {}

  const tools = {
    getInstalled: vi.fn(async () => installed),
    getPrefs: vi.fn(async () => enabled),
    package: vi.fn(async (id: string, action: string) => {
      if (action === 'remove') {
        const { [id]: _record, ...rest } = installed
        const { [id]: _on, ...others } = enabled
        installed = rest
        enabled = others
      } else {
        installed = { ...installed, [id]: { sha256: 'a'.repeat(64), version: '0.2.0' } }
        enabled = { ...enabled, [id]: true }
      }

      return { action, applied: true, enabled, installed, message: 'installed', ok: true }
    }),
    set: vi.fn(async (id: string, on: boolean) => {
      enabled = { ...enabled, [id]: on }

      return { applied: true, enabled, message: '', ok: true }
    })
  }

  const catalog = {
    catalog: { catalog_version: '2026.11.4', entries: { 'admin-only': HIDDEN, 'remote-echo': REMOTE, ...entries } },
    error: null,
    rejected: [],
    source: 'remote'
  }

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

const cardIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-slot="athena-catalog-card"]')].map(el => el.dataset.entry)

const card = (id: string) => document.querySelector<HTMLElement>(`[data-slot="athena-catalog-card"][data-entry="${id}"]`)

async function browse() {
  await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Browse' })))
}

beforeEach(() => {
  $toolPrefs.set({})
  $installedPackages.set({})
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  $clientConfig.set(null)
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

describe('Browse and Installed', { timeout: 30_000 }, () => {
  test('a remote package not installed is in Browse with Install, not in Installed; Install puts it there, on', async () => {
    const tools = bridge()
    await renderPage()
    await waitFor(() => expect(cardIds().sort()).toEqual(['files', 'python']))
    await browse()
    expect(cardIds()).toEqual(['files', 'python', 'stub-echo', 'remote-echo']) // admin-only: not for this role
    expect(within(screen.getByRole('region', { name: 'Agents' })).getByText('Remote echo')).toBeTruthy()
    const remote = card('remote-echo')!
    expect(within(remote).getByText('Genomics Core')).toBeTruthy()
    expect(within(remote).getByText('public')).toBeTruthy() // the scopes' classification badge
    expect(within(card('files')!).getByText('Built-in')).toBeTruthy()
    expect(within(card('files')!).queryByRole('button', { name: /Install/ })).toBeNull()

    fireEvent.click(within(remote).getByRole('button', { name: 'Details' }))
    expect(within(remote).getByText('echo, reverse')).toBeTruthy()
    expect(within(remote).getByText(/Echo "hello" back to me\./)).toBeTruthy()
    expect(remote.querySelector('[data-slot="athena-catalog-scopes"]')?.textContent).toContain('Reverse (public)')

    await act(async () => fireEvent.click(within(remote).getByRole('button', { name: 'Install Remote echo' })))
    expect(tools.package).toHaveBeenCalledWith('remote-echo', 'install')
    await waitFor(() => expect(within(card('remote-echo')!).getByText('Installed')).toBeTruthy())
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Installed' })))
    expect(cardIds()).toContain('remote-echo')
    expect(within(card('remote-echo')!).getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  test('search by name and by publisher, and the category filter, narrow Browse', async () => {
    bridge()
    await renderPage()
    await browse()
    const search = screen.getByLabelText('Search tools')
    await act(async () => fireEvent.change(search, { target: { value: 'genomics core' } }))
    expect(cardIds()).toEqual(['remote-echo'])
    await act(async () => fireEvent.change(search, { target: { value: 'stub echo' } }))
    expect(cardIds()).toEqual(['stub-echo'])
    await act(async () => fireEvent.change(search, { target: { value: '' } }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Agents' })))
    expect(cardIds()).toEqual(['stub-echo', 'remote-echo'])
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Built-in' })))
    expect(cardIds()).toEqual(['files', 'python'])
  })
})

describe('Remove, deprecated and withdrawn (F03 slice 21)', { timeout: 30_000 }, () => {
  test('Remove sends the package back to Browse; built-ins and admin-installed packages have no Remove', async () => {
    const tools = bridge()
    await renderPage()
    await browse()
    await act(async () => fireEvent.click(within(card('remote-echo')!).getByRole('button', { name: 'Install Remote echo' })))
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Installed' })))
    expect(within(card('files')!).queryByRole('button', { name: /Remove/ })).toBeNull()
    await act(async () => fireEvent.click(within(card('remote-echo')!).getByRole('button', { name: 'Remove Remote echo' })))
    expect(tools.package).toHaveBeenLastCalledWith('remote-echo', 'remove')
    await waitFor(() => expect(cardIds()).not.toContain('remote-echo'))
    await browse()
    expect(within(card('remote-echo')!).getByRole('button', { name: 'Install Remote echo' })).toBeTruthy() // reinstallable
  })

  test('a deprecated card shows its end date; a withdrawn one says who and why, with no switch or Install', async () => {
    bridge({
      'old-echo': {
        ...REMOTE,
        id: 'old-echo',
        status: 'deprecated',
        status_note: { by: 'Genomics Core', ends: '2026-12-31', reason: 'Use Remote echo.' },
        title: 'Old echo'
      },
      'gone-echo': {
        ...REMOTE,
        id: 'gone-echo',
        status: 'withdrawn',
        status_note: { by: 'athena-admins', reason: 'The upstream was retired.' },
        title: 'Gone echo'
      }
    })
    $clientConfig.set(null)
    TOOLS.available.push('old-echo', 'gone-echo')
    TOOLS.default_on.push('old-echo', 'gone-echo')

    try {
      await renderPage()
      const old = card('old-echo')!
      expect(old.querySelector('[data-slot="athena-catalog-deprecated"]')?.textContent).toBe(
        'Deprecated by Genomics Core: Use Remote echo. It will be withdrawn on 2026-12-31.'
      )
      expect(within(old).getByRole('switch').getAttribute('aria-checked')).toBe('true') // it still works
      const gone = card('gone-echo')!
      expect(gone.querySelector('[data-slot="athena-catalog-withdrawn"]')?.textContent).toBe(
        'Withdrawn by athena-admins: The upstream was retired.'
      )
      expect(within(gone).queryByRole('switch')).toBeNull()
      await browse()
      expect(within(card('gone-echo')!).getByText('Installed')).toBeTruthy()
    } finally {
      TOOLS.available.splice(-2)
      TOOLS.default_on.splice(-2)
    }
  })
})
