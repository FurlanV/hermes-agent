// `/model <id>` goes through the shared model check (F02), which allows
// everything today; a policy that refuses the id stops it before the backend.
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  actRender,
  Harness,
  type HarnessHandle,
  RUNTIME_SESSION_ID
} from '@/app/session/hooks/use-prompt-actions/index-test-utils'
import { clearSingleFlightSessionResumeState } from '@/app/session/hooks/use-prompt-actions/single-flight-resume'
import { $connection } from '@/store/session'
import { dropSessionState } from '@/store/session-states'

import { $clientConfig, setClientConfigSnapshot } from './client-config'
import { LUNA, managedSnapshot, MOCK, SOL } from './managed-models-fixture'
import { installModelPolicy } from './model-policy'
import { setModelPolicy } from './models'

vi.mock('@/hermes', () => ({
  getLatestSessionMessages: vi.fn(async () => ({ messages: [], session_id: 'session' })),
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  getHermesConfig: vi.fn(async () => ({ display: { timestamps: false } })),
  getHermesConfigDefaults: vi.fn(async () => ({})),
  getSession: vi.fn(),
  PROMPT_SUBMIT_REQUEST_TIMEOUT_MS: 1_800_000,
  setApiRequestProfile: vi.fn(),
  transcribeAudio: vi.fn()
}))

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn()
}))

const requestGateway = () =>
  vi.fn(
    async (method: string, _params?: Record<string, unknown>) =>
      (method === 'slash.exec' ? { output: 'model: gpt-6-luna' } : {}) as never
  )

async function mount(gateway: ReturnType<typeof requestGateway>): Promise<HarnessHandle> {
  let handle: HarnessHandle | null = null
  await actRender(
    <Harness onReady={h => (handle = h)} refreshSessions={async () => undefined} requestGateway={gateway} />
  )

  return handle!
}

const execCalls = (gateway: ReturnType<typeof requestGateway>) =>
  gateway.mock.calls.filter(([method]) => method === 'slash.exec')

const renderedText = (handle: HarnessHandle) =>
  handle
    .state()
    .messages.flatMap(message => message.parts.map(part => ('text' in part ? String(part.text) : '')))
    .join('\n')

beforeEach(() => {
  clearSingleFlightSessionResumeState()
  $connection.set({ mode: 'local', wsUrl: 'ws://localhost/api/ws?native_dial=unminted' } as never)
})

afterEach(() => {
  cleanup()
  setModelPolicy(null)
  $connection.set(null)
  dropSessionState(RUNTIME_SESSION_ID)
  vi.restoreAllMocks()
})

describe('/model <id>', () => {
  test('asks the shared check, which allows it today, then runs on the backend as before', async () => {
    const selectable = vi.fn(() => true)
    setModelPolicy({ customIds: true, selectable })
    const gateway = requestGateway()
    const handle = await mount(gateway)

    await handle.submitText('/model gpt-6-luna --provider custom:athena-gateway')

    expect(selectable).toHaveBeenCalledWith({ model: 'gpt-6-luna', provider: 'custom:athena-gateway' })
    expect(execCalls(gateway)).toHaveLength(1)
  })

  test('an id the check refuses never reaches the backend', async () => {
    setModelPolicy({ customIds: true, selectable: ({ model }) => model !== 'gpt-6-sol' })
    const gateway = requestGateway()
    const handle = await mount(gateway)

    await handle.submitText('/model gpt-6-sol')

    expect(execCalls(gateway)).toEqual([])
    expect(renderedText(handle)).toContain('gpt-6-sol: Not available for your role.')
  })

  test('under the role list (slice 20): an id outside it gets the role message; listed ids and `reset` run', async () => {
    const uninstall = installModelPolicy()
    setClientConfigSnapshot(managedSnapshot([SOL, LUNA, MOCK]))

    try {
      const gateway = requestGateway()
      const handle = await mount(gateway)

      await handle.submitText('/model gpt-4.1')
      expect(execCalls(gateway)).toEqual([])
      expect(renderedText(handle)).toContain('gpt-4.1: Not available for your role.')

      await handle.submitText('/model gpt-6-sol --provider openrouter')
      expect(execCalls(gateway)).toEqual([])

      await handle.submitText('/model gpt-6-luna')
      await handle.submitText('/model reset')
      expect(execCalls(gateway).map(([, params]) => params?.command)).toEqual([
        'model gpt-6-luna',
        'model reset'
      ])
    } finally {
      uninstall()
      $clientConfig.set(null)
    }
  })
})
