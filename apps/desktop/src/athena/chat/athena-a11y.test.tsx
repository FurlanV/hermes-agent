/**
 * F15 slice 13: keyboard and screen-reader checks over one fixed transcript in the Athena layout (a user message
 * with code, an agent reply with code, a group of tool calls, a failed tool call, a note and an error), against the
 * same transcript in the upstream layout. jsdom has no layout and never matches `:focus-visible`, so the ring is
 * read from `chat.css` (each rule matched against the control by hand) and the sizes from the classes.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { cleanup, queryAllByRole, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createdAt,
  stubThreadEnvironment,
  stubThreadViewportSize,
  userMessage
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { __resetElapsedTimerRegistryForTests } from '@/components/chat/activity-timer'
import { en } from '@/i18n/en'
import { clearAllPrompts } from '@/store/prompts'
import { $reactionsEnabled } from '@/store/reactions-enabled'
import { $activeSessionId, $busy, $turnStartedAt } from '@/store/session'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates } from '@/store/tool-view'

import type { ClientConfigSnapshot } from '../managed/client-config'
import { $clientConfig } from '../managed/client-config'
import { installFeaturePolicy } from '../managed/feature-policy'
import { athenaStrings } from '../strings'

import { ATHENA_CHAT_ATTR } from './layout'

stubThreadViewportSize()

const SESSION = 'session-f15-13'
const YOU = athenaStrings.chat.userLabel
const ATHENA = athenaStrings.chat.agentLabel
const RING = '2px solid var(--chat-agent-label)'
const thread = en.assistant.thread

let sheet: HTMLStyleElement

// jsdom applies a stylesheet's declarations (unresolved) but vitest loads no CSS: inject the Athena one.
beforeAll(() => {
  sheet = window.document.createElement('style')
  sheet.textContent = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'chat.css'), 'utf8')
  window.document.head.append(sheet)
})

afterAll(() => sheet.remove())

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

/** The preload's snapshot (the variant) and the live client config (the rows). */
function build(features: Record<string, string> = {}) {
  ;(window as Bridge).athenaDesktop = { clientConfig: { snapshot: snapshot('athena', features) } }
  $clientConfig.set(snapshot('athena', features))
}

const LAYOUTS = {
  athena: () => build(),
  upstream: () => build({ F15: 'off' })
}

// ---- the fixed transcript ----

type Part = ThreadMessage['content'][number]

const metadata = () => ({ unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} })

function agent(id: string, content: Part[], status: ThreadMessage['status'] = { type: 'complete', reason: 'stop' }) {
  return { id, role: 'assistant', content, status, createdAt, metadata: metadata() } as unknown as ThreadMessage
}

const call = (toolCallId: string, toolName: string, args: Record<string, unknown>, result?: unknown) =>
  ({
    type: 'tool-call',
    toolCallId,
    toolName,
    args,
    argsText: JSON.stringify(args),
    ...(result === undefined ? {} : { result })
  }) as Part

const text = (value: string) => ({ type: 'text', text: value }) as Part

const TURN: ThreadMessage[] = [
  userMessage('u1', 'try this:\n```py\nprint("hi")\n```\nthanks'),
  agent('a1', [
    text('Here it is:\n\n```ts\nconst a = 1\n```\n\nNow the files.'),
    call('r1', 'read_file', { path: '/repo/a.ts' }, { content: 'a' }),
    call('r2', 'read_file', { path: '/repo/b.ts' }, { content: 'b' }),
    text('And one command.'),
    call('t1', 'terminal', { command: 'false' }, { exit_code: 1, stderr: 'boom' })
  ]),
  {
    id: 's1',
    role: 'system',
    content: [{ type: 'text', text: '1 background agent finished' }],
    createdAt,
    metadata: { custom: { asyncResult: 'the report' } }
  } as unknown as ThreadMessage,
  userMessage('u2', 'again please'),
  agent('a2', [], { type: 'incomplete', reason: 'error', error: 'HTTP 500: upstream exploded' })
]

const noop = () => undefined

function Harness({ messages }: { messages: ThreadMessage[] }) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages,
    isRunning: messages.at(-1)?.status?.type === 'running',
    onNew: async () => {},
    onReload: async () => {}
  })

  // Every action a message can offer: branch, restore, stop, dismiss (and reactions, switched on below).
  return (
    <MemoryRouter>
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread onBranchInNewChat={noop} onCancel={noop} onDismissError={noop} onRestoreToMessage={noop} />
      </AssistantRuntimeProvider>
    </MemoryRouter>
  )
}

/** The fixed transcript, mounted (code highlighted, the error shown); the thread root. */
async function renderTurn() {
  const { container } = render(<Harness messages={TURN} />)

  await screen.findByRole('alert')
  await waitFor(() => expect(container.querySelectorAll('[data-slot="code-card"]').length).toBeGreaterThan(0))

  return container.querySelector<HTMLElement>('[data-slot="thread"]')!
}

// ---- tab order, names, rings and sizes ----

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]'

/** The tab stops under `root` in DOM (= tab) order: focusable, not disabled, not hidden or inert. No control here
 *  sets a positive tabindex, so DOM order is the order Tab walks. */
function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => {
    expect(el.tabIndex, el.outerHTML.slice(0, 80)).toBeLessThanOrEqual(0)

    return (
      el.tabIndex === 0 &&
      !(el as HTMLButtonElement).disabled &&
      !el.closest('[hidden], [inert]') &&
      (el.tagName !== 'SUMMARY' || el.parentElement?.tagName === 'DETAILS')
    )
  })
}

/** The accessible name testing-library computes for `el` (its role query's name matcher sees every candidate). */
function accessibleName(el: HTMLElement): string {
  const role = el.tagName === 'A' ? 'link' : (el.getAttribute('role') ?? 'button')
  let found: null | string = null

  queryAllByRole(el.parentElement!, role, {
    hidden: true,
    name: (name, node) => {
      if (node === el) {
        found = name
      }

      return false
    }
  })

  expect(found, `no ${role} role for ${el.outerHTML.slice(0, 80)}`).not.toBeNull()

  return found!
}

/** Split a selector list on its top-level commas (not the ones inside `:is()` or `:where()`). */
function selectorList(selectorText: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i]

    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
    } else if (ch === ',' && depth === 0) {
      out.push(selectorText.slice(start, i).trim())
      start = i + 1
    }
  }

  return [...out, selectorText.slice(start).trim()]
}

const styleRules = () => [...sheet.sheet!.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)

/** Does `selector`, with its user-action pseudo-classes dropped, match `el`? (Pseudo-elements never do.) */
function matchesStatic(el: Element, selector: string): boolean {
  if (selector.includes('::')) {
    return false
  }

  const plain = selector
    .replace(/:is\(\s*(?::(?:hover|focus-visible|focus-within|focus|active)\s*,?\s*)+\)/g, '')
    .replace(/:(?:hover|focus-visible|focus-within|focus|active)\b/g, '')

  return el.matches(plain)
}

/** The rules of chat.css that apply to `el` (any state). */
const rulesFor = (el: Element) =>
  styleRules().filter(rule => selectorList(rule.selectorText).some(s => matchesStatic(el, s)))

/** The outlines the chat.css `:focus-visible` rules give `el`: every one of them, whichever wins the cascade. */
const focusRings = (el: Element) =>
  styleRules()
    .filter(rule => rule.style.getPropertyValue('outline'))
    .filter(rule => selectorList(rule.selectorText).some(s => s.endsWith(':focus-visible') && matchesStatic(el, s)))
    .map(rule => rule.style.getPropertyValue('outline'))

const SIZE_PROPERTY = /^(?:min-|max-)?(?:height|width|block-size|inline-size)$|^padding/

/** The size and padding a control's Tailwind classes give it, in px (0.25rem steps at 16px). */
function classBox(el: Element) {
  const px = (pattern: RegExp) =>
    Math.max(0, ...[...el.classList].flatMap(c => (pattern.exec(c) ? [Number(pattern.exec(c)![1]) * 4] : [])))

  return {
    block: px(/^(?:size|h|min-h)-(\d+(?:\.\d+)?)$/),
    inline: px(/^(?:size|w|min-w)-(\d+(?:\.\d+)?)$/),
    padBlock: px(/^p[ty]?-(\d+(?:\.\d+)?)$/),
    padInline: px(/^p[xs]?-(\d+(?:\.\d+)?)$/)
  }
}

/** The Athena message scopes the slice 13 ring rule covers. */
const MESSAGE_SCOPE = '[data-slot="athena_user-message"], [data-slot="athena_assistant-message"], [data-athena-note]'

let uninstall: () => void

beforeEach(() => {
  window.localStorage.clear()
  stubThreadEnvironment()
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
  uninstall = installFeaturePolicy()
  clearAllPrompts()
  clearDismissedToolRows()
  $toolDisclosureStates.set({})
  $reactionsEnabled.set(true)
  $activeSessionId.set(SESSION)
  __resetElapsedTimerRegistryForTests()
})

afterEach(() => {
  cleanup()
  uninstall()
  clearAllPrompts()
  $clientConfig.set(null)
  delete (window as Bridge).athenaDesktop
  $reactionsEnabled.set(false)
  $busy.set(false)
  $turnStartedAt.set(null)
  $activeSessionId.set(null)
  __resetElapsedTimerRegistryForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('keyboard: a fixed turn in the Athena layout', () => {
  test("every action is a tab stop with a name and the ring, in upstream's order", async () => {
    LAYOUTS.upstream()
    const upstreamRoot = await renderTurn()

    expect(upstreamRoot.hasAttribute(ATHENA_CHAT_ATTR)).toBe(false)
    const upstream = tabStops(upstreamRoot).map(el => ({ el, name: accessibleName(el) }))

    cleanup()
    LAYOUTS.athena()
    const root = await renderTurn()

    expect(root.hasAttribute(ATHENA_CHAT_ATTR)).toBe(true)
    const stops = tabStops(root)
    const athena = stops.map(el => ({ el, name: accessibleName(el) }))

    // The turn has every kind of action (so the walk below covers them all).
    const names = athena.map(stop => stop.name)

    for (const expected of [
      thread.editMessage,
      thread.restoreCheckpoint,
      en.assistant.tool.copyCode,
      thread.copy,
      thread.branchNewChat,
      thread.refresh,
      thread.react,
      thread.errorRetry,
      thread.errorDetails,
      thread.dismissError
    ]) {
      expect(names, expected).toContain(expected)
    }

    expect(root.querySelector('[data-slot="athena_tool-group-toggle"]')).not.toBeNull()
    expect(root.querySelector('[data-slot="athena_tool-toggle"]')).not.toBeNull()
    expect(root.querySelector('[data-athena-note] button, [data-athena-note] summary')).not.toBeNull()

    // Named: every stop has an accessible name.
    for (const { el, name } of athena) {
      expect(name.trim(), el.outerHTML.slice(0, 120)).not.toBe('')
    }

    // Upstream's order: the same stops in the same order; no extra stop (the labels and the code header add none).
    // An Athena name may say more than upstream's (a tool toggle adds the summary, the count and the state).
    expect(athena.map(stop => stop.el.tagName)).toEqual(upstream.map(stop => stop.el.tagName))

    athena.forEach(({ name }, i) =>
      expect(name.startsWith(upstream[i]!.name), `${name} | ${upstream[i]!.name}`).toBe(true)
    )

    // The labels are not focusable and hold no stop.
    for (const label of root.querySelectorAll(
      '[data-slot="athena_user-label"], [data-slot="athena_assistant-label"]'
    )) {
      expect(tabStops(label as HTMLElement)).toEqual([])
      expect(label.matches(FOCUSABLE)).toBe(false)
    }

    // The ring: every stop in a message gets the one ring from chat.css, whichever rule wins; the stops outside the
    // messages (the timeline rail) are not Athena's and keep upstream's.
    const inMessages = stops.filter(el => el.closest(MESSAGE_SCOPE))

    expect(inMessages.length).toBeGreaterThanOrEqual(15)

    for (const el of inMessages) {
      const rings = focusRings(el)

      expect(rings.length, `no ring for ${el.outerHTML.slice(0, 120)}`).toBeGreaterThan(0)
      expect(new Set(rings), el.outerHTML.slice(0, 120)).toEqual(new Set([RING]))
    }

    for (const el of stops.filter(stop => !stop.closest(MESSAGE_SCOPE))) {
      expect(el.closest('[data-slot^="aui_"], [data-athena-note]'), el.outerHTML.slice(0, 120)).toBeNull()
    }

    // Inside a tool row (which clips what overflows it) the ring sits inside the control.
    for (const el of root.querySelectorAll(
      '[data-slot="athena_tool-toggle"], [data-slot="athena_tool-group-toggle"]'
    )) {
      const offsets = styleRules()
        .filter(rule => rule.style.getPropertyValue('outline-offset'))
        .filter(rule => selectorList(rule.selectorText).some(s => s.endsWith(':focus-visible') && matchesStatic(el, s)))
        .map(rule => rule.style.getPropertyValue('outline-offset'))

      expect(offsets.at(-1)).toBe('-2px')
    }
  })

  test("no control is smaller than upstream's", async () => {
    LAYOUTS.upstream()
    const upstream = tabStops(await renderTurn())

    cleanup()
    LAYOUTS.athena()
    const athena = tabStops(await renderTurn())

    expect(athena).toHaveLength(upstream.length)

    // chat.css never sizes or pads a control (it only colours, borders and rings them)...
    for (const el of athena) {
      for (const rule of rulesFor(el)) {
        const sized = [...rule.style].filter(property => SIZE_PROPERTY.test(property))

        expect(sized, `${rule.selectorText} on ${el.outerHTML.slice(0, 80)}`).toEqual([])
      }
    }

    // ...and the controls the Athena components draw themselves (Copy in the code header, the tool toggles and
    // dismiss) are at least as large as upstream's at the same stop.
    athena.forEach((el, i) => {
      if (!el.closest('[data-slot^="athena_"]') || el.closest('[data-slot="athena_user-bubble"]')) {
        return
      }

      const mine = classBox(el)
      const theirs = classBox(upstream[i]!)

      expect(mine.block, el.outerHTML.slice(0, 80)).toBeGreaterThanOrEqual(theirs.block)
      expect(mine.inline, el.outerHTML.slice(0, 80)).toBeGreaterThanOrEqual(theirs.inline)
      expect(mine.padBlock, el.outerHTML.slice(0, 80)).toBeGreaterThanOrEqual(theirs.padBlock)
      expect(mine.padInline, el.outerHTML.slice(0, 80)).toBeGreaterThanOrEqual(theirs.padInline)
    })
  })
})

describe('screen readers: who speaks, tool state, errors and status', () => {
  test('the user and agent messages are groups named "You" and "Athena"; the visible labels are read once', async () => {
    LAYOUTS.athena()
    const root = await renderTurn()

    const you = screen.getAllByRole('group', { name: YOU })
    const agentBlocks = screen.getAllByRole('group', { name: ATHENA })

    expect(you).toHaveLength(2)
    expect(agentBlocks).toHaveLength(2)
    expect(within(you[0]!).getByRole('button', { name: thread.editMessage })).toBeTruthy()
    expect(within(agentBlocks[0]!).getByRole('button', { name: thread.copy })).toBeTruthy()

    // Not read twice: the visible label is out of the tree (the group's name says it).
    const labels = root.querySelectorAll('[data-slot="athena_user-label"], [data-slot="athena_assistant-label"]')

    expect(labels.length).toBe(4)

    for (const label of labels) {
      expect(label.getAttribute('aria-hidden')).toBe('true')
    }

    // Still on screen, as the group's first child.
    expect(you[0]!.firstElementChild).toBe(labels[0])
    expect(labels[0]!.textContent).toBe(YOU)

    // A note is not speech: no speaker.
    const note = root.querySelector<HTMLElement>('[data-athena-note]')!

    expect(note.closest('[role="group"]')).toBeNull()
    expect(note.querySelector('[role="group"]')).toBeNull()
  })

  test("a tool row and a group announce their state; the error is an alert in Athena's block", async () => {
    LAYOUTS.athena()
    await renderTurn()

    const group = screen.getByRole('button', { name: `Explored 2 files ${athenaStrings.chat.tools.calls(2)} Done` })

    expect(group.dataset.slot).toBe('athena_tool-group-toggle')
    expect(group.getAttribute('aria-expanded')).toBe('false')

    const row = window.document.querySelector<HTMLElement>('[data-slot="athena_tool-toggle"]')!

    expect(accessibleName(row)).toMatch(new RegExp(`^Ran false .* ${athenaStrings.chat.tools.state.error}$`))

    const alert = screen.getByRole('alert')

    expect(alert.closest('[role="group"]')?.getAttribute('aria-label')).toBe(ATHENA)
  })

  test('a running turn: Stop is named and ringed, and the status line is one polite live region', async () => {
    LAYOUTS.athena()
    $turnStartedAt.set(Date.now())
    $busy.set(true)

    render(
      <Harness messages={[userMessage('u1', 'hi'), agent('a1', [text('Hello **world**')], { type: 'running' })]} />
    )
    await screen.findByText('world')

    const stop = screen.getByRole('button', { name: thread.stop })

    expect(stop.closest('[role="group"]')?.getAttribute('aria-label')).toBe(YOU)
    expect(new Set(focusRings(stop))).toEqual(new Set([RING]))

    const status = screen.getAllByRole('status')

    expect(status).toHaveLength(1)
    expect(status[0]!.getAttribute('aria-live')).toBe('polite')
    expect(status[0]!.closest('[role="group"]')?.getAttribute('aria-label')).toBe(ATHENA)
  })

  test('a running tool call says so in its name', async () => {
    LAYOUTS.athena()
    $turnStartedAt.set(Date.now())
    $busy.set(true)

    render(
      <Harness
        messages={[
          userMessage('u1', 'hi'),
          agent('a1', [call('t1', 'terminal', { command: 'ls' })], { type: 'running' })
        ]}
      />
    )

    const row = await waitFor(() => window.document.querySelector<HTMLElement>('[data-slot="athena_tool-toggle"]')!)

    expect(accessibleName(row)).toMatch(new RegExp(` ${athenaStrings.chat.tools.state.running}$`))
  })
})

describe('the upstream layout (row F15 off)', () => {
  test('no speaker groups, and the Athena ring reaches no control', async () => {
    LAYOUTS.upstream()
    const root = await renderTurn()

    expect(screen.queryAllByRole('group', { name: YOU })).toEqual([])
    expect(screen.queryAllByRole('group', { name: ATHENA })).toEqual([])

    for (const el of tabStops(root)) {
      expect(focusRings(el), el.outerHTML.slice(0, 80)).toEqual([])
    }
  })
})
