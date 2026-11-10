// The Settings default-model select's rows, remembered custom ids included.
// Recorded before Settings read the shared model-options selector.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type * as ConfigApi from '@/api/config'
import { ModelSettings } from '@/app/settings/model-settings'
import { $customModels } from '@/store/custom-models'
import { clearNotifications } from '@/store/notifications'

import { MODEL_CATALOG, REMEMBERED_CUSTOM_MODELS } from './model-rows-fixture'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

vi.mock('@/hermes', async () => ({
  ...(await vi.importActual<typeof ConfigApi>('@/api/config')),
  getApiRequestProfile: () => 'default',
  getAuxiliaryModels: vi.fn(async () => ({
    main: { model: 'gpt-6-sol', provider: 'custom:athena-gateway' },
    tasks: []
  })),
  getGlobalModelInfo: vi.fn(async () => ({ model: 'gpt-6-sol', provider: 'custom:athena-gateway' })),
  getGlobalModelOptions: vi.fn(async () => MODEL_CATALOG),
  getHermesConfigRecord: vi.fn(async () => ({ agent: { reasoning_effort: 'medium' } })),
  getMoaModels: vi.fn(async () => null),
  getRecommendedDefaultModel: vi.fn(async () => null),
  profileScopeKey: (scope?: null | string) => (scope ?? '').trim() || 'default',
  saveHermesConfig: vi.fn(async () => ({ ok: true })),
  setApiRequestProfile: () => {}
}))

vi.mock('@/app/hooks/use-on-profile-switch', () => ({ useOnProfileSwitch: () => {} }))

beforeEach(() => {
  $customModels.set(REMEMBERED_CUSTOM_MODELS)
})

afterEach(() => {
  cleanup()
  clearNotifications()
  $customModels.set([])
})

function renderModelSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ModelSettings />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('Settings default-model select rows', () => {
  test('provider rows and model rows (custom ids included) are unchanged', async () => {
    renderModelSettings()
    const model = await screen.findByRole('combobox', { name: 'Model' })
    await within(model).findByText('gpt-6-sol')

    fireEvent.click(model)
    const modelRows = (await screen.findAllByRole('option')).map(option => option.textContent?.trim() ?? '')
    expect(modelRows).toMatchSnapshot()
  })
})
