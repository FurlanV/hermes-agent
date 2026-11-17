import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  assistantMessage,
  stubThreadEnvironment,
  stubThreadViewportSize,
  userMessage
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'

import type { ClientConfigSnapshot } from '../managed/client-config'
import { $clientConfig } from '../managed/client-config'
import { installFeaturePolicy } from '../managed/feature-policy'

import { AthenaAssistantMessage } from './athena-assistant-message'
import { AthenaUserMessage } from './athena-user-message'
import type * as layout from './layout'
import { ATHENA_CHAT_ATTR, athenaMessageComponents, athenaMessageType, useAthenaChatLayout } from './layout'

// Count the map the thread builds: the choke point calls this once per new map, so a call is a new identity.
vi.mock('./layout', async importOriginal => {
  const actual = await importOriginal<typeof layout>()

  return { ...actual, athenaMessageComponents: vi.fn(actual.athenaMessageComponents) }
})

stubThreadEnvironment()
stubThreadViewportSize()

const MESSAGES: ThreadMessage[] = [userMessage('user-1', 'hello from the user'), assistantMessage()]

const snapshot = (variant: 'athena' | 'stock', features: Record<string, string> = {}): ClientConfigSnapshot => ({
  config: { features },
  configVersion: 1,
  devOverridesActive: false,
  error: null,
  role: 'researcher',
  source: 'server',
  variant,
  verifiedAt: '2026-11-17T00:00:00Z'
})

type Bridge = { athenaDesktop?: unknown }

/** The preload's snapshot (read once for the variant) and the live client config (read for the row). */
function build(variant: 'athena' | 'stock' | null, features: Record<string, string> = {}) {
  if (variant) {
    ;(window as Bridge).athenaDesktop = { clientConfig: { snapshot: snapshot(variant, features) } }
  }

  $clientConfig.set(variant ? snapshot(variant, features) : null)
}

const pushConfig = (features: Record<string, string>) => act(() => $clientConfig.set(snapshot('athena', features)))

let uninstall: () => void

beforeEach(() => {
  uninstall = installFeaturePolicy()
  vi.mocked(athenaMessageComponents).mockClear()
})

afterEach(() => {
  cleanup()
  uninstall()
  $clientConfig.set(null)
  delete (window as Bridge).athenaDesktop
})

function Harness({ onCancel }: { onCancel: () => void }) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: MESSAGES,
    isRunning: false,
    onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread onCancel={onCancel} />
    </AssistantRuntimeProvider>
  )
}

const threadRoot = (container: HTMLElement) => container.querySelector('[data-slot="thread"]')

describe('the Athena chat layout switch', () => {
  test('is on for the Athena variant with row F15 on (the default)', () => {
    build('athena')

    expect(renderHook(() => useAthenaChatLayout()).result.current).toBe(true)
  })

  test('is off in a stock build: no snapshot, or a stock snapshot', () => {
    build(null)
    expect(renderHook(() => useAthenaChatLayout()).result.current).toBe(false)

    build('stock')
    expect(renderHook(() => useAthenaChatLayout()).result.current).toBe(false)
  })

  test('is off with row F15 off, and follows a new client config without a rebuild', () => {
    build('athena', { F15: 'off' })
    const { result } = renderHook(() => useAthenaChatLayout())

    expect(result.current).toBe(false)
    pushConfig({})
    expect(result.current).toBe(true)
    pushConfig({ F15: 'off' })
    expect(result.current).toBe(false)
  })
})

describe('the thread at the choke point', () => {
  test.each([
    ['the Athena variant, row on', 'athena', {}, true],
    ['the Athena variant, row off', 'athena', { F15: 'off' }, false],
    ['a stock build', null, {}, false]
  ] as const)('%s: the marker on the thread root follows the switch', async (_name, variant, features, marked) => {
    build(variant, features)
    const { container } = render(<Harness onCancel={() => {}} />)

    await waitFor(() => expect(screen.getByText('hello from the user')).toBeTruthy())
    expect(threadRoot(container)?.hasAttribute(ATHENA_CHAT_ATTR)).toBe(marked)
    // The user message follows the switch (slice 04); the assistant message is still upstream's on both sides.
    expect(container.querySelector('[data-slot="athena_user-message"]') !== null).toBe(marked)
    expect(screen.getByText('done')).toBeTruthy()
  })

  test('the marker comes and goes with the row, live', async () => {
    build('athena')
    const { container } = render(<Harness onCancel={() => {}} />)

    await waitFor(() => expect(screen.getByText('hello from the user')).toBeTruthy())
    expect(threadRoot(container)?.hasAttribute(ATHENA_CHAT_ATTR)).toBe(true)
    pushConfig({ F15: 'off' })
    expect(threadRoot(container)?.hasAttribute(ATHENA_CHAT_ATTR)).toBe(false)
    pushConfig({})
    expect(threadRoot(container)?.hasAttribute(ATHENA_CHAT_ATTR)).toBe(true)
  })

  test.each([
    ['on', {}],
    ['off', { F15: 'off' }]
  ] as const)(
    'switch %s: the component map keeps its identity across unrelated re-renders',
    async (_name, features) => {
      build('athena', features)
      const { rerender } = render(<Harness onCancel={() => {}} />)

      await waitFor(() => expect(screen.getByText('hello from the user')).toBeTruthy())
      const user = screen.getByText('hello from the user')
      const assistant = screen.getByText('done')
      const calls = vi.mocked(athenaMessageComponents).mock.calls.length
      const map = vi.mocked(athenaMessageComponents).mock.results.at(-1)?.value

      // New callback identities and a config push that leaves the row as it was: neither is the layout flipping.
      await act(async () => rerender(<Harness onCancel={() => {}} />))
      pushConfig({ ...features, S82: 'on' })
      await act(async () => rerender(<Harness onCancel={() => {}} />))

      expect(vi.mocked(athenaMessageComponents).mock.calls.length).toBe(calls)
      expect(vi.mocked(athenaMessageComponents).mock.results.at(-1)?.value).toBe(map)
      expect(screen.getByText('hello from the user')).toBe(user)
      expect(screen.getByText('done')).toBe(assistant)
    }
  )
})

describe('athenaMessageType', () => {
  test("picks Athena's user message while active and the given upstream type otherwise", () => {
    const upstream = () => null

    expect(athenaMessageType(true, 'UserMessage', upstream)).toBe(AthenaUserMessage)
    expect(athenaMessageType(false, 'UserMessage', upstream)).toBe(upstream)
  })

  test("picks Athena's agent message while active and the given upstream type otherwise", () => {
    const upstream = () => null

    expect(athenaMessageType(true, 'AssistantMessage', upstream)).toBe(AthenaAssistantMessage)
    expect(athenaMessageType(false, 'AssistantMessage', upstream)).toBe(upstream)
  })
})

describe('athenaMessageComponents', () => {
  test('returns the upstream map itself on both sides (for now)', () => {
    const upstream = { UserMessage: () => null }

    expect(athenaMessageComponents(true, upstream)).toBe(upstream)
    expect(athenaMessageComponents(false, upstream)).toBe(upstream)
  })
})
