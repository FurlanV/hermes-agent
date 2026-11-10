// Client config snapshots for the managed-model tests (F02 slices 20, 21 and 23): the demo seed's entries
// (deploy/compose/dev/client-config.roles.yaml), layered on the bundled default.
import { BUNDLED_DEFAULT_CONFIG } from '../../../electron/athena/bundled-config-data'

import type { ClientConfigSnapshot } from './client-config'

export interface ModelEntryFixture {
  hidden?: boolean
  id: string
  label: string
  note?: null | string
  reasoning?: { default: string; levels: string[] }
}

export const SOL: ModelEntryFixture = {
  id: 'gpt-6-sol',
  label: 'GPT-6 Sol',
  note: 'Most capable',
  reasoning: { default: 'medium', levels: ['none', 'low', 'medium', 'high'] }
}

export const LUNA: ModelEntryFixture = {
  id: 'gpt-6-luna',
  label: 'GPT-6 Luna',
  note: 'Faster',
  reasoning: { default: 'low', levels: ['none', 'low', 'medium'] }
}

export const MOCK: ModelEntryFixture = { hidden: true, id: 'mock', label: 'Mock (dev)', note: 'The compose mock LLM' }

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

export function managedSnapshot(
  allowed: ModelEntryFixture[],
  options: {
    configVersion?: number
    default?: string
    mode?: 'enforce' | 'off' | 'report'
    reasoningControl?: 'off' | 'on'
  } = {}
): ClientConfigSnapshot {
  return {
    config: {
      ...bundled,
      managed: { ...(bundled.managed as object), models: options.mode ?? 'enforce' },
      models: {
        allowed,
        default: options.default ?? allowed.find(entry => !entry.hidden)?.id ?? allowed[0]?.id,
        max_turns_limit: 90,
        ...(options.reasoningControl ? { reasoning_control: options.reasoningControl } : {})
      }
    },
    configVersion: options.configVersion ?? 5,
    devOverridesActive: false,
    error: null,
    role: 'researcher',
    source: 'server',
    verifiedAt: null
  }
}
