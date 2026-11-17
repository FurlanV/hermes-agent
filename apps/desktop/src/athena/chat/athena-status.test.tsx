import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createdAt,
  stubThreadEnvironment,
  stubThreadViewportSize,
  ThreadRuntime,
  userMessage
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { __resetElapsedTimerRegistryForTests } from '@/components/chat/activity-timer'
import type * as HermesApi from '@/hermes'
import { getLocalModelsStatus } from '@/hermes'
import { en } from '@/i18n/en'
import { setSessionCompacting } from '@/store/compaction'
import { $localModelsEnabled } from '@/store/local-models-flag'
import { $providerWaitSessions, setSessionProviderWait } from '@/store/provider-wait'
import { $activeSessionId, $busy, $currentModel, $currentProvider, $turnStartedAt } from '@/store/session'
import { $draftingToolSessions, setSessionDraftingTool } from '@/store/tool-drafting'
import type { LocalModelsStatus } from '@/types/hermes'

import type { ClientConfigSnapshot } from '../managed/client-config'
import { $clientConfig } from '../managed/client-config'
import { installFeaturePolicy } from '../managed/feature-policy'

// The renderer-side load bar polls the local-models status route; the rest of the API is real.
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getLocalModelsStatus: vi.fn()
}))

stubThreadViewportSize()

const copy = en.assistant.thread
const SESSION = 'session-f15-09'
const WORKING = 'Athena is working'

/** Upstream's two tail rows, as shown (an idle activity row stays mounted, hidden and empty, for its live region). */
const SHOWN_STATUS = '[data-slot="aui_response-loading"], [data-slot="aui_turn-activity"][data-state="active"]'

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'chat.css')
let sheet: HTMLStyleElement

// jsdom applies a stylesheet's declarations (unresolved) but vitest loads no CSS: inject the Athena one.
beforeAll(() => {
  sheet = window.document.createElement('style')
  sheet.textContent = readFileSync(CSS_PATH, 'utf8')
  window.document.head.append(sheet)
})

/** Split a selector list on its top-level commas (not the ones inside `:is()` or `:has()`). */
function selectorList(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
    } else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim())
      start = i + 1
    }
  }

  return [...out, text.slice(start).trim()]
}

const styleRules = (rules: CSSRuleList) => [...rules].filter((rule): rule is CSSStyleRule => 'selectorText' in rule)

/** The elements the stylesheet draws a caret after: its rules animated with the caret animation, minus `::after`. */
function caretHosts(): Element[] {
  const selectors = styleRules(sheet.sheet!.cssRules)
    .filter(rule => rule.style.getPropertyValue('animation').includes('--athena-caret-animation'))
    .flatMap(rule => selectorList(rule.selectorText))

  expect(selectors.length, 'chat.css has no caret rule').toBeGreaterThan(0)

  return [
    ...new Set(selectors.flatMap(selector => [...window.document.querySelectorAll(selector.replace(/::after$/, ''))]))
  ]
}

const shownStatus = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(SHOWN_STATUS)]

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

type Part = ThreadMessage['content'][number]

function agent(
  content: string | Part[],
  { custom = {}, running = false }: { custom?: Record<string, unknown>; running?: boolean } = {}
): ThreadMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom }
  } as ThreadMessage
}

const runningTool = { type: 'tool-call', toolCallId: 't1', toolName: 'read_file', args: {}, argsText: '{}' } as Part

const thread = (messages: ThreadMessage[]) => (
  <ThreadRuntime messages={messages}>
    <Thread />
  </ThreadRuntime>
)

/** A turn the session is working on, as the composer sees it: busy, with its clock armed. */
function startTurn() {
  $activeSessionId.set(SESSION)
  $turnStartedAt.set(Date.now())
  $busy.set(true)
}

function endTurn() {
  $busy.set(false)
  $turnStartedAt.set(null)
}

let uninstall: () => void

beforeEach(() => {
  stubThreadEnvironment()
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
  uninstall = installFeaturePolicy()
  __resetElapsedTimerRegistryForTests()
})

afterEach(() => {
  cleanup()
  uninstall()
  $clientConfig.set(null)
  delete (window as Bridge).athenaDesktop
  endTurn()
  $activeSessionId.set(null)
  setSessionCompacting(SESSION, false)
  $providerWaitSessions.set({})
  $draftingToolSessions.set({})
  $localModelsEnabled.set(false)
  $currentProvider.set('')
  $currentModel.set('')
  __resetElapsedTimerRegistryForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the running turn in the Athena layout', () => {
  beforeEach(() => build('athena'))

  test('a streaming reply has exactly one status line and one caret; both go when the turn ends', async () => {
    startTurn()

    const { container, rerender } = render(
      thread([userMessage('u1', 'hi'), agent('Hello **world**', { running: true })])
    )

    await screen.findByText('world')

    // Straight away, not after upstream's quiet window: the line is up for the whole working turn.
    const lines = shownStatus(container)

    expect(lines).toHaveLength(1)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(lines[0]!.textContent).toContain(WORKING)
    expect(lines[0]!.getAttribute('aria-live')).toBe('polite')
    expect(lines[0]!.getAttribute('aria-label')).toBe(WORKING)

    // The caret sits at the end of the streaming text: after its last paragraph.
    const carets = caretHosts()

    expect(carets).toHaveLength(1)
    expect(carets[0]!.tagName).toBe('P')
    expect(carets[0]!.textContent).toBe('Hello world')

    // It moves to the end of the text as more arrives.
    rerender(thread([userMessage('u1', 'hi'), agent('Hello **world**\n\n- one\n- two', { running: true })]))
    await screen.findByText('two')
    expect(caretHosts().map(host => host.textContent)).toEqual(['two'])
    expect(shownStatus(container)).toHaveLength(1)

    act(() => endTurn())
    rerender(thread([userMessage('u1', 'hi'), agent('Hello **world**\n\n- one\n- two')]))

    await waitFor(() => expect(shownStatus(container)).toHaveLength(0))
    expect(caretHosts()).toHaveLength(0)
    expect(container.textContent).not.toContain(WORKING)
  })

  test('one line through the turn: before the first token and while text streams; a running tool narrates itself', async () => {
    startTurn()
    const { container, rerender } = render(thread([userMessage('u1', 'hi'), agent([], { running: true })]))

    // Before the first token: upstream's loading row, with the lead.
    await waitFor(() => expect(container.querySelector('[data-slot="aui_response-loading"]')).toBeTruthy())
    expect(shownStatus(container)).toHaveLength(1)
    expect(shownStatus(container)[0]!.textContent).toContain(WORKING)
    expect(caretHosts()).toHaveLength(0)

    rerender(thread([userMessage('u1', 'hi'), agent('Reading the file', { running: true })]))
    await screen.findByText('Reading the file')
    expect(shownStatus(container)).toHaveLength(1)
    expect(caretHosts()).toHaveLength(1)

    // A tool call runs after the text: its row narrates the wait with its own timer, so the line steps aside (as
    // upstream's does), and the text is no longer streaming, so no caret.
    const textThenTool = (result?: string) =>
      agent(
        [
          { type: 'text', text: 'Reading the file' } as Part,
          result === undefined ? runningTool : ({ ...runningTool, result } as Part)
        ],
        { running: true }
      )

    rerender(thread([userMessage('u1', 'hi'), textThenTool()]))
    await waitFor(() => expect(shownStatus(container)).toHaveLength(0))
    expect(caretHosts()).toHaveLength(0)

    // The tool finishes and the turn keeps working: the line is back at once, the same live region (never two).
    rerender(thread([userMessage('u1', 'hi'), textThenTool('ok')]))
    await waitFor(() => expect(shownStatus(container)).toHaveLength(1))
    expect(shownStatus(container)[0]!.textContent).toContain(WORKING)
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  test('only the tail shows it: a stale running bubble mid-transcript has no line and no caret', async () => {
    startTurn()

    const { container } = render(
      thread([
        userMessage('u1', 'first'),
        { ...agent('stranded reply', { running: true }), id: 'assistant-0' },
        userMessage('u2', 'second'),
        agent('live reply', { running: true })
      ])
    )

    await screen.findByText('live reply')
    expect(shownStatus(container)).toHaveLength(1)
    expect(shownStatus(container)[0]!.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('assistant-1')
    expect(caretHosts().map(host => host.textContent)).toEqual(['live reply'])
  })

  test('the line shows the current step as upstream reports it: compaction, a provider wait, a drafted tool', async () => {
    startTurn()
    const { container } = render(thread([userMessage('u1', 'hi'), agent('partial', { running: true })]))

    await screen.findByText('partial')

    act(() => setSessionCompacting(SESSION, true))
    await screen.findByRole('status', { name: 'Summarizing thread' })
    expect(shownStatus(container)).toHaveLength(1)
    expect(shownStatus(container)[0]!.textContent).toContain(WORKING)
    expect(shownStatus(container)[0]!.textContent).toContain('Summarizing thread')

    act(() => setSessionCompacting(SESSION, false))
    act(() => setSessionProviderWait(SESSION, '⏳ waiting on the provider — 30s with no output yet'))
    await screen.findByRole('status', { name: '⏳ waiting on the provider — 30s with no output yet' })
    expect(screen.getByText('⏳ waiting on the provider — 30s with no output yet')).toBeTruthy()

    act(() => setSessionProviderWait(SESSION, ''))
    act(() => setSessionDraftingTool(SESSION, 'read_file'))
    await waitFor(() => expect(shownStatus(container)[0]!.getAttribute('aria-label')).not.toBe(WORKING))
    expect(shownStatus(container)).toHaveLength(1)
    expect(shownStatus(container)[0]!.textContent).toContain(WORKING)
  })

  test('local model load progress: a wait frame and the renderer-side load bar', async () => {
    startTurn()
    const { container } = render(thread([userMessage('u1', 'hi'), agent('partial', { running: true })]))

    await screen.findByText('partial')

    act(() => setSessionProviderWait(SESSION, '⏳ loading qwen-7b into memory — 40%'))
    await screen.findByText(copy.loadingLocalModel('qwen-7b'))
    expect(shownStatus(container)[0]!.textContent).toContain('40%')
    expect(shownStatus(container)[0]!.textContent).toContain(WORKING)

    // No frame from the backend: the row polls the local server for the current model's load.
    act(() => setSessionProviderWait(SESSION, ''))
    vi.mocked(getLocalModelsStatus).mockResolvedValue({
      loading: { 'llama-3b': { percent: 65, stage: 'tensors', value: 0.65 } }
    } as unknown as LocalModelsStatus)
    act(() => {
      $localModelsEnabled.set(true)
      $currentProvider.set('llamacpp')
      $currentModel.set('llama-3b')
    })

    await screen.findByText(copy.loadingLocalModel('llama-3b'))
    expect(shownStatus(container)).toHaveLength(1)
    expect(shownStatus(container)[0]!.textContent).toContain('65%')
  })

  test('a stopped turn shows the stopped notice in the muted note style, with no line and no caret', async () => {
    const { container } = render(
      thread([userMessage('u1', 'hi'), agent('cut short', { custom: { interrupted: true } })])
    )

    const notice = (await screen.findByText(copy.responseStopped)).closest<HTMLElement>(
      '[data-slot="aui_assistant-message-stopped"]'
    )!

    expect(notice.closest('[data-slot="athena_assistant-message"]')).toBeTruthy()
    expect(getComputedStyle(notice).color).toBe('var(--chat-note-text)')
    expect(getComputedStyle(notice).fontSize).toBe('var(--athena-text-small)')
    expect(shownStatus(container)).toHaveLength(0)
    expect(caretHosts()).toHaveLength(0)
  })
})

describe('reduced motion', () => {
  beforeEach(() => build('athena'))

  test('nothing pulses: the caret takes its animation from a variable the reduced-motion query clears', () => {
    const rules = [...sheet.sheet!.cssRules]

    const reduced = rules.filter(
      (rule): rule is CSSMediaRule =>
        rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion: reduce')
    )

    expect(reduced).toHaveLength(1)

    const reducedRules = styleRules(reduced[0]!.cssRules)
    const cleared = reducedRules.find(rule => rule.selectorText === '[data-athena-chat]')

    expect(cleared?.style.getPropertyValue('--athena-caret-animation').trim()).toBe('none')

    // Every animation the layout declares outside that query is the caret's variable, so the query stops them all;
    // the step's shimmer (an upstream class) is stopped inside it.
    const animated = styleRules(sheet.sheet!.cssRules).filter(rule =>
      ['animation', 'animation-name'].some(name => rule.style.getPropertyValue(name))
    )

    expect(animated.length).toBeGreaterThan(0)

    for (const rule of animated) {
      expect(rule.style.getPropertyValue('animation').trim(), rule.selectorText).toBe('var(--athena-caret-animation)')
    }

    const shimmer = reducedRules.find(rule => rule.selectorText.includes('.shimmer'))

    expect(shimmer?.style.getPropertyValue('animation').trim()).toBe('none')
  })

  test('the status pulse does not play when the system asks for reduced motion', async () => {
    const played: Keyframe[][] = []

    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn()
      }))
    )
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value(keyframes: Keyframe[]) {
        played.push(keyframes)

        return { cancel: vi.fn() } as unknown as Animation
      },
      writable: true
    })

    try {
      startTurn()
      const { container } = render(thread([userMessage('u1', 'hi'), agent('streaming', { running: true })]))

      await screen.findByText('streaming')
      expect(shownStatus(container)).toHaveLength(1)
      expect(played).toHaveLength(0)
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'animate')
    }
  })
})

describe('the running turn with the Athena layout off', () => {
  test.each([
    ['row F15 off', () => build('athena', { F15: 'off' })],
    ['a stock build (no snapshot)', () => build(null)],
    ['a stock snapshot', () => build('stock')]
  ])('%s: upstream status rows, no lead and no caret', async (_name, setUp) => {
    setUp()
    startTurn()
    const { container } = render(thread([userMessage('u1', 'hi'), agent('upstream stream', { running: true })]))

    await screen.findByText('upstream stream')

    // Upstream's activity row waits out its quiet window while text flows, then shows without the Athena lead.
    expect(shownStatus(container)).toHaveLength(0)
    await waitFor(() => expect(shownStatus(container)).toHaveLength(1), { timeout: 4_000 })
    expect(container.querySelector('[data-slot="athena_status-lead"]')).toBeNull()
    expect(container.textContent).not.toContain(WORKING)
    expect(container.querySelector('[data-athena-chat]')).toBeNull()
    expect(caretHosts()).toHaveLength(0)
  })
})
