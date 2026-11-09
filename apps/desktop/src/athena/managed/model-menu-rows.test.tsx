// The composer model menu's rows, remembered and typed custom ids included.
// Recorded before the menu read the shared model-options selector, so it pins
// "no visible change".
vi.mock('@/store/profile', async (): Promise<object> => {
  const { atom } = await import('nanostores')

  return { $activeGatewayProfile: atom<string>('default') }
})
vi.mock('@/store/session', async (): Promise<object> => {
  const { atom } = await import('nanostores')

  return { $connection: atom(null), $defaultReasoningEffort: atom<string>('') }
})

import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { ModelCatalogMenu, ModelMenuCloseContext, type ModelMenuController } from '@/app/shell/model-catalog-menu'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { queryClient } from '@/lib/query-client'
import { $customModels } from '@/store/custom-models'
import { $favoriteModels } from '@/store/favorite-models'
import { $localModelsEnabled } from '@/store/local-models-flag'
import { localModelsKey, localModelsOwner } from '@/store/local-runtime-jobs'
import { $visibleModels, setModelVisibilityOpen } from '@/store/model-visibility'

import { MODEL_CATALOG, REMEMBERED_CUSTOM_MODELS, TYPED_CUSTOM_ID } from './model-rows-fixture'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: vi.fn(async () => MODEL_CATALOG),
  getLocalModelsJobs: vi.fn(async () => ({ jobs: [] })),
  getLocalModelsStatus: vi.fn().mockResolvedValue({ loading: {} }),
  setApiRequestProfile: vi.fn()
}))

beforeEach(() => {
  queryClient.clear()
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } })
  window.localStorage.clear()
  $visibleModels.set(null)
  $favoriteModels.set([])
  $customModels.set(REMEMBERED_CUSTOM_MODELS)
  queryClient.setQueryData(localModelsKey(localModelsOwner(), 'jobs'), [])
  $localModelsEnabled.set(false)
  setModelVisibilityOpen(false)
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  $customModels.set([])
})

function renderMenu() {
  const controller: ModelMenuController = {
    applyPreset: vi.fn(),
    current: { effort: '', fast: false, model: 'gpt-6-sol', provider: 'custom:athena-gateway' },
    presetFor: () => ({}),
    select: vi.fn(),
    setOptions: vi.fn()
  }

  render(
    <QueryClientProvider client={queryClient}>
      <ModelMenuCloseContext.Provider value={vi.fn()}>
        <DropdownMenu open>
          <DropdownMenuContent>
            <ModelCatalogMenu controller={controller} />
          </DropdownMenuContent>
        </DropdownMenu>
      </ModelMenuCloseContext.Provider>
    </QueryClientProvider>
  )
}

// The catalog has painted: a model row from the second provider is listed.
const waitForCatalog = () => waitFor(() => expect(menuRows().join('\n')).toMatch(/opus/i))

const menuRows = () => screen.getAllByRole('menuitem').map(item => item.textContent?.trim() ?? '')

describe('composer model menu rows', () => {
  test('catalog and remembered custom ids are unchanged', async () => {
    renderMenu()
    await waitForCatalog()

    expect(menuRows()).toMatchSnapshot()
  })

  test('searching every provider and a typed custom id are unchanged', async () => {
    renderMenu()
    await waitForCatalog()
    const input = screen.getByRole('textbox', { name: 'Search models' })

    fireEvent.change(input, { target: { value: 'custom' } })
    await waitFor(() => expect(menuRows().join('\n')).toMatch(/custom/i))
    expect(menuRows()).toMatchSnapshot()

    fireEvent.change(input, { target: { value: TYPED_CUSTOM_ID } })
    await waitFor(() => expect(menuRows().join('\n')).toContain(TYPED_CUSTOM_ID))
    expect(menuRows()).toMatchSnapshot()
  })
})
