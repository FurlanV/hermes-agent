// @vitest-environment jsdom
// R01 slice 27: a package switched on while its upstream is down says "Not connected" on its card, with what happens
// next and a way to check again, in place of "Applies to new chats within a minute".
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'

import { $clientConfig } from '../managed/client-config'

import type * as McpReload from './mcp-reload'
import { $installedPackages, $toolPrefs } from './tool-prefs'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getOfficialSkills: async () => ({ skills: [] }),
  getProfiles: async () => ({ profiles: [{ is_default: true, name: 'default' }] }),
  getSkills: async () => [],
  getToolsets: async () => []
}))

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

const reload = vi.fn<typeof McpReload.reloadPackageServers>()

vi.mock('./mcp-reload', async importOriginal => ({
  ...(await importOriginal<typeof McpReload>()),
  reloadPackageServers: (...args: Parameters<typeof McpReload.reloadPackageServers>) => reload(...args)
}))

const { CapabilitiesView } = await import('@/app/capabilities')

function bridge() {
  let enabled: Record<string, boolean> = {}

  const tools = {
    getInstalled: vi.fn(async () => ({ 'stub-echo': { sha256: 'a'.repeat(64), version: '0.1.0' } })), // in Installed, off
    getPrefs: vi.fn(async () => enabled),
    set: vi.fn(async (id: string, on: boolean) => {
      enabled = { ...enabled, [id]: on }

      return { applied: true, enabled, message: '', ok: true }
    })
  }

  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { tools }

  return tools
}

async function renderPage() {
  $clientConfig.set({
    config: {
      managed: { features: 'enforce', models: 'enforce', tools: 'enforce' },
      tools: { available: ['files', 'stub-echo'], default_on: ['files'], experimental: ['stub-echo'], locked_on: [] }
    },
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
const line = (id: string) => card(id)?.querySelector<HTMLElement>('[data-slot="athena-catalog-unreachable"]') ?? null
const noteOf = (id: string) => card(id)?.querySelector<HTMLElement>('[data-slot="athena-catalog-note"]')?.textContent ?? null

async function switchOn(id: string) {
  await waitFor(() => expect(card(id)).toBeTruthy())
  await act(async () => fireEvent.click(within(card(id)!).getByRole('switch')))
}

beforeEach(() => {
  $toolPrefs.set({})
  $installedPackages.set({})
  reload.mockReset()
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  $clientConfig.set(null)
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

describe('a package whose server did not connect', { timeout: 30_000 }, () => {
  test('switched on while unreachable: the card says so, with no "within a minute" promise', async () => {
    bridge()
    reload.mockResolvedValue({ sent: true, unreachable: ['stub-echo'] })
    await renderPage()
    await switchOn('stub-echo')

    await waitFor(() => expect(line('stub-echo')).toBeTruthy())
    expect(line('stub-echo')!.textContent).toContain('Not connected')
    expect(line('stub-echo')!.textContent).toContain('tries again every few minutes')
    expect(noteOf('stub-echo')).toBeNull()
    expect(reload.mock.calls[0][0]).toContain('stub-echo') // the catalog's MCP packages are named to the helper
    expect(line('files')).toBeNull()
  })

  test('a refusal that names no server marks the package that was switched on', async () => {
    bridge()
    reload.mockResolvedValue({ sent: true, unreachable: null })
    await renderPage()
    await switchOn('stub-echo')

    await waitFor(() => expect(line('stub-echo')).toBeTruthy())
  })

  test('Check again: still down says so; once it connects the line goes and the card says Connected', async () => {
    bridge()
    reload.mockResolvedValue({ sent: true, unreachable: ['stub-echo'] })
    await renderPage()
    await switchOn('stub-echo')
    await waitFor(() => expect(line('stub-echo')).toBeTruthy())

    const again = () => within(card('stub-echo')!).getByRole('button', { name: /Check .* again/ })

    await act(async () => fireEvent.click(again()))
    await waitFor(() => expect(noteOf('stub-echo')).toBe('Still not connected'))
    expect(line('stub-echo')).toBeTruthy()

    reload.mockResolvedValue({ sent: true, unreachable: [] })
    await act(async () => fireEvent.click(again()))
    await waitFor(() => expect(line('stub-echo')).toBeNull())
    expect(noteOf('stub-echo')).toBe('Connected. Applies to new chats')
  })

  test('connected at switch-on: no line; the daemon not reachable keeps the old note', async () => {
    bridge()
    reload.mockResolvedValue({ sent: true, unreachable: [] })
    await renderPage()
    await switchOn('stub-echo')
    await waitFor(() => expect(noteOf('stub-echo')).toBe('Applies to new chats'))
    expect(line('stub-echo')).toBeNull()

    cleanup()
    $toolPrefs.set({})
    bridge()
    reload.mockResolvedValue({ sent: false, unreachable: [] })
    await renderPage()
    await switchOn('stub-echo')
    await waitFor(() => expect(noteOf('stub-echo')).toBe('Applies to new chats within a minute'))
  })

  test('switching the package off clears the line', async () => {
    bridge()
    reload.mockResolvedValue({ sent: true, unreachable: ['stub-echo'] })
    await renderPage()
    await switchOn('stub-echo')
    await waitFor(() => expect(line('stub-echo')).toBeTruthy())

    await act(async () => fireEvent.click(within(card('stub-echo')!).getByRole('switch')))
    await waitFor(() => expect(line('stub-echo')).toBeNull())
  })
})
