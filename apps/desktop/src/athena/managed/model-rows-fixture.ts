// One model catalog for the picker snapshot tests: a gateway row, a second
// provider, and custom ids the user remembered or is typing.
import type { ModelOptionsResult } from '@hermes/shared'

import type { CustomModel } from '@/store/custom-models'

export const MODEL_CATALOG: ModelOptionsResult = {
  model: 'gpt-6-sol',
  provider: 'custom:athena-gateway',
  providers: [
    {
      authenticated: true,
      is_current: true,
      models: ['gpt-6-sol', 'gpt-6-luna'],
      name: 'Athena gateway',
      slug: 'custom:athena-gateway'
    },
    {
      authenticated: true,
      models: ['claude-opus-4.8', 'claude-sonnet-4.8'],
      name: 'Anthropic',
      slug: 'anthropic'
    }
  ]
}

export const REMEMBERED_CUSTOM_MODELS: CustomModel[] = [
  { model: 'gpt-6-custom-preview', provider: 'custom:athena-gateway' },
  { model: 'claude-custom-lab', provider: 'anthropic' }
]

export const TYPED_CUSTOM_ID = 'lab/typed-model-x'
