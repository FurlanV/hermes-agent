import type { ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  createdAt,
  stubThreadEnvironment,
  stubThreadViewportSize,
  ThreadRuntime,
  userMessage
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { clearAllPrompts } from '@/store/prompts'
import { $activeSessionId } from '@/store/session'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates } from '@/store/tool-view'

import type { ClientConfigSnapshot } from '../managed/client-config'
import { $clientConfig } from '../managed/client-config'
import { installFeaturePolicy } from '../managed/feature-policy'

stubThreadViewportSize()

const SESSION = 'session-f15-11'

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

function agent(content: Part[], running = false): ThreadMessage {
  return {
    id: 'assistant-1',
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

const read = (id: string, path: string) =>
  call(id, 'read_file', { path }, { result: { content: `contents of ${path}` } })

const command = (id: string, cmd: string, result?: unknown) =>
  call(id, 'terminal', { command: cmd }, result === undefined ? {} : { result })

const text = (value: string) => ({ type: 'text', text: value }) as Part

const thread = (messages: ThreadMessage[]) => (
  <ThreadRuntime messages={messages}>
    <Thread />
  </ThreadRuntime>
)

const turn = (content: Part[], running = false) => thread([userMessage('u1', 'go'), agent(content, running)])

const groups = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-athena-tool-group]')]

/** The rows on screen (a closed group's body is hidden and holds none). */
const shownRows = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-athena-tool-row]')].filter(row => !row.closest('[hidden]'))

const header = (group: HTMLElement) => group.querySelector<HTMLButtonElement>('[data-slot="athena_tool-group-toggle"]')!

const groupChip = (group: HTMLElement) =>
  group.querySelector<HTMLElement>('[data-slot="athena_tool-group-header"] [data-slot="athena_tool-chip"]')!

async function oneGroup(container: HTMLElement) {
  await waitFor(() => expect(groups(container)).toHaveLength(1))

  return groups(container)[0]!
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

describe('consecutive tool calls in the Athena layout', () => {
  beforeEach(() => build('athena'))

  test('two or more calls are one group with a count and a state; a call on its own is a plain row', async () => {
    const { container } = render(
      turn([
        read('r1', '/repo/a.ts'),
        read('r2', '/repo/b.ts'),
        command('t1', 'ls', { exit_code: 0, stdout: 'a.ts' }),
        text('Now the last one.'),
        command('t2', 'pwd', { exit_code: 0, stdout: '/repo' })
      ])
    )

    const group = await oneGroup(container)
    const toggle = header(group)

    // One line: upstream's run summary, the count and the worst state, closed.
    expect(group.querySelector('[data-slot="athena_tool-group-summary"]')?.textContent).toBe(
      'Explored 2 files, ran 1 command'
    )
    expect(group.querySelector('[data-slot="athena_tool-group-count"]')?.textContent).toBe('3 calls')
    expect(groupChip(group).textContent).toBe('Done')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // The lone call after the text is the row alone: no group, no summary line around it.
    const rows = shownRows(container)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('pwd')
    expect(rows[0]!.closest('[data-athena-tool-group]')).toBeNull()
    expect(container.querySelectorAll('[data-slot="athena_tool-group-header"]')).toHaveLength(1)

    // It opens to its rows, by pointer and by keyboard (a native button: Enter is a click).
    const body = container.querySelector<HTMLElement>(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`)!

    expect(body.hidden).toBe(true)
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'))
    expect(body.hidden).toBe(false)
    expect(body.querySelectorAll('[data-athena-tool-row]')).toHaveLength(3)
    expect(shownRows(container)).toHaveLength(4)

    toggle.focus()
    fireEvent.keyDown(toggle, { key: 'Enter' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'))
    expect(window.document.activeElement).toBe(toggle)
    expect(shownRows(container)).toHaveLength(1)
  })

  test('the group shows its worst state: running if any runs', async () => {
    const { container } = render(turn([read('r1', '/repo/a.ts'), command('t1', 'sleep 5')], true))
    const group = await oneGroup(container)

    expect(groupChip(group).textContent).toBe('Running')
    expect(groupChip(group).getAttribute('data-athena-tool-state')).toBe('running')
  })

  test('a group with a failed call says so in text while closed', async () => {
    const { container } = render(
      turn([
        read('r1', '/repo/a.ts'),
        call('x1', 'web_extract', { urls: ['https://example.test'] }, { result: { error: 'host unreachable' } }),
        read('r2', '/repo/b.ts')
      ])
    )

    const group = await oneGroup(container)

    expect(header(group).getAttribute('aria-expanded')).toBe('false')
    expect(groupChip(group).textContent).toBe('Failed')
    expect(group.querySelector('[data-slot="athena_tool-group-summary"]')?.textContent).toContain('1 tool call failed')
    // The whole line is the button's name, so a screen reader hears it too.
    expect(header(group).textContent).toMatch(/1 tool call failed.*3 calls.*Failed/)
  })

  test('a group stays open or closed as the user left it while the turn streams', async () => {
    const calls = [read('r1', '/repo/a.ts'), command('t1', 'sleep 1')]
    const { container, rerender } = render(turn(calls, true))

    // Opened while it runs: new calls join, results land, the text grows; it stays open.
    fireEvent.click(header(await oneGroup(container)))
    await waitFor(() => expect(shownRows(container)).toHaveLength(2))

    const more = [read('r1', '/repo/a.ts'), command('t1', 'sleep 1', { exit_code: 0 }), read('r3', '/repo/c.ts')]

    rerender(turn(more, true))
    await waitFor(() => expect(shownRows(container)).toHaveLength(3))
    expect(header(await oneGroup(container)).getAttribute('aria-expanded')).toBe('true')
    expect((await oneGroup(container)).querySelector('[data-slot="athena_tool-group-count"]')?.textContent).toBe(
      '3 calls'
    )

    // Closed by the user: more calls stream in and it stays closed.
    fireEvent.click(header(await oneGroup(container)))
    await waitFor(() => expect(shownRows(container)).toHaveLength(0))

    rerender(turn([...more, command('t2', 'sleep 2')], true))
    await waitFor(() =>
      expect(groups(container)[0]!.querySelector('[data-slot="athena_tool-group-count"]')?.textContent).toBe('4 calls')
    )
    expect(header(groups(container)[0]!).getAttribute('aria-expanded')).toBe('false')
    expect(shownRows(container)).toHaveLength(0)

    // And the turn ends: still as the user left it.
    rerender(turn([...more, command('t2', 'sleep 2', { exit_code: 0 })]))
    await waitFor(() => expect(groupChip(groups(container)[0]!).textContent).toBe('Done'))
    expect(header(groups(container)[0]!).getAttribute('aria-expanded')).toBe('false')
  })

  test('a row being read stays on screen when a second call joins it', async () => {
    const { container, rerender } = render(turn([command('t1', 'sleep 1')], true))

    await waitFor(() => expect(shownRows(container)).toHaveLength(1))
    fireEvent.click(shownRows(container)[0]!.querySelector('[data-slot="athena_tool-toggle"]')!)

    rerender(turn([command('t1', 'sleep 1'), read('r1', '/repo/a.ts')], true))

    const group = await oneGroup(container)

    expect(header(group).getAttribute('aria-expanded')).toBe('true')
    expect(shownRows(container)).toHaveLength(2)
    expect(container.querySelector('[data-athena-tool-row][data-tool-open]')?.textContent).toContain('sleep 1')
  })
})

describe('consecutive tool calls with the Athena layout off', () => {
  test.each([
    ['row F15 off', () => build('athena', { F15: 'off' })],
    ['a stock build (no snapshot)', () => build(null)],
    ['a stock snapshot', () => build('stock')]
  ])('%s: upstream run summary, no Athena group', async (_name, setUp) => {
    setUp()

    const { container, findByText } = render(
      turn([read('r1', '/repo/a.ts'), read('r2', '/repo/b.ts'), command('t1', 'ls', { exit_code: 0 })])
    )

    expect(await findByText('Explored 2 files, ran 1 command')).toBeTruthy()
    expect(container.querySelector('[data-tool-summary][data-conversation-scaffold]')).not.toBeNull()
    expect(groups(container)).toHaveLength(0)
    expect(container.querySelector('[data-slot="athena_tool-group-header"], [data-athena-tool-row]')).toBeNull()
    expect(container.querySelector('[data-athena-chat]')).toBeNull()
  })
})
