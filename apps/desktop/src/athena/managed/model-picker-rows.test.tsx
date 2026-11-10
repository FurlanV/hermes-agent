// The model picker dialog's rows, remembered and typed custom ids included.
// Recorded before the dialog read the shared model-options selector.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ModelPickerDialog } from '@/components/model-picker'
import { I18nProvider } from '@/i18n'
import { requestModelOptions } from '@/lib/model-options'
import { $customModels } from '@/store/custom-models'
import { $localModelsEnabled } from '@/store/local-models-flag'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { MODEL_CATALOG, REMEMBERED_CUSTOM_MODELS, TYPED_CUSTOM_ID } from './model-rows-fixture'

vi.mock('@/hermes', () => ({
  getLocalModelsJobs: vi.fn(async () => ({ jobs: [] })),
  getLocalModelsStatus: vi.fn().mockResolvedValue({ loading: {} })
}))
vi.mock('@/lib/model-options', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestModelOptions: vi.fn()
}))

stubResizeObserver()
stubMenuDomApis()

beforeEach(() => {
  vi.mocked(requestModelOptions).mockResolvedValue(MODEL_CATALOG)
  $customModels.set(REMEMBERED_CUSTOM_MODELS)
  $localModelsEnabled.set(false)
})

afterEach(() => {
  cleanup()
  $customModels.set([])
  vi.clearAllMocks()
})

function renderPicker() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
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
}

const pickerRows = () => screen.getAllByRole('option').map(item => item.textContent?.trim() ?? '')

describe('model picker dialog rows', () => {
  test('catalog and remembered custom ids are unchanged', async () => {
    renderPicker()
    await screen.findByText('gpt-6-luna')

    expect(pickerRows()).toMatchSnapshot()
  })

  test('a typed custom id is offered as before', async () => {
    renderPicker()
    await screen.findByText('gpt-6-luna')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: TYPED_CUSTOM_ID } })
    await waitFor(() => expect(pickerRows().join('\n')).toContain(TYPED_CUSTOM_ID))
    expect(pickerRows()).toMatchSnapshot()
  })
})
