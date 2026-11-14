// Client config snapshots for the managed-model tests (F02 slices 20, 21 and 23): the demo seed's entries
// (deploy/compose/dev/client-config.roles.yaml), layered on the bundled default.
import { BUNDLED_DEFAULT_CONFIG } from '../../../electron/athena/bundled-config-data'

import type { ClientConfigSnapshot } from './client-config'

export interface ModelEntryFixture {
  hidden?: boolean
  id: string
  label: string
  note?: null | string
  /** `gateway` when absent; `bridge` for a local model (F05). */
  provider?: string
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

/** The friends seed's local model: a bridge model, known to the model server (and so to hermes) as `QWEN_NAME`. */
export const QWEN: ModelEntryFixture = {
  id: 'qwen-3.8-27B-GGUF',
  label: 'Qwen 3.8 27B (local)',
  note: 'On the HPC',
  provider: 'bridge',
  reasoning: { default: 'low', levels: ['none', 'low', 'medium', 'high', 'xhigh'] }
}

export const QWEN_NAME = 'DevQuasar/Qwen.Qwen3.8-27B-GGUF'
export const BRIDGE_PROVIDER = 'custom:athena-vllm'

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

export function managedSnapshot(
  allowed: ModelEntryFixture[],
  options: {
    configVersion?: number
    /** The HPC bridge is up (main found a live bridge record). Default: down. */
    bridge?: boolean
    default?: string
    /** Feature row F05 (default: its build default, off). */
    localModelsFeature?: 'off' | 'on'
    /** The config's `local_models.enabled`; the section is left out when undefined. */
    localModelsSwitch?: boolean
    mode?: 'enforce' | 'off' | 'report'
    reasoningControl?: 'off' | 'on'
  } = {}
): ClientConfigSnapshot {
  return {
    config: {
      ...bundled,
      ...(options.localModelsFeature
        ? { features: { ...(bundled.features as object), F05: options.localModelsFeature } }
        : {}),
      ...(options.localModelsSwitch === undefined
        ? {}
        : {
            local_models: {
              enabled: options.localModelsSwitch,
              login_host: 'login.test',
              models: { [QWEN.id]: { name: QWEN_NAME } },
              target_host: 'node.test',
              target_port: 9931
            }
          }),
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
    ...(options.bridge ? { hpcBridge: { address: '127.0.0.1', connectedAt: null, port: 49731 } } : {}),
    role: 'researcher',
    source: 'server',
    verifiedAt: null
  }
}
