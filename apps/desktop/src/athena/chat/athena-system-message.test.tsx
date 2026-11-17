import type { ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createdAt,
  stubThreadEnvironment,
  stubThreadViewportSize,
  ThreadRuntime,
  userMessage
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { en } from '@/i18n/en'

import type { ClientConfigSnapshot } from '../managed/client-config'
import { $clientConfig } from '../managed/client-config'
import { installFeaturePolicy } from '../managed/feature-policy'

import { type AthenaNoteKind, systemNoteKind } from './athena-system-message'
import { userRoleNoteKind } from './athena-user-message'
import { ATHENA_CHAT_ATTR } from './layout'

stubThreadEnvironment()
stubThreadViewportSize()

const NOTE = '[data-athena-note]'
const AGENT_LABEL = '[data-slot="athena_assistant-label"]'
const ATHENA_AGENT = '[data-slot="athena_assistant-message"]'
const USER_BUBBLE = '[data-slot="athena_user-message"], [data-slot="athena_user-bubble"], .composer-human-message'

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

type Bridge = { athenaDesktop?: unknown; hermesDesktop?: unknown }

/** The preload's snapshot (the variant) and the live client config (the row); `null` is a stock build. */
function build(variant: 'athena' | 'stock' | null, features: Record<string, string> = {}) {
  if (variant) {
    ;(window as Bridge).athenaDesktop = { clientConfig: { snapshot: snapshot(variant, features) } }
  }

  $clientConfig.set(variant ? snapshot(variant, features) : null)
}

let uninstall: () => void

beforeEach(() => {
  uninstall = installFeaturePolicy()
})

afterEach(() => {
  cleanup()
  uninstall()
  $clientConfig.set(null)
  delete (window as Bridge).athenaDesktop
})

const metadata = (custom: Record<string, unknown>) => ({
  unstable_state: null,
  unstable_annotations: [],
  unstable_data: [],
  steps: [],
  custom
})

function system(id: string, text: string, custom: Record<string, unknown> = {}): ThreadMessage {
  return {
    id,
    role: 'system',
    content: [{ type: 'text', text }],
    createdAt,
    metadata: { custom }
  } as unknown as ThreadMessage
}

function agent(id: string, text: string, running = false): ThreadMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: metadata({})
  } as ThreadMessage
}

const renderThread = (messages: ThreadMessage[]) =>
  render(
    <ThreadRuntime messages={messages}>
      <Thread />
    </ThreadRuntime>
  )

const DELIVERY = 'Message from 🤖 Scout (@scout): the build is green'
const PROCESS = '[IMPORTANT: Background process proc_1 completed normally (exit code 0).\nOutput:\nall 12 passed]'

/** Every note kind, as the transcript row that produces it, the text it shows and the upstream element inside. */
const NOTES: readonly (readonly [string, AthenaNoteKind, ThreadMessage[], string, string])[] = [
  [
    'slash-command output',
    'system',
    [system('s1', 'slash:/model\nmodel → gpt-x')],
    'model → gpt-x',
    '[data-slot="aui_system-message-root"]'
  ],
  [
    'a steer note',
    'system',
    [system('s1', 'steer:run the tests first')],
    'run the tests first',
    '[data-role="system"]'
  ],
  [
    'a review note',
    'system',
    [system('s1', 'review:Memory updated: prefers metric units')],
    'Memory updated',
    '[data-role="system"]'
  ],
  ['a plain system line', 'system', [system('s1', 'Session resumed.')], 'Session resumed.', '[data-role="system"]'],
  [
    'a background result',
    'background',
    [system('s1', '1 background agent finished', { asyncResult: 'the report' })],
    '1 background agent finished',
    '[data-slot="aui_background-result"]'
  ],
  [
    'a background process result',
    'background',
    [system('s1', 'Background process finished', { asyncResultKind: 'process' })],
    'Background process finished',
    '[data-slot="aui_background-result"]'
  ],
  [
    'refused content',
    'content-refused',
    [system('s1', 'the blocked request', { contentRefused: {} })],
    'the blocked request',
    '[data-slot="aui_content-refused"]'
  ],
  [
    'a process notification',
    'process',
    [userMessage('u1', PROCESS)],
    'Background process proc_1 completed normally (exit code 0).',
    '[data-slot="aui_background-result"]'
  ],
  [
    'an inter-agent delivery',
    'agent-message',
    [userMessage('u1', DELIVERY)],
    'Message from Scout',
    '[data-slot="aui_agent-message-note"]'
  ],
  [
    'a settled inter-agent reply',
    'agent-reply',
    [userMessage('u1', DELIVERY), agent('a1', 'thanks, merging')],
    'Replied to Scout',
    '[data-slot="aui_assistant-message-root"]'
  ]
]

/** The note holding `text`. */
async function noteWith(text: string) {
  const note = (await screen.findByText(text, { exact: false })).closest<HTMLElement>(NOTE)

  expect(note, `no Athena note holds "${text}"`).toBeTruthy()

  return note!
}

describe('notes in the Athena layout', () => {
  beforeEach(() => build('athena'))

  test.each(NOTES)('%s is a centred, ruled note of kind %s', async (_name, kind, messages, text, upstream) => {
    const { container } = renderThread(messages)
    const note = await noteWith(text)

    expect(container.querySelector(`[${ATHENA_CHAT_ATTR}]`)).toBeTruthy()
    expect(note.dataset.athenaNote).toBe(kind)
    // Upstream's element, inside the note: the parsing and the markup are upstream's.
    expect(note.querySelector(upstream)).toBeTruthy()
    // Not the user or the agent speaking: no bubble, no "You", no "Athena" label.
    expect(note.querySelector(USER_BUBBLE)).toBeNull()
    expect(note.querySelector(AGENT_LABEL)).toBeNull()
    expect(container.querySelector(USER_BUBBLE)).toBeNull()
    expect(within(container).queryByText('You')).toBeNull()
  })

  test.each(NOTES.filter(([, kind]) => kind !== 'agent-reply'))(
    '%s has its own note container around upstream’s element',
    async (_name, _kind, messages, text) => {
      renderThread(messages)
      const note = await noteWith(text)

      expect(note.dataset.slot).toBe('athena_note')
      expect(note.querySelector(NOTE)).toBeNull()
      expect(note.closest(ATHENA_AGENT)).toBeNull()
    }
  )

  test('a whole transcript: one note per non-speaking row, the user and agent speak as before', async () => {
    const { container } = renderThread([
      userMessage('u0', 'what changed?'),
      agent('a0', 'I switched the model'),
      system('s1', 'slash:/model\nmodel → gpt-x'),
      userMessage('u1', DELIVERY),
      agent('a1', 'thanks, merging'),
      system('s2', 'the blocked request', { contentRefused: {} })
    ])

    await screen.findByText('Replied to Scout')
    const kinds = [...container.querySelectorAll<HTMLElement>(NOTE)].map(note => note.dataset.athenaNote)

    expect(kinds).toEqual(['system', 'agent-message', 'agent-reply', 'content-refused'])
    expect(container.querySelectorAll('[data-slot="athena_user-message"]')).toHaveLength(1)
    expect(container.querySelectorAll(AGENT_LABEL)).toHaveLength(1)
    expect(screen.getByText('I switched the model').closest(NOTE)).toBeNull()
  })

  test('refused content stays greyed and non-interactive: no actions, not a user message', async () => {
    const { container } = renderThread([system('s1', 'the blocked request', { contentRefused: {} })])
    const note = await noteWith('the blocked request')

    expect(note.textContent).toContain(en.assistant.thread.contentRefusedNotice)
    expect(within(note).queryAllByRole('button')).toHaveLength(0)
    expect(note.querySelector('[data-role="user"], [data-slot="aui_user-message-root"]')).toBeNull()
    expect(container.querySelector('[data-slot="aui_user-bubble-actions"]')).toBeNull()
  })

  test('an inter-agent delivery expands and collapses its message', async () => {
    renderThread([userMessage('u1', DELIVERY)])
    const note = await noteWith('Message from Scout')
    const details = note.querySelector('details')!

    expect(details.open).toBe(false)
    fireEvent.click(within(note).getByText('show message'))
    expect(details.open).toBe(true)
    expect(within(details).getByText('the build is green')).toBeTruthy()
    fireEvent.click(within(note).getByText('show message'))
    expect(details.open).toBe(false)
  })

  test('a settled inter-agent reply expands and collapses the reply', async () => {
    renderThread([userMessage('u1', DELIVERY), agent('a1', 'thanks, merging')])
    const note = await noteWith('Replied to Scout')
    const details = note.querySelector('details')!

    expect(details.open).toBe(false)
    fireEvent.click(within(note).getByText('show reply'))
    expect(details.open).toBe(true)
    expect(within(details).getByText('thanks, merging')).toBeTruthy()
    fireEvent.click(within(note).getByText('show reply'))
    expect(details.open).toBe(false)
  })

  test.each([
    ['a process notification', [userMessage('u1', PROCESS)], 'Background process proc_1', 'all 12 passed'],
    [
      'a background result',
      [system('s1', '1 background agent finished', { asyncResult: 'the full report' })],
      '1 background agent finished',
      'the full report'
    ]
  ])('%s opens and closes its report', async (_name, messages, title, report) => {
    renderThread(messages)
    const note = await noteWith(title)
    const toggle = within(note).getByRole('button', { name: new RegExp(title) })

    expect(note.textContent).not.toContain(report)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(note.textContent).toContain(report)
    fireEvent.click(toggle)
    expect(note.textContent).not.toContain(report)
  })

  test('a link inside a note is a link and opens', async () => {
    const openExternal = vi.fn()

    ;(window as Bridge).hermesDesktop = { ...((window as Bridge).hermesDesktop ?? {}), openExternal }

    try {
      renderThread([system('s1', 'slash:/help\nDocs: https://example.com/docs')])
      const note = await noteWith('Docs:')
      const link = note.querySelector<HTMLAnchorElement>('a[href="https://example.com/docs"]')!

      expect(link).toBeTruthy()
      fireEvent(link, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
      expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')
    } finally {
      delete (window as Bridge).hermesDesktop
    }
  })

  test('a reply to a delivery is the agent speaking while it streams, and a note once settled (no remount)', async () => {
    const delivery = userMessage('u1', DELIVERY)
    const { rerender } = renderThread([delivery, agent('a1', 'working on it', true)])

    const block = (await screen.findByText('working on it')).closest<HTMLElement>(ATHENA_AGENT)!
    const root = block.querySelector('[data-slot="aui_assistant-message-root"]')

    expect(block.hasAttribute('data-athena-note')).toBe(false)
    expect(block.querySelector(AGENT_LABEL)?.textContent).toBe('Athena')

    rerender(
      <ThreadRuntime messages={[delivery, agent('a1', 'working on it, done')]}>
        <Thread />
      </ThreadRuntime>
    )

    await screen.findByText('Replied to Scout')
    expect(block.isConnected).toBe(true)
    expect(block.dataset.athenaNote).toBe('agent-reply')
    expect(block.querySelector(AGENT_LABEL)).toBeNull()
    expect(block.querySelector('[data-slot="aui_assistant-message-root"]')).toBe(root)
  })

  test('the agent block after a note carries the label', async () => {
    const { container } = renderThread([
      // A process notification opens the response group; the reply after it is the first block that speaks.
      userMessage('u1', PROCESS),
      agent('a1', 'the tests passed'),
      userMessage('u2', DELIVERY),
      // The collapsed reply is a note; the next block of the same group speaks.
      agent('a2', 'merged'),
      agent('a3', 'and told the user')
    ])

    await screen.findByText('and told the user')
    expect(screen.getByText('the tests passed').closest(ATHENA_AGENT)!.querySelector(AGENT_LABEL)).toBeTruthy()
    expect(screen.getByText('and told the user').closest(ATHENA_AGENT)!.querySelector(AGENT_LABEL)).toBeTruthy()
    expect(container.querySelectorAll(AGENT_LABEL)).toHaveLength(2)
  })
})

describe('notes with the Athena layout off', () => {
  test.each([
    ['row F15 off', () => build('athena', { F15: 'off' })],
    ['a stock build (no snapshot)', () => build(null)],
    ['a stock snapshot', () => build('stock')]
  ])('%s: every note kind renders as upstream does', async (_name, setUp) => {
    setUp()

    for (const [, , messages, text, upstream] of NOTES) {
      const { container, unmount } = renderThread(messages)

      const element = (await screen.findByText(text, { exact: false })).closest<HTMLElement>(upstream)!

      expect(element, text).toBeTruthy()
      expect(container.querySelector(`${NOTE}, [data-slot="athena_note"], [data-slot^="athena_"]`), text).toBeNull()
      expect(container.querySelector(`[${ATHENA_CHAT_ATTR}]`)).toBeNull()
      unmount()
    }
  })

  test('a live config change swaps a note both ways', async () => {
    build('athena')
    const { container } = renderThread([system('s1', 'Session resumed.')])

    await noteWith('Session resumed.')

    act(() => $clientConfig.set(snapshot('athena', { F15: 'off' })))
    expect(container.querySelector(NOTE)).toBeNull()
    expect(screen.getByText('Session resumed.', { exact: false }).closest('[data-role="system"]')).toBeTruthy()

    act(() => $clientConfig.set(snapshot('athena')))
    await waitFor(() => expect(container.querySelector(NOTE)?.getAttribute('data-athena-note')).toBe('system'))
  })
})

describe('note kinds', () => {
  test.each([
    [system('s', 'x', { contentRefused: {} }), 'content-refused'],
    [system('s', '', { contentRefused: { notice: 'no' } }), 'content-refused'],
    [system('s', ''), null],
    [system('s', 'done', { asyncResult: 'report' }), 'background'],
    [system('s', 'done', { asyncResultKind: 'process' }), 'background'],
    [system('s', 'done', { asyncResult: '' }), 'system'],
    [system('s', 'slash:/model\nx'), 'system']
  ])('system row %# → %s', (message, kind) => {
    expect(systemNoteKind(message)).toBe(kind)
  })

  test.each([
    [PROCESS, 'process'],
    [DELIVERY, 'agent-message'],
    ["[Message from agent 'scout'] hi", 'agent-message'],
    ['a plain prompt', null]
  ])('user row %j → %s', (text, kind) => {
    expect(userRoleNoteKind(text)).toBe(kind)
  })
})
