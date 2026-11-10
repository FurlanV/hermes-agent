// F02 slice 20: with the role's allowed models installed from the client config, every picker surface (the composer
// model menu, the picker dialog, Edit Models and the Settings default-model select) lists exactly the visible allowed
// models, in config order, with their labels. No typed id can be added, a remembered custom id is not shown, the
// hidden `mock` entry never shows, and an admin change shows at once (no "Refresh Models").
import type { ModelOptionsResult } from '@hermes/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as ConfigApi from '@/api/config'
import { ModelSettings } from '@/app/settings/model-settings'
import { ModelCatalogMenu, ModelMenuCloseContext, type ModelMenuController } from '@/app/shell/model-catalog-menu'
import { ModelPickerDialog } from '@/components/model-picker'
import { ModelVisibilityDialog } from '@/components/model-visibility-dialog'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { I18nProvider } from '@/i18n'
import { requestModelOptions } from '@/lib/model-options'
import { displayModelName } from '@/lib/model-status-label'
import { queryClient } from '@/lib/query-client'
import { $customModels } from '@/store/custom-models'
import { $favoriteModels } from '@/store/favorite-models'
import { $localModelsEnabled } from '@/store/local-models-flag'
import { $visibleModels, setModelVisibilityOpen } from '@/store/model-visibility'
import { clearNotifications } from '@/store/notifications'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { $clientConfig, type ClientConfigSnapshot, setClientConfigSnapshot } from './client-config'
import { LUNA, managedSnapshot, MOCK, SOL } from './managed-models-fixture'
import { installModelPolicy } from './model-policy'
import { MODEL_CATALOG, REMEMBERED_CUSTOM_MODELS, TYPED_CUSTOM_ID } from './model-rows-fixture'
import { allowsCustomModelIds, isModelSelectable } from './models'

const CATALOG: ModelOptionsResult = {
  ...MODEL_CATALOG,
  providers: [
    ...(MODEL_CATALOG.providers ?? []),
    { authenticated: true, models: ['llama-3.3-70b'], name: 'Athena vLLM', slug: 'custom:athena-vllm' }
  ]
}

vi.mock('@/hermes', async () => ({
  ...(await vi.importActual<typeof ConfigApi>('@/api/config')),
  getApiRequestProfile: () => 'default',
  getAuxiliaryModels: vi.fn(async () => ({ main: { model: 'gpt-6-sol', provider: 'custom:athena-gateway' }, tasks: [] })),
  getGlobalModelInfo: vi.fn(async () => ({ model: 'gpt-6-sol', provider: 'custom:athena-gateway' })),
  getGlobalModelOptions: vi.fn(async () => CATALOG),
  getHermesConfigRecord: vi.fn(async () => ({ agent: { reasoning_effort: 'medium' } })),
  getLocalModelsJobs: vi.fn(async () => ({ jobs: [] })),
  getLocalModelsStatus: vi.fn().mockResolvedValue({ loading: {} }),
  getMoaModels: vi.fn(async () => null),
  getRecommendedDefaultModel: vi.fn(async () => null),
  profileScopeKey: (scope?: null | string) => (scope ?? '').trim() || 'default',
  saveHermesConfig: vi.fn(async () => ({ ok: true })),
  setApiRequestProfile: () => {}
}))
vi.mock('@/lib/model-options', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestModelOptions: vi.fn()
}))
vi.mock('@/app/hooks/use-on-profile-switch', () => ({ useOnProfileSwitch: () => {} }))

stubResizeObserver()
stubMenuDomApis()

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

let uninstall: () => void

beforeEach(() => {
  vi.mocked(requestModelOptions).mockResolvedValue(CATALOG)
  queryClient.clear()
  window.localStorage.clear()
  $visibleModels.set(null)
  $favoriteModels.set([])
  $customModels.set(REMEMBERED_CUSTOM_MODELS)
  $localModelsEnabled.set(false)
  setModelVisibilityOpen(false)
  uninstall = installModelPolicy()
  setClientConfigSnapshot(managedSnapshot([SOL, LUNA, MOCK]))
})

afterEach(() => {
  cleanup()
  uninstall()
  $clientConfig.set(null)
  $customModels.set([])
  clearNotifications()
  vi.clearAllMocks()
})

const controller = (): ModelMenuController => ({
  applyPreset: vi.fn(),
  current: { effort: '', fast: false, model: 'gpt-6-sol', provider: 'custom:athena-gateway' },
  presetFor: () => ({}),
  select: vi.fn(),
  setOptions: vi.fn()
})

function renderMenu() {
  render(
    <QueryClientProvider client={queryClient}>
      <ModelMenuCloseContext.Provider value={vi.fn()}>
        <DropdownMenu open>
          <DropdownMenuContent>
            <ModelCatalogMenu controller={controller()} />
          </DropdownMenuContent>
        </DropdownMenu>
      </ModelMenuCloseContext.Provider>
    </QueryClientProvider>
  )
}

const menuRows = () => screen.getAllByRole('menuitem').map(item => item.textContent?.trim() ?? '')
const options = () => screen.getAllByRole('option').map(item => item.textContent?.trim() ?? '')

describe('every picker lists only the role models', () => {
  test('composer model menu: the two models in order, with labels and notes; no custom entry', async () => {
    renderMenu()
    await waitFor(() => expect(menuRows().join('\n')).toContain('GPT-6 Luna'))

    expect(menuRows()).toEqual([
      'Athena gateway',
      expect.stringMatching(/^GPT-6 SolMost capable/),
      expect.stringMatching(/^GPT-6 LunaFaster/),
      'Edit models…'
    ])
    expect(menuRows().join('\n')).not.toMatch(/Add custom model|Opus|custom|Mock|llama/i)
  })

  test('composer model menu: a typed id is never offered', async () => {
    renderMenu()
    await waitFor(() => expect(menuRows().join('\n')).toContain('GPT-6 Luna'))

    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: TYPED_CUSTOM_ID } })
    await waitFor(() => expect(menuRows().join('\n')).not.toContain('GPT-6 Luna'))
    expect(menuRows()).toEqual(['No models found', 'Edit models…'])
  })

  test('picker dialog: the two models in order, with labels; no custom button or typed row', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider>
          <ModelPickerDialog
            currentModel="gpt-6-sol"
            currentProvider="custom:athena-gateway"
            onOpenChange={() => undefined}
            onSelect={() => undefined}
            open
          />
        </I18nProvider>
      </QueryClientProvider>
    )
    await screen.findByText('GPT-6 Luna')

    expect(options()).toEqual([expect.stringMatching(/^GPT-6 Sol/), 'GPT-6 Luna'])
    expect(screen.queryByRole('button', { name: /custom model/i })).toBeNull()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: TYPED_CUSTOM_ID } })
    await waitFor(() => expect(screen.queryByText('GPT-6 Luna')).toBeNull())
    expect(screen.queryByText(TYPED_CUSTOM_ID)).toBeNull()
  })

  test('Edit Models: the two models in order, with labels; no typed row', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ModelVisibilityDialog onOpenChange={() => undefined} onOpenProviders={() => undefined} open />
      </QueryClientProvider>
    )
    await screen.findByText('GPT-6 Luna')
    const dialog = screen.getByRole('dialog')

    expect(within(dialog).getAllByRole('switch').map(row => row.closest('label')?.textContent?.trim())).toEqual([
      'GPT-6 Sol',
      'GPT-6 Luna'
    ])
    expect(within(dialog).queryByText(/Opus|custom|llama|Mock/i)).toBeNull()

    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: TYPED_CUSTOM_ID } })
    await waitFor(() => expect(within(dialog).queryByText('GPT-6 Luna')).toBeNull())
    expect(within(dialog).queryByText(TYPED_CUSTOM_ID)).toBeNull()
  })

  test('Settings default model: the two models in order, with labels; no "Custom model…"', async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ModelSettings />
        </QueryClientProvider>
      </MemoryRouter>
    )
    const model = await screen.findByRole('combobox', { name: 'Model' })
    await within(model).findByText('GPT-6 Sol')

    fireEvent.click(model)
    expect((await screen.findAllByRole('option')).map(option => option.textContent?.trim())).toEqual([
      'GPT-6 Sol',
      'GPT-6 Luna'
    ])
  })
})

describe('the selector under the managed list', () => {
  test('custom ids are off; hidden and allowed ids may be picked, others not, subcommands pass', () => {
    expect(allowsCustomModelIds()).toBe(false)
    expect(isModelSelectable({ model: 'gpt-6-sol', provider: 'custom:athena-gateway' })).toBe(true)
    expect(isModelSelectable({ model: 'mock' })).toBe(true)
    expect(isModelSelectable({ model: 'gpt-4.1' })).toBe(false)
    expect(isModelSelectable({ model: 'gpt-6-sol', provider: 'openrouter' })).toBe(false)
    expect(isModelSelectable({ model: 'reset' })).toBe(true)
  })

  test('labels reach every display name', () => {
    expect(displayModelName('gpt-6-sol')).toBe('GPT-6 Sol')
    uninstall()
    expect(displayModelName('gpt-6-sol')).toBe('GPT-6-sol')
    uninstall = installModelPolicy()
  })

  test('an admin change shows at once, and a new config version drops the cached model options', async () => {
    renderMenu()
    await waitFor(() => expect(menuRows().join('\n')).toContain('GPT-6 Luna'))
    queryClient.setQueryData(['model-options', 'other', 'global'], CATALOG)
    const removed = vi.spyOn(queryClient, 'removeQueries')
    const invalidated = vi.spyOn(queryClient, 'invalidateQueries')

    const luna6 = { ...LUNA, id: 'gpt-6-luna-mini', label: 'GPT-6 Luna Mini', note: null }
    act(() => setClientConfigSnapshot(managedSnapshot([SOL, LUNA, luna6, MOCK], { configVersion: 6 })))

    await waitFor(() => expect(menuRows().join('\n')).toContain('GPT-6 Luna Mini'))
    expect(removed).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['model-options'] }))
    expect(invalidated).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['model-options'] }))
    expect(queryClient.getQueryData(['model-options', 'other', 'global'])).toBeUndefined()
  })

  test('the same version again drops nothing', () => {
    const removed = vi.spyOn(queryClient, 'removeQueries')
    setClientConfigSnapshot({ ...managedSnapshot([SOL, LUNA, MOCK]), verifiedAt: 'later' } as ClientConfigSnapshot)

    expect(removed).not.toHaveBeenCalled()
  })
})
