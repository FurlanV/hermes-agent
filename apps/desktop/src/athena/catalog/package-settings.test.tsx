// @vitest-environment jsdom
// F03 slice 27: an installed package that declares settings shows a form in its details, one field per type (text,
// choice, toggle, number with bounds); an invalid value is refused here with a message and never sent; a valid one
// goes to main (`athena config settings <id> --values …`), only what differs from the defaults. A secret-typed
// setting is never shown as a field.
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'

import { $clientConfig } from '../managed/client-config'

import { BUNDLED_CATALOG, type CatalogSetting, isSecretSetting, settingProblem } from './catalog'
import { $installedPackages, $packageSettings, $toolPrefs } from './tool-prefs'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getOfficialSkills: async () => ({ skills: [] }),
  getProfiles: async () => ({ profiles: [{ is_default: true, name: 'default' }] }),
  getSkills: async () => [],
  getToolsets: async () => []
}))

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

const { CapabilitiesView } = await import('@/app/capabilities')

const SETTINGS: CatalogSetting[] = [
  { default: 'hello', id: 'greeting', title: 'Greeting', type: 'text' },
  { choices: ['human', 'mouse'], default: 'human', id: 'species', title: 'Species', type: 'choice' },
  { default: false, id: 'shout', title: 'Shout', type: 'toggle' },
  { default: 10, id: 'max_results', maximum: 50, minimum: 1, title: 'Results per answer', type: 'number' }
]

const SETTINGS_ECHO = { ...BUNDLED_CATALOG.entries['stub-echo'], id: 'settings-echo', settings: SETTINGS, title: 'Settings echo' }

const TOOLS = { available: ['files', 'settings-echo'], default_on: ['files'], experimental: ['settings-echo'], locked_on: [] }

function bridge(entry: Record<string, unknown> = SETTINGS_ECHO) {
  let settings: Record<string, Record<string, unknown>> = {}

  const tools = {
    getInstalled: vi.fn(async () => ({ 'settings-echo': { sha256: 'a'.repeat(64), version: '0.2.0' } })),
    getPrefs: vi.fn(async () => ({ 'settings-echo': true })),
    getSettings: vi.fn(async () => settings),
    package: vi.fn(),
    set: vi.fn(),
    setSettings: vi.fn(async (id: string, values: Record<string, unknown>) => {
      settings = { ...settings, [id]: values }

      return { applied: true, message: 'Settings of Settings echo saved. Applies to new chats.', ok: true, settings }
    })
  }

  const catalog = {
    catalog: { catalog_version: '2026.11.4', entries: { 'settings-echo': entry } },
    error: null,
    rejected: [],
    source: 'remote'
  }

  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { catalog: { get: async () => catalog, snapshot: catalog }, tools }

  return tools
}

async function openDetails() {
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
  const card = await screen.findByText('Settings echo')
  const root = card.closest<HTMLElement>('[data-slot="athena-catalog-card"]')!
  await act(async () => fireEvent.click(within(root).getByRole('button', { name: 'Details' })))

  return root
}

beforeEach(() => {
  $toolPrefs.set({})
  $installedPackages.set({})
  $packageSettings.set({})
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  $clientConfig.set(null)
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

describe('the settings schema in the app', () => {
  test('messages match the CLI; secret settings are recognised', () => {
    expect(settingProblem(SETTINGS[1], 'cat')).toBe('must be one of human, mouse')
    expect(settingProblem(SETTINGS[3], 0)).toBe('must be at least 1')
    expect(settingProblem(SETTINGS[3], Number.NaN)).toBe('must be a number')
    expect(settingProblem(SETTINGS[0], 'two\nlines')).toBe('must be one line of text')
    expect(settingProblem(SETTINGS[0], 'x'.repeat(201))).toBe('is longer than 200 characters')
    expect(settingProblem(SETTINGS[2], true)).toBeNull()
    expect(isSecretSetting({ id: 'pin', title: 'PIN', type: 'secret' as never })).toBe(true)
    expect(isSecretSetting({ id: 'api_key', title: 'Key', type: 'text' })).toBe(true)
    expect(SETTINGS.some(isSecretSetting)).toBe(false)
  })
})

describe('the settings form', { timeout: 30_000 }, () => {
  test('one field per type; an invalid value is refused with a message; a valid one is saved', async () => {
    const tools = bridge()
    const card = await openDetails()
    const form = card.querySelector<HTMLElement>('[data-slot="athena-catalog-settings"]')!
    expect((within(form).getByLabelText('Greeting') as HTMLInputElement).value).toBe('hello')
    expect((within(form).getByLabelText('Species') as HTMLSelectElement).value).toBe('human')
    expect(within(form).getByLabelText('Shout').getAttribute('role')).toBe('switch')
    const results = within(form).getByLabelText('Results per answer') as HTMLInputElement
    expect(results.value).toBe('10')

    fireEvent.change(results, { target: { value: '99' } })
    await act(async () => fireEvent.click(within(form).getByRole('button', { name: 'Save settings' })))
    expect(within(form).getByRole('alert').textContent).toBe('Results per answer must be at most 50')
    expect(tools.setSettings).not.toHaveBeenCalled()

    fireEvent.change(results, { target: { value: '20' } })
    fireEvent.change(within(form).getByLabelText('Species'), { target: { value: 'mouse' } })
    fireEvent.click(within(form).getByLabelText('Shout'))
    await act(async () => fireEvent.click(within(form).getByRole('button', { name: 'Save settings' })))
    expect(tools.setSettings).toHaveBeenCalledWith('settings-echo', { max_results: 20, shout: true, species: 'mouse' })
    expect(within(form).getByRole('status').textContent).toBe('Saved. Applies to new chats.')
    expect(within(form).queryByRole('alert')).toBeNull()
  })

  test('a package with a secret setting shows no form', async () => {
    bridge({ ...SETTINGS_ECHO, settings: [...SETTINGS, { id: 'pin', title: 'PIN', type: 'secret' }] })
    const card = await openDetails()
    expect(card.querySelector('[data-slot="athena-catalog-settings"]')).toBeNull()
    expect(card.querySelector('[data-slot="athena-catalog-settings-refused"]')?.textContent).toMatch(/secret setting/)
  })
})
