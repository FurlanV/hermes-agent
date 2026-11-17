/**
 * F15 slice 14: a long transcript (300 turns of prompts, code, tool calls and notes) in the Athena layout behaves as
 * it does upstream (plan Risks: performance). The list's virtualisation has no height estimates in JS: every row
 * carries upstream's `contain-intrinsic-size: auto 37.5rem` placeholder, older rows `content-visibility: auto`, the
 * live tail none, and the render budget counts message parts, not pixels. So the Athena rows must come out of the
 * same budget, the same virtualisation and the same scroll, timeline and sticky-clip paths as upstream's, and a
 * streamed delta must cost the same renders.
 *
 * jsdom has no layout: scroll sizes and boxes are stubbed the way upstream's long-transcript tests stub them
 * (`list-session-scroll.test.tsx`, `timeline-position.test.tsx`, `use-sticky-prompt-clip.test.tsx`). Paint can't be
 * measured here; `<Profiler>` commit counts and render counts can.
 */
import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { act, cleanup, render } from '@testing-library/react'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { createTimelinePositionReader } from '@/components/assistant-ui/thread/timeline-position'
import type * as messageReactions from '@/components/assistant-ui/thread/use-message-reactions'
import { PaneLifecycleContext, PaneVisibleContext } from '@/components/pane-shell/pane-visibility'
import { rescopeConnectionScopedStores } from '@/lib/connection-scoped'
import { setActiveProfile } from '@/store/profile'
import { requestScrollToBottom, saveThreadScrollPosition } from '@/store/thread-scroll'

import { installFeaturePolicy } from '../managed/feature-policy'

import {
  agent,
  backgroundNote,
  call,
  clearBuild,
  selectBuild,
  text,
  userMessage
} from './fixtures/acceptance-transcript'
import type * as layout from './layout'
import { ATHENA_CHAT_ATTR, athenaMessageComponents } from './layout'

// The choke point calls this once per new message map, so a call is a new map identity (as in layout.test.tsx).
vi.mock('./layout', async importOriginal => {
  const actual = await importOriginal<typeof layout>()

  return { ...actual, athenaMessageComponents: vi.fn(actual.athenaMessageComponents) }
})

// Every user and agent message root (upstream's, which the Athena ones keep inside) calls this once per render, so a
// call is a message-root render (the counter upstream's stream-settled-renders.test.tsx uses).
const rootRenders = new Map<string, number>()

vi.mock('@/components/assistant-ui/thread/use-message-reactions', async importActual => {
  const actual = await importActual<typeof messageReactions>()

  return {
    ...actual,
    useMessageReactions: (messageId: string, role: 'assistant' | 'user') => {
      rootRenders.set(messageId, (rootRenders.get(messageId) ?? 0) + 1)

      return actual.useMessageReactions(messageId, role)
    }
  }
})

stubThreadEnvironment()
stubThreadViewportSize()

const CLIENT_H = 600
const SCROLL_H = 60_000
let scrollHeight = SCROLL_H

Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight })
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => CLIENT_H })

// Highlighted fences swap the code plugin in once it loads; load it first so that one-off re-render lands while rows
// settle, not inside a measured window (as stream-settled-renders.test.tsx does).
beforeAll(async () => {
  await import('@streamdown/code')
})

// ---- the layout ----

type Layout = 'athena' | 'upstream'

/** The Athena variant with row F15 on (the Athena layout) or off (upstream's layout). */
function selectLayout(name: Layout) {
  selectBuild('athena', name === 'athena' ? {} : { F15: 'off' })
}

let uninstall: () => void

beforeEach(() => {
  scrollHeight = SCROLL_H
  window.localStorage.clear()
  setActiveProfile('default')
  rescopeConnectionScopedStores(null)
  uninstall = installFeaturePolicy()
  rootRenders.clear()
  vi.mocked(athenaMessageComponents).mockClear()
})

afterEach(() => {
  cleanup()
  uninstall()
  clearBuild()
})

// ---- the fixed transcript ----

const TURNS = 300
const DELIVERY = 'Message from 🤖 Scout (@scout): the build is green'
const readFile = (id: string, path: string) => call(id, 'read_file', { path }, { content: 'ok' })
const note = (id: string) => backgroundNote(id)

/** Turn `i` of session `key`: a prompt (some with code; every 25th an inter-agent delivery, a note), an agent reply
 *  with a code fence and two tool calls, and every 10th turn a background-result note. */
function turn(key: string, i: number): ThreadMessage[] {
  const prompt =
    i % 25 === 12
      ? userMessage(`d-${key}-${i}`, DELIVERY)
      : userMessage(`u-${key}-${i}`, i % 7 ? `prompt ${i} in ${key}` : `prompt ${i}:\n\`\`\`py\nprint(${i})\n\`\`\``)

  return [
    prompt,
    agent(`a-${key}-${i}`, [
      text(`answer ${i} in ${key}\n\n\`\`\`ts\nconst n = ${i}\n\`\`\`\n\nReading the files.`),
      readFile(`r-${key}-${i}-1`, `/repo/${i}/a.ts`),
      readFile(`r-${key}-${i}-2`, `/repo/${i}/b.ts`),
      text(`Done with ${i}.`)
    ]),
    ...(i % 10 === 9 ? [note(`s-${key}-${i}`)] : [])
  ]
}

const histories = new Map<string, ThreadMessage[]>()

/** The settled history of session `key` (the same objects on every call, as the store keeps settled rows). */
function history(key: string): ThreadMessage[] {
  let rows = histories.get(key)

  if (!rows) {
    rows = Array.from({ length: TURNS }, (_, i) => turn(key, i)).flat()
    histories.set(key, rows)
  }

  return rows
}

const livePrompt = new Map<string, ThreadMessage>()

/** Session `key` with a live turn at the tail: the agent streaming `body`. */
function streaming(key: string, body: string): ThreadMessage[] {
  const prompt = livePrompt.get(key) ?? userMessage(`u-${key}-live`, `live question in ${key}`)

  livePrompt.set(key, prompt)

  return [...history(key), prompt, agent(`a-${key}-live`, [text(body)], { type: 'running' })]
}

// ---- the harness ----

interface HarnessProps {
  messages: ThreadMessage[]
  onRender?: ProfilerOnRenderCallback
  sessionKey: string
}

function Harness({ messages, onRender = () => {}, sessionKey }: HarnessProps) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages,
    isRunning: messages.at(-1)?.status?.type === 'running',
    onNew: async () => {}
  })

  return (
    <Profiler id="thread" onRender={onRender}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread sessionId={sessionKey} sessionKey={sessionKey} />
      </AssistantRuntimeProvider>
    </Profiler>
  )
}

/** A kept-alive pane: visible, or hot-hidden as the outgoing session of a switch is. */
const Pane = ({ visible, ...props }: HarnessProps & { visible: boolean }) => (
  <PaneVisibleContext.Provider value={visible}>
    <PaneLifecycleContext.Provider value={visible ? 'visible' : 'hot-hidden'}>
      <Harness {...props} />
    </PaneLifecycleContext.Provider>
  </PaneVisibleContext.Provider>
)

const GROUP = '[data-slot="aui_message-group"]'
const groups = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>(GROUP)]
const viewportOf = (root: ParentNode) => root.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')!
const renderTotal = () => [...rootRenders.values()].reduce((sum, n) => sum + n, 0)

async function ticks(count: number) {
  await act(async () => {
    for (let tick = 0; tick < count; tick += 1) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 0))
    }
  })
}

/** Until the stepped first paint and backfill have finished and no row renders any more. */
async function settle(root: ParentNode) {
  for (let round = 0, last = ''; round < 60; round += 1) {
    await ticks(10)
    const now = `${groups(root).length}:${renderTotal()}`

    if (now === last) {
      return
    }

    last = now
  }
}

/** What the list decided per mounted row: virtualised (`content-visibility: auto`) or not, and its placeholder. */
const rowShape = (root: ParentNode) =>
  groups(root).map(row => ({
    placeholder: row.className.includes('[contain-intrinsic-size:auto_37.5rem]'),
    virtualized: row.className.includes('[content-visibility:auto]')
  }))

async function mount(name: Layout, props: Omit<HarnessProps, 'sessionKey'> & { sessionKey?: string }) {
  selectLayout(name)
  const ui = render(<Harness sessionKey="long" {...props} />)

  await settle(ui.container)
  expect(ui.container.querySelector('[data-slot="thread"]')?.hasAttribute(ATHENA_CHAT_ATTR)).toBe(name === 'athena')

  return ui
}

// ---- first paint ----

describe('a long transcript in the Athena layout: first paint', () => {
  test("mounts the same budgeted window, virtualised and placeheld as upstream's, with the Athena messages", async () => {
    const upstream = await mount('upstream', { messages: history('long') })
    const upstreamShape = rowShape(upstream.container)

    cleanup()
    const athena = await mount('athena', { messages: history('long') })
    const shape = rowShape(athena.container)
    const root = athena.container

    // The render budget cut older turns behind "Show earlier": a long transcript, not the whole history.
    expect(shape.length).toBeGreaterThan(8)
    expect(shape.length).toBeLessThan(TURNS)
    // The same rows, each carrying upstream's placeholder, the same ones virtualised (the live tail exempt).
    expect(shape).toEqual(upstreamShape)
    expect(shape.every(row => row.placeholder)).toBe(true)
    expect(shape.at(-1)?.virtualized).toBe(false)
    expect(shape.some(row => row.virtualized)).toBe(true)
    // ... and they are the Athena rows: bubbles, agent blocks with code and tool rows, notes.
    expect(root.querySelectorAll('[data-slot="athena_user-message"]').length).toBeGreaterThan(0)
    expect(root.querySelectorAll('[data-slot="athena_assistant-message"]').length).toBeGreaterThan(0)
    expect(root.querySelectorAll('[data-athena-note]').length).toBeGreaterThan(0)
    expect(root.querySelectorAll('[data-slot="code-card"]').length).toBeGreaterThan(0)
    expect(
      [...root.querySelectorAll('[data-slot="aui_assistant-message-root"]')].every(el =>
        el.parentElement?.matches('[data-slot="athena_assistant-message"]')
      )
    ).toBe(true)
  })
})

// ---- stick to bottom while streaming ----

type FakeObserver = { callback: ResizeObserverCallback; targets: Set<Element> }

/** A ResizeObserver the test drives: deliver a content resize the way a streamed chunk's growth does. */
function driveResizes() {
  const observers = new Set<FakeObserver>()

  vi.stubGlobal(
    'ResizeObserver',
    class {
      targets = new Set<Element>()
      constructor(public callback: ResizeObserverCallback) {
        observers.add(this)
      }
      observe(target: Element) {
        this.targets.add(target)
      }
      unobserve(target: Element) {
        this.targets.delete(target)
      }
      disconnect() {
        this.targets.clear()
      }
    }
  )

  return () => {
    for (const observer of observers) {
      const targets = [...observer.targets].filter(el => el.getAttribute('data-slot') === 'aui_thread-content')

      if (targets.length) {
        observer.callback(
          targets.map(target => ({ target, contentRect: { height: scrollHeight } })) as ResizeObserverEntry[],
          observer as unknown as ResizeObserver
        )
      }
    }
  }
}

describe('a long transcript in the Athena layout: scrolling', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('stays stuck to the bottom while the tail streams, and lets a reader who scrolled up stay put', async () => {
    stubThreadEnvironment()
    const deliverResize = driveResizes()
    let body = 'tok0'
    const ui = await mount('athena', { messages: streaming('long', body) })
    const viewport = viewportOf(ui.container)

    expect(viewport.scrollTop).toBeGreaterThanOrEqual(scrollHeight - CLIENT_H - 1)
    // Hold the library's follow frame so the resize leg is the only writer (as upstream's #118482 test does).
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 0)

    try {
      for (const [chunk, growth] of [120, 240, 168, 300].entries()) {
        body = `${body} tok${chunk + 1}`
        ui.rerender(<Harness messages={streaming('long', body)} sessionKey="long" />)
        scrollHeight += growth
        act(deliverResize)

        expect(viewport.scrollTop).toBe(scrollHeight - CLIENT_H)
      }

      const reading = scrollHeight - CLIENT_H - 2_000

      act(() => {
        viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -160 }))
        viewport.scrollTop = reading
        viewport.dispatchEvent(new Event('scroll'))
      })
      act(() => {
        scrollHeight += 400
        deliverResize()
      })

      expect(viewport.scrollTop).toBe(reading)
    } finally {
      raf.mockRestore()
    }

    // The deltas reached the tail (the follow above was not vacuous).
    expect(await ui.findByText(body)).toBeTruthy()
  })

  test('scrolls to the top and back to the bottom, and restores a reading offset after a session switch', async () => {
    saveThreadScrollPosition('a', { fromBottom: 3_000, kind: 'offset' })
    const ui = await mount('athena', { messages: history('a'), sessionKey: 'a' })
    const viewport = viewportOf(ui.container)

    expect(viewport.scrollTop).toBe(SCROLL_H - 3_000 - CLIENT_H)

    // To the top, as a reader wheels there, and back with the jump-to-latest button.
    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -160 }))
      viewport.scrollTop = 0
      viewport.dispatchEvent(new Event('scroll'))
    })
    await ticks(5)
    expect(viewport.dataset.following).toBe('false')
    act(() => requestScrollToBottom('a'))
    await ticks(10)
    expect(viewport.scrollTop).toBe(SCROLL_H - CLIENT_H)

    // A reading offset survives switching to another long session and back.
    const reading = SCROLL_H - CLIENT_H - 5_000

    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -160 }))
      viewport.scrollTop = reading
      viewport.dispatchEvent(new Event('scroll'))
    })
    await ticks(5)
    ui.rerender(<Harness messages={history('b')} sessionKey="b" />)
    await settle(ui.container)
    expect(viewportOf(ui.container).scrollTop).toBe(SCROLL_H - CLIENT_H)

    ui.rerender(<Harness messages={history('a')} sessionKey="a" />)
    await settle(ui.container)
    expect(viewportOf(ui.container).scrollTop).toBe(reading)
  })
})

// ---- timeline and sticky prompt clip ----

const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

describe('a long transcript in the Athena layout: timeline and sticky prompt', () => {
  afterEach(() => vi.restoreAllMocks())

  test("the timeline reads each prompt's position from its outer row, never from inside the Athena message", async () => {
    const ui = await mount('athena', { messages: history('long') })
    const viewport = viewportOf(ui.container)
    const rows = groups(ui.container)
    const ROW_H = 500

    // The prompts the rail lists (user rows; agent roots carry a message id too), in transcript order.
    const prompts = [...viewport.querySelectorAll<HTMLElement>('[data-message-id][data-role="user"]')]
    const indexes = new Map(prompts.map((node, index) => [node.dataset.messageId!, index]))

    expect(prompts.length).toBeGreaterThan(8)
    expect(prompts.filter(node => node.querySelector('[data-slot="athena_user-message"]')).length).toBeGreaterThan(0)

    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(0, CLIENT_H))

    const outerReads = rows.map((row, index) =>
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => rect(index * ROW_H - viewport.scrollTop, ROW_H))
    )

    const innerReads = [
      ...viewport.querySelectorAll<HTMLElement>(
        '[data-slot="athena_user-message"], [data-slot="athena_assistant-message"], [data-athena-note]'
      )
    ].map(el => vi.spyOn(el, 'getBoundingClientRect'))

    const position = createTimelinePositionReader(viewport, indexes)
    const rowOf = (prompt: number) => rows.indexOf(prompts[prompt]!.closest<HTMLElement>(GROUP)!)

    for (const prompt of [prompts.length - 1, 0, Math.floor(prompts.length / 2), 3]) {
      outerReads.forEach(spy => spy.mockClear())
      viewport.scrollTop = rowOf(prompt) * ROW_H + 20

      expect(position.read()).toBe(prompt)
      expect(outerReads.filter(spy => spy.mock.calls.length).length).toBeLessThanOrEqual(
        Math.ceil(Math.log2(prompts.length)) + 1
      )
    }

    expect(innerReads.every(spy => spy.mock.calls.length === 0)).toBe(true)
  })

  test('the pinned prompt clips the agent block it covers, and keeps the Athena bubble and its label whole', async () => {
    const ui = await mount('athena', { messages: history('long') })
    const viewport = viewportOf(ui.container)
    const rows = groups(ui.container)
    // The newest full turn: its prompt is pinned at the top, its reply scrolled up under it.
    const row = rows.findLast(r => r.querySelector('[data-slot="athena_user-message"]'))!
    const prompt = row.querySelector<HTMLElement>('[data-slot="aui_user-message-root"]')!
    const reply = row.querySelector<HTMLElement>('[data-slot="athena_assistant-message"]')!

    // Everything else keeps jsdom's empty box: off screen for the clip.
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(0, CLIENT_H))
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect(-100, 900))
    vi.spyOn(prompt, 'getBoundingClientRect').mockReturnValue(rect(0, 80))

    for (let el: HTMLElement | null = reply; el && el !== row; el = el.parentElement) {
      if (!el.contains(prompt)) {
        vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(-20, 700))
      }
    }

    // A commit reconciles the clip (the list's layout effect); a streamed tail is one.
    ui.rerender(<Harness messages={[...history('long'), userMessage('u-long-next', 'next')]} sessionKey="long" />)
    await ticks(5)

    const clipped = [...row.querySelectorAll<HTMLElement>('[data-sticky-prompt-clip]')]

    expect(clipped.length).toBeGreaterThan(0)
    expect(clipped.some(el => el.contains(reply) || reply.contains(el) || el === reply)).toBe(true)
    expect(clipped.some(el => el.contains(prompt) || prompt.contains(el))).toBe(false)
    expect(prompt.querySelector('[data-slot="athena_user-label"]')).not.toBeNull()
  })
})

// ---- session switch ----

describe('a long transcript in the Athena layout: session switch', () => {
  test('switching away keeps the outgoing transcript mounted and the message map, as upstream does', async () => {
    const counts: Record<Layout, { remounted: number; mapCalls: number }> = {
      athena: { mapCalls: 0, remounted: 0 },
      upstream: { mapCalls: 0, remounted: 0 }
    }

    for (const name of ['upstream', 'athena'] as const) {
      cleanup()
      vi.mocked(athenaMessageComponents).mockClear()
      selectLayout(name)

      const panes = (active: 'a' | 'b') => (
        <>
          <Pane messages={history('a')} sessionKey="a" visible={active === 'a'} />
          <Pane messages={history('b')} sessionKey="b" visible={active === 'b'} />
        </>
      )

      const ui = render(panes('a'))

      await settle(ui.container)
      const [paneA] = [...ui.container.querySelectorAll<HTMLElement>('[data-slot="thread"]')]

      // The tail of A, which every budget keeps mounted (the live tail; a hidden pane keeps it too).
      const tail = [
        ...paneA!.querySelectorAll<HTMLElement>('[data-message-id], [data-slot="aui_assistant-message-root"]')
      ].slice(-6)

      const mapCalls = vi.mocked(athenaMessageComponents).mock.calls.length
      let mounted = 0

      const observer = new MutationObserver(records => {
        for (const node of records.flatMap(record => [...record.addedNodes])) {
          if (node instanceof Element && paneA!.contains(node)) {
            mounted += node.querySelectorAll('[data-slot="aui_assistant-message-root"]').length
          }
        }
      })

      observer.observe(paneA!, { childList: true, subtree: true })
      ui.rerender(panes('b'))
      await settle(ui.container)
      ui.rerender(panes('a'))
      await settle(ui.container)
      observer.disconnect()

      // Away and back: A's tail is the same DOM, never remounted, and neither pane minted a new message map.
      expect(tail.every(node => node.isConnected)).toBe(true)
      counts[name] = { mapCalls: vi.mocked(athenaMessageComponents).mock.calls.length - mapCalls, remounted: mounted }
    }

    expect(counts.athena.mapCalls).toBe(0)
    expect(counts.upstream.mapCalls).toBe(0)
    // Hiding A trims it to the hidden budget and revealing it backfills, upstream's own paging: the same rows
    // remount in both layouts, and none of them is the tail.
    expect(counts.athena.remounted).toBe(counts.upstream.remounted)
  }, 60_000)
})

// ---- render cost ----

interface Cost {
  commits: number
  ms: number
  roots: number
}

describe('a long transcript in the Athena layout: render cost', () => {
  test('a first mount, a streamed delta and a session switch cost the same commits and message renders as upstream', async () => {
    const cost: Partial<Record<Layout, Record<'delta' | 'mount' | 'switch', Cost>>> = {}

    // Each layout twice, keeping the second (warm) pass: the first mount of the file pays one-off lazy loads.
    for (const name of ['upstream', 'athena', 'upstream', 'athena'] as const) {
      cleanup()
      rootRenders.clear()
      let commits = 0
      let ms = 0

      const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
        commits += 1
        ms += actualDuration
      }

      const measure = async (run: () => Promise<void> | void): Promise<Cost> => {
        const before = { commits, ms, roots: renderTotal() }

        await run()

        // Until no late commit (a highlighted fence, a measured row) lands any more.
        for (let last = -1; last !== commits;) {
          last = commits
          await ticks(10)
        }

        return { commits: commits - before.commits, ms: ms - before.ms, roots: renderTotal() - before.roots }
      }

      let ui!: ReturnType<typeof render>

      const mountCost = await measure(async () => {
        ui = await mount(name, { messages: streaming('long', 'tok0'), onRender })
      })

      const deltaCost = await measure(async () => {
        await act(async () => {
          ui.rerender(<Harness messages={streaming('long', 'tok0 tok1')} onRender={onRender} sessionKey="long" />)
        })
      })

      const switchCost = await measure(async () => {
        ui.rerender(<Harness messages={history('b')} onRender={onRender} sessionKey="b" />)
        await settle(ui.container)
      })

      cost[name] = { delta: deltaCost, mount: mountCost, switch: switchCost }
    }

    if (process.env.ATHENA_PERF_LOG) {
      console.info(`[f15-14] ${JSON.stringify(cost)}`)
    }

    const { athena, upstream } = cost as Required<typeof cost>

    // One streamed delta commits (the tail's text leaf) without re-rendering any message root, as upstream.
    expect(athena.delta.commits).toBeGreaterThan(0)
    expect(athena.delta.roots).toBe(0)
    expect(upstream.delta.roots).toBe(0)
    expect(athena.delta.commits).toBe(upstream.delta.commits)
    // Mount and switch go through the same stepped first paint and backfill.
    expect(athena.mount.commits).toBe(upstream.mount.commits)
    expect(athena.switch.commits).toBe(upstream.switch.commits)
    expect(athena.mount.roots).toBe(upstream.mount.roots)
    expect(athena.switch.roots).toBe(upstream.switch.roots)
  }, 60_000)
})
