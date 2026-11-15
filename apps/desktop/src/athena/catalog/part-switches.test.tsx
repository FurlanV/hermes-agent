// @vitest-environment jsdom
// F11 slice 07: in the Capabilities page a package whose catalog entry declares parts expands to its sources, each
// with its label, summary and a switch that goes to main (`athena config tool <id>/<part> on|off`). While the package
// is off its source switches are disabled. A package without parts looks as before, and the page keeps its text
// about when a change applies.
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'

import { $clientConfig } from '../managed/client-config'

import { BUNDLED_CATALOG, catalogCards, type CatalogEntry } from './catalog'
import { $toolPrefs } from './tool-prefs'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getOfficialSkills: async () => ({ skills: [] }),
  getProfiles: async () => ({ profiles: [{ is_default: true, name: 'default' }] }),
  getSkills: async () => [],
  getToolsets: async () => []
}))

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

const { CapabilitiesView } = await import('@/app/capabilities')

const DISEASE_TOOLS = ['list_annotation_sources', 'get_clingen_validity', 'get_panelapp_panels', 'get_sfari_gene']

const DISEASE: CatalogEntry = {
  ...BUNDLED_CATALOG.entries['stub-echo'],
  category: 'database',
  id: 'disease-evidence',
  parts: [
    { id: 'clingen', label: 'ClinGen', summary: 'Gene-disease validity curations.', tools: ['get_clingen_validity'] },
    { id: 'panelapp', label: 'PanelApp', summary: 'Gene panels from Genomics England.', tools: ['get_panelapp_panels'] },
    { id: 'sfari', label: 'SFARI', summary: 'SFARI Gene scores.', tools: ['get_sfari_gene'] }
  ],
  source: { gateway: { capability: 'eagle-annotations', tools: DISEASE_TOOLS } },
  summary: 'Disease evidence from curated sources.',
  title: 'Disease evidence'
}

const TOOLS = {
  available: ['files', 'disease-evidence', 'stub-echo'],
  default_on: ['files', 'disease-evidence', 'stub-echo'],
  experimental: ['disease-evidence', 'stub-echo'],
  locked_on: []
}

function partsBridge(initial: Record<string, boolean> = {}) {
  let prefs = { ...initial }

  const tools = {
    getInstalled: vi.fn(async () => ({})),
    getPrefs: vi.fn(async () => prefs),
    set: vi.fn(async (id: string, on: boolean) => {
      prefs = { ...prefs, [id]: on }

      return { applied: true, enabled: prefs, message: 'Applies to new chats.', ok: true }
    }),
    setPart: vi.fn(async (id: string, part: string, on: boolean) => {
      prefs = { ...prefs, [`${id}/${part}`]: on }

      return { applied: true, enabled: prefs, message: 'Applies to new chats.', ok: true }
    })
  }

  const catalog = {
    catalog: {
      catalog_version: '2026.11.11',
      entries: { 'disease-evidence': DISEASE, files: BUNDLED_CATALOG.entries.files, 'stub-echo': BUNDLED_CATALOG.entries['stub-echo'] }
    },
    error: null,
    rejected: [],
    source: 'remote'
  }

  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { catalog: { get: async () => catalog, snapshot: catalog }, tools }

  return tools
}

async function renderPage(tools: Record<string, unknown> = TOOLS) {
  $clientConfig.set({
    config: { managed: { features: 'enforce', models: 'enforce', tools: 'enforce' }, tools },
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

  return (await screen.findByText('Disease evidence')).closest<HTMLElement>('[data-slot="athena-catalog-card"]')!
}

async function expandSources(card: HTMLElement) {
  await act(async () => {
    fireEvent.click(within(card).getByRole('button', { name: /^Sources \(3\)$/ }))
  })

  return [...card.querySelectorAll<HTMLElement>('[data-slot="athena-catalog-part"]')]
}

const partSwitch = (card: HTMLElement, label: string) =>
  within(card).getByRole('switch', { name: `${label} in Disease evidence` })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  queryClient.clear()
  $clientConfig.set(null)
  $toolPrefs.set({})
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

describe('the model', () => {
  test("a card's parts follow the user's switch, else the role default, and wait for the package", () => {
    const catalog = { catalog_version: '2026.11.11', entries: { 'disease-evidence': DISEASE }, hermes_commit: 'x' }
    const config = { tools: { ...TOOLS, parts: { default_on: ['disease-evidence/clingen'] } } }
    const [card] = catalogCards(config, { 'disease-evidence/sfari': true }, catalog)
    expect(card.parts.map(p => [p.ref, p.on, p.packageOff])).toEqual([
      ['disease-evidence/clingen', true, false],
      ['disease-evidence/panelapp', false, false],
      ['disease-evidence/sfari', true, false]
    ])
    const [off] = catalogCards(config, { 'disease-evidence': false }, catalog)
    expect(off.on).toBe(false)
    expect(off.parts.every(p => p.packageOff)).toBe(true)
    const [plain] = catalogCards({ tools: TOOLS }, {}, { ...catalog, entries: { 'disease-evidence': { ...DISEASE, parts: undefined } } })
    expect(plain.parts).toEqual([])
  })
})

describe('the Capabilities page', { timeout: 30_000 }, () => {
  test('expanding Disease evidence shows its sources, each with a switch, and the page text stays', async () => {
    partsBridge()
    const card = await renderPage()

    expect(screen.getByText(/Changes apply to new chats\./)).toBeTruthy()
    expect(card.querySelector('[data-slot="athena-catalog-part"]')).toBeNull() // collapsed until asked
    const rows = await expandSources(card)
    expect(rows.map(row => row.dataset.part)).toEqual(['clingen', 'panelapp', 'sfari'])
    expect(within(rows[1]).getByText('PanelApp')).toBeTruthy()
    expect(within(rows[1]).getByText('Gene panels from Genomics England.')).toBeTruthy()

    for (const label of ['ClinGen', 'PanelApp', 'SFARI']) {
      expect(partSwitch(card, label).getAttribute('aria-checked')).toBe('true')
      expect(partSwitch(card, label).hasAttribute('disabled')).toBe(false)
    }
  })

  test('switching PanelApp off goes to main and is stored; a fresh page reads it back', async () => {
    const bridge = partsBridge()
    const card = await renderPage()
    await expandSources(card)

    await act(async () => {
      fireEvent.click(partSwitch(card, 'PanelApp'))
    })

    expect(bridge.setPart).toHaveBeenCalledWith('disease-evidence', 'panelapp', false)
    await waitFor(() => expect(partSwitch(card, 'PanelApp').getAttribute('aria-checked')).toBe('false'))
    expect(within(card).getByText('Applies to new chats')).toBeTruthy()
    expect($toolPrefs.get()).toEqual({ 'disease-evidence/panelapp': false })

    // After a restart the page asks main for the prefs again.
    cleanup()
    $toolPrefs.set({})
    partsBridge({ 'disease-evidence/panelapp': false })
    const again = await renderPage()
    await expandSources(again)
    await waitFor(() => expect(partSwitch(again, 'PanelApp').getAttribute('aria-checked')).toBe('false'))
    expect(partSwitch(again, 'ClinGen').getAttribute('aria-checked')).toBe('true')
  })

  test('with the package off, its source switches are disabled', async () => {
    partsBridge({ 'disease-evidence': false })
    const card = await renderPage()
    await waitFor(() => expect(within(card).getByRole('switch', { name: 'Disease evidence' }).getAttribute('aria-checked')).toBe('false'))
    await expandSources(card)

    for (const label of ['ClinGen', 'PanelApp', 'SFARI']) {
      expect(partSwitch(card, label).hasAttribute('disabled')).toBe(true)
    }

    expect(card.querySelector('[data-slot="athena-catalog-parts-off"]')?.textContent).toBe(
      'Disease evidence is off, so its sources are off too. Turn it on to use them.'
    )
  })

  test('a package without parts looks as before', async () => {
    partsBridge()
    await renderPage()
    const echo = (await screen.findByText(BUNDLED_CATALOG.entries['stub-echo'].title)).closest<HTMLElement>('[data-slot="athena-catalog-card"]')!

    expect(within(echo).queryByRole('button', { name: /Sources/ })).toBeNull()
    expect(echo.querySelector('[data-slot="athena-catalog-parts"]')).toBeNull()
  })
})

// F11 slice 08: a source an administrator locked for the role (the client config's `tools.parts.locked_on` and
// `locked_off`, or the package in `tools.locked_on`) shows its locked state, disabled, with "Set by your
// administrator"; an unlocked source of the same package can still be switched.
describe('a locked source', { timeout: 30_000 }, () => {
  const LOCKED = { ...TOOLS, parts: { locked_off: ['disease-evidence/sfari'], locked_on: ['disease-evidence/panelapp'] } }
  const lockText = (row: HTMLElement) => row.querySelector('[data-slot="athena-catalog-part-locked"]')?.textContent?.trim()

  test('locked off shows off, disabled, with the administrator text; the same for locked on', async () => {
    partsBridge({ 'disease-evidence/panelapp': false, 'disease-evidence/sfari': true }) // the user's own switches lose
    const card = await renderPage(LOCKED)
    const rows = await expandSources(card)
    await waitFor(() => expect($toolPrefs.get()).toMatchObject({ 'disease-evidence/sfari': true }))

    const sfari = rows.find(row => row.dataset.part === 'sfari')!
    expect(partSwitch(card, 'SFARI').getAttribute('aria-checked')).toBe('false')
    expect(partSwitch(card, 'SFARI').hasAttribute('disabled')).toBe(true)
    expect(lockText(sfari)).toBe('Set by your administrator')

    const panelapp = rows.find(row => row.dataset.part === 'panelapp')!
    expect(partSwitch(card, 'PanelApp').getAttribute('aria-checked')).toBe('true')
    expect(partSwitch(card, 'PanelApp').hasAttribute('disabled')).toBe(true)
    expect(lockText(panelapp)).toBe('Set by your administrator')
  })

  test('an unlocked source in the same package can still be switched', async () => {
    const bridge = partsBridge()
    const card = await renderPage(LOCKED)
    const rows = await expandSources(card)
    const clingen = rows.find(row => row.dataset.part === 'clingen')!

    expect(lockText(clingen)).toBeUndefined()
    expect(partSwitch(card, 'ClinGen').hasAttribute('disabled')).toBe(false)
    await act(async () => {
      fireEvent.click(partSwitch(card, 'ClinGen'))
    })
    expect(bridge.setPart).toHaveBeenCalledWith('disease-evidence', 'clingen', false)
    await waitFor(() => expect(partSwitch(card, 'ClinGen').getAttribute('aria-checked')).toBe('false'))
  })

  test('a package the administrator locked on locks its sources, except one locked off', () => {
    const catalog = { catalog_version: '2026.11.11', entries: { 'disease-evidence': DISEASE }, hermes_commit: 'x' }
    const config = { tools: { ...TOOLS, locked_on: ['disease-evidence'], parts: { locked_off: ['disease-evidence/sfari'] } } }
    const [card] = catalogCards(config, { 'disease-evidence/clingen': false }, catalog)
    expect(card.parts.map(p => [p.part.id, p.locked, p.on])).toEqual([
      ['clingen', true, true],
      ['panelapp', true, true],
      ['sfari', false, false]
    ])
    expect(catalogCards({ tools: TOOLS }, {}, catalog)[0].parts.every(p => p.locked === null)).toBe(true)
  })
})
