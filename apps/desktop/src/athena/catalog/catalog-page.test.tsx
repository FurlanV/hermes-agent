// @vitest-environment jsdom
// The Athena Capabilities page (F02 slice 28) through the real Capabilities route component: the researcher's and
// the clinician's cards, Managed entries, experimental badges, the detail view, the Literature search switch (over
// the Athena IPC bridge), learned skills (view and delete, never add or import), the "Ask Research IT" link and the
// stock tabs with `managed.tools: off`.
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'
import type { SkillInfo } from '@/types/hermes'

import { $clientConfig, type ClientConfigSnapshot } from '../managed/client-config'

import { BUNDLED_CATALOG, catalogCards, groupCards, requestToolsUrl, sendsLine, toolsMode } from './catalog'
import { learnedSkills } from './learned-skills'
import { $toolPrefs, type AthenaToolsBridge } from './tool-prefs'

const getSkills = vi.fn()
const getSkillContent = vi.fn()
const deleteLearningNode = vi.fn()
const getToolsets = vi.fn()
const getProfiles = vi.fn()
const getOfficialSkills = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  deleteLearningNode: (id: string, profile?: unknown) => deleteLearningNode(id, profile),
  getOfficialSkills: (profile?: unknown) => getOfficialSkills(profile),
  getProfiles: () => getProfiles(),
  getSkillContent: (name: string, profile?: unknown) => getSkillContent(name, profile),
  getSkills: (profile?: unknown) => getSkills(profile),
  getToolsets: (profile?: unknown) => getToolsets(profile)
}))

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

const { CapabilitiesView } = await import('@/app/capabilities')

// The demo roles' `tools` sections, as athena's compose seed serves them (deploy/compose/dev/client-config.*.yaml).
const RESEARCHER_TOOLS = {
  available: ['files', 'python', 'terminal', 'literature-search', 'browser', 'memory', 'learned-skills', 'todo',
    'subagents', 'summarise-paper', 'data-cleaning-pandas', 'clarify', 'desktop-projects'],
  default_on: ['files', 'python', 'terminal', 'literature-search', 'memory', 'learned-skills', 'todo',
    'summarise-paper', 'data-cleaning-pandas', 'clarify', 'desktop-projects'],
  experimental: ['browser', 'summarise-paper', 'data-cleaning-pandas'],
  locked_on: ['files', 'memory', 'clarify', 'desktop-projects']
}

const CLINICIAN_TOOLS = {
  available: ['files', 'python', 'terminal', 'literature-search', 'memory', 'learned-skills', 'todo', 'subagents',
    'clarify', 'desktop-projects'],
  default_on: ['files', 'python', 'memory', 'learned-skills', 'todo', 'clarify', 'desktop-projects'],
  experimental: [],
  locked_on: ['files', 'memory', 'clarify', 'desktop-projects']
}

function config(tools: object, extra: Record<string, unknown> = {}) {
  return { managed: { features: 'enforce', models: 'enforce', tools: 'enforce' }, tools, ...extra }
}

function snapshot(doc: Record<string, unknown>, role = 'researcher'): ClientConfigSnapshot {
  return { config: doc, configVersion: 118, devOverridesActive: false, error: null, role, source: 'server', verifiedAt: null }
}

function fakeBridge(initial: Record<string, boolean> = {}) {
  let prefs = { ...initial }

  const bridge = {
    getPrefs: vi.fn(async () => prefs),
    set: vi.fn(async (id: string, on: boolean) => {
      prefs = { ...prefs, [id]: on }

      return { applied: true, enabled: prefs, message: `${id}: ${on ? 'on' : 'off'}. Applies to new chats.`, ok: true }
    })
  } satisfies AthenaToolsBridge

  ;(window as { athenaDesktop?: unknown }).athenaDesktop = { tools: bridge }

  return bridge
}

const skill = (name: string, overrides: Partial<SkillInfo> = {}): SkillInfo => ({
  category: 'general',
  description: `${name} description`,
  enabled: true,
  name,
  provenance: 'agent',
  ...overrides
})

async function renderPage(doc: Record<string, unknown>, role = 'researcher') {
  $clientConfig.set(snapshot(doc, role))
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/capabilities']}>
          <CapabilitiesView />
        </MemoryRouter>
      </QueryClientProvider>
    )
  })

  return result!
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-slot="athena-catalog-card"][data-entry="${id}"]`)

const cardIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-slot="athena-catalog-card"]')].map(el => el.dataset.entry)

beforeEach(() => {
  getSkills.mockResolvedValue([
    skill('tidy-redcap-export'),
    skill('plot-growth-curves'),
    skill('summarise-paper'), // installed by the catalog: not learned
    skill('hand-dropped', { enabled: false }), // disabled by managed scope: not learned
    skill('arxiv', { provenance: 'bundled' })
  ])
  getSkillContent.mockResolvedValue({
    content: '---\nname: tidy-redcap-export\ndescription: x\n---\n\n# Tidy a REDCap export\n\nRename the columns.',
    name: 'tidy-redcap-export',
    path: '/skills/tidy-redcap-export/SKILL.md'
  })
  deleteLearningNode.mockResolvedValue({ message: 'archived', ok: true })
  getToolsets.mockResolvedValue([])
  getProfiles.mockResolvedValue({ profiles: [{ is_default: true, name: 'default' }] })
  getOfficialSkills.mockResolvedValue({ skills: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  queryClient.clear()
  $clientConfig.set(null)
  $toolPrefs.set({})
  delete (window as { athenaDesktop?: unknown }).athenaDesktop
})

describe('the catalog model', () => {
  test('cards follow tools.available, in its order; ids the build lacks are skipped', () => {
    const cards = catalogCards(config({ ...RESEARCHER_TOOLS, available: ['files', 'teleporter', 'python'] }))
    expect(cards.map(c => c.entry.id)).toEqual(['files', 'python'])
  })

  test('on/off mirrors the applier: locked wins, managed follows default_on, else the toggle, else default_on', () => {
    const tools = { ...RESEARCHER_TOOLS, locked_on: ['files'] }

    const on = (prefs: Record<string, boolean>) =>
      Object.fromEntries(catalogCards(config(tools), prefs).map(c => [c.entry.id, c.on]))

    expect(on({ files: false, memory: false, python: false, browser: true })).toMatchObject({
      browser: true, // user_toggle, the user's choice
      files: true, // locked_on
      memory: true, // user_toggle: false in the catalog: default_on decides
      python: false,
      subagents: false // default off
    })
  })

  test('the master switch: off, report, else enforce', () => {
    expect(toolsMode({ managed: { tools: 'off' } })).toBe('off')
    expect(toolsMode({ managed: { tools: 'report' } })).toBe('report')
    expect(toolsMode({ managed: { tools: 'nonsense' } })).toBe('enforce')
    expect(toolsMode({})).toBe('enforce')
  })

  test('groups A–Z, search over title, summary and tool names', () => {
    const cards = catalogCards(config(RESEARCHER_TOOLS))
    expect(groupCards(cards).map(g => g.group)).toEqual(['Research', 'Workspace'])
    expect(groupCards(cards, 'pubmed').flatMap(g => g.cards.map(c => c.entry.id))).toEqual(['literature-search'])
    expect(groupCards(cards, 'execute_code').flatMap(g => g.cards.map(c => c.entry.id))).toEqual(['python'])
    expect(groupCards(cards, 'zzz')).toEqual([])
  })

  test('the Sends line comes from the reviewed permissions', () => {
    expect(sendsLine(BUNDLED_CATALOG.entries['literature-search'])).toBe('Sends: search terms to the hospital search service')
    expect(sendsLine(BUNDLED_CATALOG.entries.python)).toBe('Sends: nothing beyond your chat')
  })

  test('the request link is tools.request_url (http, https, mailto), else none', () => {
    expect(requestToolsUrl(config({ request_url: 'https://help.example/tools' }))).toBe('https://help.example/tools')
    expect(requestToolsUrl(config({ request_url: 'mailto:research-it@example.org' }))).toBe('mailto:research-it@example.org')
    expect(requestToolsUrl(config({ request_url: 'javascript:alert(1)' }))).toBeNull()
    expect(requestToolsUrl(config({}))).toBeNull()
  })

  test('learned skills: local, on, and not installed by the catalog', () => {
    expect(
      learnedSkills([skill('b'), skill('a'), skill('summarise-paper'), skill('off', { enabled: false }), skill('hub', { provenance: 'hub' })]).map(s => s.name)
    ).toEqual(['a', 'b'])
  })
})

describe('the Capabilities page', { timeout: 30_000 }, () => {
  test("the researcher's config renders the expected cards, grouped, with no stock tabs", async () => {
    fakeBridge()
    await renderPage(config(RESEARCHER_TOOLS))

    expect(screen.getByText(/Tools approved by SickKids Research IT\. Changes apply to new chats\./)).toBeTruthy()
    expect(cardIds().sort()).toEqual([...RESEARCHER_TOOLS.available].sort())
    const research = screen.getByRole('region', { name: 'Research' })
    expect(within(research).getByText('Literature search')).toBeTruthy()
    expect(within(research).getByText('Browser')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Workspace' })).getByText('Files')).toBeTruthy()

    const literature = card('literature-search')!
    expect(within(literature).getByText(`v${BUNDLED_CATALOG.entries['literature-search'].version}`)).toBeTruthy()
    expect(within(literature).getByText('Search PubMed and the hospital library index.')).toBeTruthy()
    expect(within(literature).getByText('Sends: search terms to the hospital search service')).toBeTruthy()
    expect(within(literature).getByRole('switch', { name: 'Literature search' }).getAttribute('aria-checked')).toBe('true')
    expect(within(card('browser')!).getByRole('switch', { name: 'Browser' }).getAttribute('aria-checked')).toBe('false')

    for (const tab of ['Plugins', 'Connectors']) {
      expect(screen.queryByText(tab)).toBeNull()
    }
  })

  test('locked and admin-decided entries say Managed and have no switch', async () => {
    fakeBridge()
    await renderPage(config(RESEARCHER_TOOLS))

    for (const id of ['files', 'memory', 'clarify', 'desktop-projects']) {
      expect(within(card(id)!).getByText('Managed')).toBeTruthy()
      expect(within(card(id)!).queryByRole('switch')).toBeNull()
    }

    expect(within(card('python')!).queryByText('Managed')).toBeNull()
  })

  test('an entry not in tools.available is absent', async () => {
    fakeBridge()
    await renderPage(config(CLINICIAN_TOOLS), 'clinician')

    expect(cardIds().sort()).toEqual([...CLINICIAN_TOOLS.available].sort())
    expect(card('browser')).toBeNull()
    expect(screen.queryByText('Browser')).toBeNull()
    expect(card('summarise-paper')).toBeNull()
    // Available but off by default for the clinician.
    expect(within(card('terminal')!).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(within(card('literature-search')!).getByRole('switch').getAttribute('aria-checked')).toBe('false')
  })

  test('an experimental entry shows its badge; a stable one does not', async () => {
    fakeBridge()
    await renderPage(config(RESEARCHER_TOOLS))

    for (const id of ['browser', 'summarise-paper', 'data-cleaning-pandas']) {
      expect(within(card(id)!).getByText('Experimental')).toBeTruthy()
    }

    expect(within(card('literature-search')!).queryByText('Experimental')).toBeNull()
  })

  test('the detail view lists the tools inside and the review note', async () => {
    fakeBridge()
    await renderPage(config(RESEARCHER_TOOLS))
    const literature = card('literature-search')!

    fireEvent.click(within(literature).getByRole('button', { name: 'Details' }))
    expect(within(literature).getByText('web_search, web_extract')).toBeTruthy()
    expect(within(literature).getByText(/Egress limited to SearXNG/)).toBeTruthy()
    expect(within(literature).getByText('searxng.athena.internal')).toBeTruthy()
  })

  test('search narrows the cards', async () => {
    fakeBridge()
    await renderPage(config(RESEARCHER_TOOLS))

    fireEvent.change(screen.getByLabelText('Search tools'), { target: { value: 'pubmed' } })
    expect(cardIds()).toEqual(['literature-search'])
  })

  test('toggling Literature search off goes to main over the Athena bridge and says it applies to new chats', async () => {
    const bridge = fakeBridge()
    await renderPage(config(RESEARCHER_TOOLS))
    const literature = card('literature-search')!

    await act(async () => {
      fireEvent.click(within(literature).getByRole('switch', { name: 'Literature search' }))
    })

    expect(bridge.set).toHaveBeenCalledWith('literature-search', false)
    await waitFor(() => expect(within(literature).getByRole('status').textContent).toBe('Applies to new chats'))
    expect(within(literature).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect($toolPrefs.get()).toEqual({ 'literature-search': false })
  })

  test("the user's saved toggles are read from main on open", async () => {
    fakeBridge({ python: false })
    await renderPage(config(RESEARCHER_TOOLS))

    await waitFor(() =>
      expect(within(card('python')!).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    )
  })

  test('learned skills can be viewed and deleted', async () => {
    fakeBridge()
    await renderPage(config(RESEARCHER_TOOLS))
    const section = screen.getByRole('region', { name: 'Learned skills' })

    const toggle = await within(section).findByRole('button', { name: /Learned skills \(2\)/ })
    fireEvent.click(toggle)
    expect([...section.querySelectorAll<HTMLElement>('[data-skill]')].map(el => el.dataset.skill)).toEqual([
      'plot-growth-curves',
      'tidy-redcap-export'
    ])

    fireEvent.click(within(section).getByRole('button', { name: 'View tidy-redcap-export' }))
    expect(await within(section).findByText(/Rename the columns\./)).toBeTruthy()
    expect(getSkillContent).toHaveBeenCalledWith('tidy-redcap-export', undefined)

    fireEvent.click(within(section).getByRole('button', { name: 'Delete tidy-redcap-export' }))
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))
    getSkills.mockResolvedValue([skill('plot-growth-curves')])
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    })

    await waitFor(() => expect(deleteLearningNode).toHaveBeenCalledWith('tidy-redcap-export', undefined))
    await waitFor(() => expect(section.querySelector('[data-skill="tidy-redcap-export"]')).toBeNull())
    expect(within(section).getByRole('button', { name: /Learned skills \(1\)/ })).toBeTruthy()
  })

  test('nothing on the page can add, install or import a tool or a skill', async () => {
    fakeBridge()
    await renderPage(config(RESEARCHER_TOOLS))
    fireEvent.click(await screen.findByRole('button', { name: /Learned skills/ }))
    await screen.findByRole('button', { name: 'View tidy-redcap-export' })

    const controls = [...document.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="menuitem"]')]
    const labels = controls.map(el => `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.trim())
    expect(labels.filter(label => /\b(add|install|import|upload|url|json|new skill|create|edit)\b/i.test(label))).toEqual([])
    expect(document.querySelector('input[type="file"], textarea')).toBeNull()
    // The only text input is the search box.
    expect([...document.querySelectorAll('input')].map(input => input.getAttribute('aria-label') ?? input.placeholder)).toEqual([
      'Search tools'
    ])
  })

  test('the "Ask Research IT" link comes from the config and is hidden without one', async () => {
    fakeBridge()
    const view = await renderPage(config({ ...RESEARCHER_TOOLS, request_url: 'https://help.example/tools' }))
    expect(screen.getByRole('link', { name: 'Ask Research IT ▸' }).getAttribute('href')).toBe('https://help.example/tools')
    view.unmount()

    await renderPage(config(RESEARCHER_TOOLS))
    expect(screen.queryByText(/Ask Research IT/)).toBeNull()
  })

  test('report mode shows the same page', async () => {
    fakeBridge()
    await renderPage({ ...config(RESEARCHER_TOOLS), managed: { tools: 'report' } })

    expect(document.querySelector('[data-slot="athena-catalog-page"]')).toBeTruthy()
  })

  test('managed.tools: off (e.g. a dev override) brings back the stock tabs unchanged', async () => {
    await renderPage({ ...config(RESEARCHER_TOOLS), managed: { tools: 'off' } })

    expect(document.querySelector('[data-slot="athena-catalog-page"]')).toBeNull()

    for (const tab of ['Skills', 'Plugins', 'Connectors', 'Tools']) {
      expect(screen.getAllByText(tab).length).toBeGreaterThan(0)
    }
  })

  test('without the Athena bridge (no client config) the stock page renders', async () => {
    $clientConfig.set(null)
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/capabilities']}>
            <CapabilitiesView />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })

    expect(document.querySelector('[data-slot="athena-catalog-page"]')).toBeNull()
  })
})
