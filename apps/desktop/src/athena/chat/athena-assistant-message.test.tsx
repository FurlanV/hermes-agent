import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createdAt,
  stubThreadEnvironment,
  stubThreadViewportSize,
  ThreadRuntime,
  userMessage
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { formatElapsed } from '@/components/chat/activity-timer'
import { en } from '@/i18n/en'
import { $displayTimestamps } from '@/store/display-timestamps'
import type * as ReactionsStore from '@/store/reactions'
import { $reactionsEnabled } from '@/store/reactions-enabled'
import { $localReactions } from '@/store/reactions-local'

import type { ClientConfigSnapshot } from '../managed/client-config'
import { $clientConfig } from '../managed/client-config'
import { installFeaturePolicy } from '../managed/feature-policy'

import { ATHENA_CHAT_ATTR } from './layout'

// The tapback persists through the gateway; these cases are about what the user sees on the click.
vi.mock('@/store/reactions', async importOriginal => ({
  ...(await importOriginal<typeof ReactionsStore>()),
  toggleMessageReaction: vi.fn(async () => {})
}))

stubThreadViewportSize()

const copy = en.assistant.thread
const ATHENA_AGENT = '[data-slot="athena_assistant-message"]'
const AGENT_LABEL = '[data-slot="athena_assistant-label"]'
const AGENT_ROOT = '[data-slot="aui_assistant-message-root"]'

// jsdom applies a stylesheet's declarations (unresolved) but vitest loads no CSS: inject the Athena one.
beforeAll(() => {
  const sheet = window.document.createElement('style')

  sheet.textContent = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'chat.css'), 'utf8')
  window.document.head.append(sheet)
})

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

/** The preload's snapshot (the variant) and the live client config (the row); `null` is a stock build. */
function build(variant: 'athena' | 'stock' | null, features: Record<string, string> = {}) {
  if (variant) {
    ;(window as Bridge).athenaDesktop = { clientConfig: { snapshot: snapshot(variant, features) } }
  }

  $clientConfig.set(variant ? snapshot(variant, features) : null)
}

let uninstall: () => void

beforeEach(() => {
  // Per case: the Copy case stubs the clipboard, and unstubbing it after drops these stubs too.
  stubThreadEnvironment()
  uninstall = installFeaturePolicy()
  $localReactions.set({})
  $reactionsEnabled.set(false)
})

afterEach(() => {
  cleanup()
  uninstall()
  $clientConfig.set(null)
  $displayTimestamps.set(false)
  $reactionsEnabled.set(false)
  delete (window as Bridge).athenaDesktop
  vi.unstubAllGlobals()
})

type Part = ThreadMessage['content'][number]

function agent(
  id: string,
  content: string | Part[],
  { custom = {}, running = false }: { custom?: Record<string, unknown>; running?: boolean } = {}
): ThreadMessage {
  return {
    id,
    role: 'assistant',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom }
  } as ThreadMessage
}

const toolCall = (id: string): Part =>
  ({ type: 'tool-call', toolCallId: id, toolName: 'read_file', args: {}, argsText: '{}', result: 'ok' }) as Part

type ThreadCallbacks = Pick<Parameters<typeof Thread>[0], 'onBranchInNewChat'>

function renderThread(messages: ThreadMessage[], callbacks: ThreadCallbacks = {}) {
  return render(
    <ThreadRuntime messages={messages}>
      <Thread {...callbacks} />
    </ThreadRuntime>
  )
}

const athenaAgents = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(ATHENA_AGENT)]

const labelled = (container: HTMLElement) =>
  athenaAgents(container).map(message => Boolean(message.querySelector(`:scope > ${AGENT_LABEL}`)))

/** The Athena agent message holding `text`. */
async function agentWith(text: string) {
  const message = (await screen.findByText(text)).closest<HTMLElement>(ATHENA_AGENT)

  expect(message).toBeTruthy()

  return message!
}

describe('the Athena agent message (layout on)', () => {
  beforeEach(() => build('athena'))

  test('is a full-width block on the page background, labelled "Athena" with the mark above', async () => {
    const { container } = renderThread([userMessage('user-1', 'hi'), agent('assistant-1', 'hello back')])

    const message = await agentWith('hello back')
    const label = message.querySelector<HTMLElement>(AGENT_LABEL)!
    const mark = label.querySelector<HTMLImageElement>('img')!
    const root = message.querySelector<HTMLElement>(AGENT_ROOT)!

    expect(label.textContent).toBe('Athena')
    // The mark is decorative next to the name: hidden from assistive tech, 14px tall.
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(mark.getAttribute('alt')).toBe('')
    expect(mark.classList.contains('h-3.5')).toBe(true)
    expect(getComputedStyle(label).color).toBe('var(--chat-agent-label)')
    expect(
      container.querySelector<HTMLElement>(`[${ATHENA_CHAT_ATTR}]`)!.style.getPropertyValue('--chat-agent-label')
    ).toMatch(/^#[0-9a-f]{6}$/)

    // The label comes first, then upstream's message root holding the text.
    expect(message.firstElementChild).toBe(label)
    expect(message.lastElementChild).toBe(root)
    expect(root.contains(screen.getByText('hello back'))).toBe(true)

    // Full width, left-aligned, no bubble surface.
    expect(getComputedStyle(message).getPropertyValue('inline-size')).toBe('100%')
    expect(getComputedStyle(message).alignSelf).toBe('stretch')
    expect(getComputedStyle(message).getPropertyValue('background')).toBe('transparent')
    expect(message.querySelector('.composer-human-message, [data-slot="athena_user-bubble"]')).toBeNull()
  })

  test('keeps the upstream slots the transcript, timeline and messages-below tracker key on', async () => {
    const { container } = renderThread([userMessage('user-1', 'hi'), agent('assistant-1', 'kept slots')])

    const root = (await agentWith('kept slots')).querySelector<HTMLElement>(AGENT_ROOT)!

    expect(root.dataset.role).toBe('assistant')
    expect(root.querySelector('[data-slot="aui_assistant-message-content"]')).toBeTruthy()
    expect(root.querySelector('[data-slot="aui_message-streaming-marker"]')).toBeTruthy()
    expect(root.closest('[data-slot="aui_response-group"]')).toBeTruthy()
    expect(root.closest('[data-slot="aui_turn-pair"]')).toBeTruthy()
    expect(container.querySelectorAll(AGENT_ROOT)).toHaveLength(1)
  })

  test('shows the label once per response group, on its first block', async () => {
    const { container } = renderThread([
      userMessage('user-1', 'first prompt'),
      agent('assistant-1', [toolCall('call-1')]),
      agent('assistant-2', 'first reply'),
      // A background delivery continues the same response group (response-group.tsx).
      userMessage('user-bg', '[IMPORTANT: Background process proc_1 completed normally (exit code 0).]'),
      agent('assistant-3', 'after the background result'),
      userMessage('user-2', 'second prompt'),
      agent('assistant-4', 'second reply')
    ])

    await screen.findByText('second reply')
    // The tool-only bubble leads the first group (it carries no text, so ResponseMessageIds alone would miss it).
    expect(labelled(container)).toEqual([true, false, false, true])
    expect(container.querySelectorAll(AGENT_LABEL)).toHaveLength(2)
  })

  test('labels a run of agent messages with no prompt before it once', async () => {
    const { container } = renderThread([agent('assistant-1', 'opening'), agent('assistant-2', 'follow-up')])

    await screen.findByText('follow-up')
    expect(labelled(container)).toEqual([true, false])
  })

  test('a stream flush or settle neither remounts the message nor its label', async () => {
    const prompt = userMessage('user-1', 'go')
    const { rerender } = renderThread([prompt, agent('assistant-1', 'partial', { running: true })])

    const message = await agentWith('partial')
    const root = message.querySelector(AGENT_ROOT)
    const label = message.querySelector(AGENT_LABEL)

    rerender(
      <ThreadRuntime messages={[prompt, agent('assistant-1', 'partial and more')]}>
        <Thread />
      </ThreadRuntime>
    )

    await screen.findByText('partial and more')
    expect(message.isConnected).toBe(true)
    expect(message.querySelector(AGENT_ROOT)).toBe(root)
    expect(message.querySelector(AGENT_LABEL)).toBe(label)
  })

  test('Copy copies the reply through upstream footer', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }

    vi.stubGlobal('navigator', { ...navigator, clipboard })
    renderThread([userMessage('user-1', 'hi'), agent('assistant-1', 'copy this reply')])

    const message = await agentWith('copy this reply')
    const actions = message.querySelector<HTMLElement>('[data-slot="aui_msg-actions"]')!

    fireEvent.click(within(actions).getAllByRole('button', { name: /^copy$/i })[0]!)
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith('copy this reply'))
  })

  test('offers Read aloud and Branch in new chat; Branch calls the thread callback with the message id', async () => {
    const onBranchInNewChat = vi.fn()

    renderThread([userMessage('user-1', 'hi'), agent('assistant-1', 'branch me')], { onBranchInNewChat })

    const message = await agentWith('branch me')

    expect(within(message).getByRole('button', { name: copy.readAloud })).toBeTruthy()
    fireEvent.click(within(message).getByRole('button', { name: copy.branchNewChat }))
    expect(onBranchInNewChat).toHaveBeenCalledWith('assistant-1')
  })

  test('without the branch callback there is no Branch button', async () => {
    renderThread([userMessage('user-1', 'hi'), agent('assistant-1', 'no branch')])

    const message = await agentWith('no branch')

    expect(within(message).queryByRole('button', { name: copy.branchNewChat })).toBeNull()
  })

  test('double-click hearts the reply, a second retracts it; the reaction slot opens the picker', async () => {
    $reactionsEnabled.set(true)
    renderThread([userMessage('user-1', 'hi'), agent('assistant-1', 'heart me')])

    const message = await agentWith('heart me')
    const root = message.querySelector<HTMLElement>(AGENT_ROOT)!

    fireEvent.doubleClick(root, { detail: 2 })
    await waitFor(() => expect($localReactions.get()['assistant-1']?.[0]?.emoji).toBe('❤️'))
    fireEvent.doubleClick(root, { detail: 2 })
    await waitFor(() => expect($localReactions.get()['assistant-1']).toEqual([]))

    fireEvent.click(message.querySelector<HTMLElement>('[data-slot="aui_msg-reactions"]')!)
    fireEvent.click(await screen.findByRole('button', { name: '👍' }))
    await waitFor(() => expect($localReactions.get()['assistant-1']?.[0]?.emoji).toBe('👍'))
  })

  test('double-click does nothing while reactions are off', async () => {
    renderThread([userMessage('user-1', 'hi'), agent('assistant-1', 'leave me')])

    fireEvent.doubleClick((await agentWith('leave me')).querySelector(AGENT_ROOT)!, { detail: 2 })
    expect($localReactions.get()['assistant-1']).toBeUndefined()
  })

  test('shows the turn duration and the timeline timestamp', async () => {
    $displayTimestamps.set(true)
    const at = createdAt.getTime() / 1000

    renderThread([
      userMessage('user-1', 'hi'),
      agent('assistant-1', 'timed reply', {
        custom: { durationS: 75, timelineCompletedAt: at + 2, timelineTimestamp: at }
      })
    ])

    const message = await agentWith('timed reply')
    const duration = message.querySelector<HTMLElement>('[data-slot="aui_turn-duration"]')!
    const stamp = message.querySelector<HTMLElement>('[data-slot="timeline-timestamp"]')!

    expect(duration.textContent).toContain(formatElapsed(75))
    expect(duration.title).toBe(copy.turnDuration(formatElapsed(75)))
    expect(stamp.querySelectorAll('time')).toHaveLength(2)
    expect(stamp.querySelector('time')!.getAttribute('dateTime')).toBe(createdAt.toISOString())
  })

  test('spaces turns 24px apart and the blocks of one turn 8px', async () => {
    const { container } = renderThread([
      userMessage('user-1', 'one'),
      agent('assistant-1', 'reply one'),
      agent('assistant-2', 'reply one more'),
      userMessage('user-2', 'two'),
      agent('assistant-3', 'reply two')
    ])

    await screen.findByText('reply two')
    const root = container.querySelector<HTMLElement>(`[${ATHENA_CHAT_ATTR}]`)!
    const rows = [...container.querySelectorAll<HTMLElement>('[data-slot="aui_message-group"]')]
    const group = container.querySelector<HTMLElement>('[data-slot="aui_response-group"]')!

    expect(getComputedStyle(root).getPropertyValue('--conversation-turn-gap')).toBe('0.5rem')
    expect(getComputedStyle(root).getPropertyValue('--athena-turn-spacing')).toBe('1.5rem')
    expect(rows).toHaveLength(2)

    for (const row of rows) {
      expect(getComputedStyle(row).getPropertyValue('padding-block-end')).toBe('var(--athena-turn-spacing)')
    }

    expect(getComputedStyle(group).rowGap).toBe('var(--conversation-turn-gap)')
  })

  test('the HUD keeps its own compact rhythm', async () => {
    const { container } = render(
      <div data-hud-shell="">
        <ThreadRuntime messages={[userMessage('user-1', 'hud'), agent('assistant-1', 'hud reply')]}>
          <Thread />
        </ThreadRuntime>
      </div>
    )

    await agentWith('hud reply')
    const root = container.querySelector<HTMLElement>(`[${ATHENA_CHAT_ATTR}]`)!

    expect(getComputedStyle(root).getPropertyValue('--conversation-turn-gap')).toBe('')
    expect(
      getComputedStyle(container.querySelector('[data-slot="aui_message-group"]')!).getPropertyValue(
        'padding-block-end'
      )
    ).not.toBe('var(--athena-turn-spacing)')
  })
})

describe('the agent message with the Athena layout off', () => {
  test.each([
    ['row F15 off', () => build('athena', { F15: 'off' })],
    ['a stock build (no snapshot)', () => build(null)],
    ['a stock snapshot', () => build('stock')]
  ])('%s: upstream AssistantMessage renders, unlabelled and with upstream spacing', async (_name, setUp) => {
    setUp()
    const onBranchInNewChat = vi.fn()

    const { container } = renderThread([userMessage('user-1', 'hi'), agent('assistant-1', 'plain upstream reply')], {
      onBranchInNewChat
    })

    const root = (await screen.findByText('plain upstream reply')).closest<HTMLElement>(AGENT_ROOT)!

    expect(container.querySelector(ATHENA_AGENT)).toBeNull()
    expect(container.querySelector(AGENT_LABEL)).toBeNull()
    expect(container.querySelector(`[${ATHENA_CHAT_ATTR}]`)).toBeNull()
    expect(root.parentElement?.dataset.slot).toBe('aui_response-group')
    expect(
      getComputedStyle(container.querySelector('[data-slot="aui_message-group"]')!).getPropertyValue(
        'padding-block-end'
      )
    ).not.toBe('var(--athena-turn-spacing)')

    fireEvent.click(within(root).getByRole('button', { name: copy.branchNewChat }))
    expect(onBranchInNewChat).toHaveBeenCalledWith('assistant-1')
  })

  test('a live config change swaps the agent message both ways', async () => {
    build('athena')
    const { container } = renderThread([userMessage('user-1', 'hi'), agent('assistant-1', 'flip me')])

    await agentWith('flip me')

    act(() => $clientConfig.set(snapshot('athena', { F15: 'off' })))
    expect(container.querySelector(ATHENA_AGENT)).toBeNull()
    expect(screen.getByText('flip me').closest(AGENT_ROOT)).toBeTruthy()

    act(() => $clientConfig.set(snapshot('athena')))
    expect(container.querySelector(ATHENA_AGENT)).toBeTruthy()
    expect(container.querySelector(AGENT_LABEL)?.textContent).toBe('Athena')
  })
})
