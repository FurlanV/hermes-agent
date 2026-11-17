import type { ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  createdAt,
  stubThreadEnvironment,
  stubThreadViewportSize,
  ThreadRuntime,
  userMessage
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { clearAllPrompts, setApprovalRequest } from '@/store/prompts'
import { $activeSessionId } from '@/store/session'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates } from '@/store/tool-view'

import type { ClientConfigSnapshot } from '../managed/client-config'
import { $clientConfig } from '../managed/client-config'
import { installFeaturePolicy } from '../managed/feature-policy'

stubThreadViewportSize()

const SESSION = 'session-f15-10'

type Part = ThreadMessage['content'][number]

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

function agent(content: Part[], running = false, id = 'assistant-1'): ThreadMessage {
  return {
    id,
    role: 'assistant',
    content,
    status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
  } as ThreadMessage
}

const call = (
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) => ({ type: 'tool-call', toolCallId, toolName, args, argsText: JSON.stringify(args), ...extra }) as Part

const text = (value: string) => ({ type: 'text', text: value }) as Part

// Text between the calls keeps each one its own run, so each is a row of its own.
const threeStates = () =>
  agent(
    [
      call('read-1', 'read_file', { path: '/repo/notes.md' }, { result: { content: 'hello from notes' } }),
      text('Next.'),
      call('fail-1', 'web_extract', { urls: ['https://example.test'] }, { result: { error: 'host unreachable' } }),
      text('Then.'),
      call('term-1', 'terminal', { command: 'sleep 10' })
    ],
    true
  )

const thread = (messages: ThreadMessage[]) => (
  <ThreadRuntime messages={messages}>
    <Thread />
  </ThreadRuntime>
)

const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-athena-tool-row]')]

const chip = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-slot="athena_tool-chip"]')!

const toggle = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('[data-slot="athena_tool-toggle"]')!

/** A row by the call it shows (its name or summary). */
async function rowFor(container: HTMLElement, label: RegExp) {
  await waitFor(() => expect(rows(container).some(row => label.test(row.textContent ?? ''))).toBe(true))

  return rows(container).find(row => label.test(row.textContent ?? ''))!
}

let uninstall: () => void

beforeEach(() => {
  stubThreadEnvironment()
  uninstall = installFeaturePolicy()
  clearAllPrompts()
  clearDismissedToolRows()
  $toolDisclosureStates.set({})
  $activeSessionId.set(SESSION)
})

afterEach(() => {
  cleanup()
  uninstall()
  clearAllPrompts()
  $clientConfig.set(null)
  delete (window as Bridge).athenaDesktop
  $activeSessionId.set(null)
})

describe('a tool call in the Athena layout', () => {
  beforeEach(() => build('athena'))

  test('a running, a finished and a failed call each show one row with the matching chip', async () => {
    const { container } = render(thread([userMessage('u1', 'go'), threeStates()]))

    const done = await rowFor(container, /notes\.md/)
    const failed = await rowFor(container, /example\.test|host unreachable/)
    const running = await rowFor(container, /sleep 10/)

    expect(rows(container)).toHaveLength(3)
    expect(chip(done).textContent).toBe('Done')
    expect(chip(failed).textContent).toBe('Failed')
    expect(chip(running).textContent).toBe('Running')

    // Told apart without colour: each chip has its own word and its own icon, and the colour is only a token.
    const icons = [done, failed, running].map(row => chip(row).querySelector('svg')!.getAttribute('class'))

    expect(new Set(icons).size).toBe(3)
    expect([done, failed, running].map(row => chip(row).getAttribute('data-athena-tool-state'))).toEqual([
      'done',
      'error',
      'running'
    ])

    // The failed row's summary is the error, from upstream's tool model.
    expect(failed.querySelector('[data-slot="athena_tool-summary"]')?.textContent).toContain('host unreachable')

    // A plain name and an icon on every row.
    for (const row of [done, failed, running]) {
      expect(row.querySelector('[data-slot="athena_tool-name"]')?.textContent?.trim()).toBeTruthy()
      expect(row.querySelector('[data-slot="athena_tool-icon"] svg, [data-slot="athena_tool-icon"] i')).not.toBeNull()
    }

    // Upstream's generic row is not there.
    expect(container.querySelectorAll('[data-tool-row]:not([data-athena-tool-row])')).toHaveLength(0)
  })

  test('a non-zero exit code is a failure, by upstream rule', async () => {
    const { container } = render(
      thread([
        userMessage('u1', 'go'),
        agent([
          call('t1', 'terminal', { command: 'deploy' }, { result: { output: 'nope', exit_code: 1, error: null } })
        ])
      ])
    )

    expect(chip(await rowFor(container, /deploy/)).textContent).toBe('Failed')
  })

  test('the row opens and closes by pointer and keyboard, showing the input and the output', async () => {
    const { container } = render(thread([userMessage('u1', 'go'), threeStates()]))
    const row = await rowFor(container, /notes\.md/)
    const button = toggle(row)
    const body = container.querySelector<HTMLElement>(`#${CSS.escape(button.getAttribute('aria-controls')!)}`)!

    // Collapsed: a native button in the tab order that controls the closed body.
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.tabIndex).toBe(0)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(body.hidden).toBe(true)
    expect(within(row).queryByText('Input')).toBeNull()

    fireEvent.click(button)

    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('true'))
    expect(body.hidden).toBe(false)
    expect(within(body).getByText('Input')).toBeTruthy()
    expect(body.querySelector('[data-slot="athena_tool-input"] pre')?.textContent).toContain('"path": "/repo/notes.md"')
    expect(within(body).getByText('Output')).toBeTruthy()
    expect(body.querySelector('[data-slot="athena_tool-output"]')?.textContent).toContain('hello from notes')

    fireEvent.click(button)
    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'))
    expect(body.hidden).toBe(true)

    // Keyboard: focus reaches the button, and Enter on a focused native button is a click (jsdom does not synthesise
    // it from the key, so the click is dispatched as the browser would). Focus stays on the button either way.
    button.focus()
    expect(window.document.activeElement).toBe(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.click(button)
    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('true'))
    expect(window.document.activeElement).toBe(button)
    fireEvent.keyDown(button, { key: ' ' })
    fireEvent.click(button)
    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'))
    expect(window.document.activeElement).toBe(button)
  })

  test('a failed row opens to the error, and a running row says it is waiting', async () => {
    const { container } = render(thread([userMessage('u1', 'go'), threeStates()]))
    const failed = await rowFor(container, /example\.test|host unreachable/)
    const running = await rowFor(container, /sleep 10/)

    fireEvent.click(toggle(failed))
    fireEvent.click(toggle(running))

    await waitFor(() =>
      expect(failed.querySelector('[data-athena-tool-output="error"]')?.textContent).toContain('host unreachable')
    )
    expect(running.querySelector('[data-slot="athena_tool-input"]')?.textContent).toContain('sleep 10')
    expect(running.querySelector('[data-slot="athena_tool-output"]')?.textContent).toContain('Waiting for the result')
  })

  test('the open state survives a remount (the list virtualises rows)', async () => {
    const first = render(thread([userMessage('u1', 'go'), threeStates()]))

    fireEvent.click(toggle(await rowFor(first.container, /notes\.md/)))
    first.unmount()

    const { container } = render(thread([userMessage('u1', 'go'), threeStates()]))

    await waitFor(async () =>
      expect(toggle(await rowFor(container, /notes\.md/)).getAttribute('aria-expanded')).toBe('true')
    )
  })

  test('approval keeps its upstream card, and it still answers', async () => {
    setApprovalRequest({ command: 'rm -rf /tmp/x', description: 'dangerous command', sessionId: SESSION })

    const { container } = render(
      thread([userMessage('u1', 'go'), agent([call('term-1', 'terminal', { command: 'rm -rf /tmp/x' })], true)])
    )

    await waitFor(() => expect(container.querySelector('[data-approval-stack]')).not.toBeNull())
    const stack = container.querySelector<HTMLElement>('[data-approval-stack]')!
    const run = within(stack).getAllByRole('button', { name: /^Run/ })[0]!

    expect(run.closest('[hidden], [inert], [data-athena-tool-row]')).toBeNull()
    expect(within(stack).getByRole('button', { name: /Reject/ })).toBeTruthy()
    expect(container.querySelector('[data-athena-chat]')).not.toBeNull()
  })

  test('card tools keep their upstream cards', async () => {
    const { container } = render(
      thread([
        userMessage('u1', 'go'),
        agent([
          call(
            'del-1',
            'delegate_task',
            { tasks: [{ goal: 'inspect A' }, { goal: 'inspect B' }] },
            { result: { count: 2, goals: ['inspect A', 'inspect B'], mode: 'background', status: 'dispatched' } }
          )
        ])
      ])
    )

    expect(await screen.findByText('inspect A')).toBeTruthy()
    expect(container.querySelector('[data-delegate-card]')).not.toBeNull()
    expect(rows(container)).toHaveLength(0)
  })
})

describe('a tool call with the Athena layout off', () => {
  test.each([
    ['row F15 off', () => build('athena', { F15: 'off' })],
    ['a stock build (no snapshot)', () => build(null)],
    ['a stock snapshot', () => build('stock')]
  ])('%s: upstream tool rows, no Athena row or chip', async (_name, setUp) => {
    setUp()

    const { container } = render(thread([userMessage('u1', 'go'), threeStates()]))

    await waitFor(() => expect(container.querySelectorAll('[data-tool-row]').length).toBeGreaterThan(0))
    expect(rows(container)).toHaveLength(0)
    expect(container.querySelector('[data-slot="athena_tool-chip"]')).toBeNull()
    expect(container.querySelector('[data-athena-chat]')).toBeNull()
    // Upstream's own row: its scaffold mark and its disclosure row.
    expect(container.querySelector('[data-tool-row][data-conversation-scaffold]')).not.toBeNull()
  })
})
