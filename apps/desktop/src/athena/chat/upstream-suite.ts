/**
 * F15: run an upstream thread test file unchanged against the Athena chat layout (plan Risks: behaviour drift). The
 * upstream file is imported, not copied, so its cases register in the importing test file and run with the Athena
 * variant active; feature row F15 is on by default (no client config: every row allowed).
 *
 * Each case also checks that the messages it rendered were the Athena ones, so a suite can't pass vacuously on
 * upstream's: every user bubble, every agent message and every note mounted during a case must be the Athena one (an
 * edit case replaces the bubble with the composer, so this watches mounts rather than the page at the end), and
 * across the file at least one Athena message of each kind in `expects` (default: the user message) must have
 * mounted.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'

import { setAthenaBrandForTests } from '../brand-text'

type Watched = 'assistant' | 'note' | 'user'

/**
 * Per kind: the Athena message's own slot, and a test telling an upstream element of that kind that is not inside
 * the Athena one. The user side: upstream's bubble wrapper, which the Athena message keeps (athena-user-message.tsx);
 * without the Athena slot inside it is upstream's bubble. The agent side: upstream's message root, which the Athena
 * message wraps (athena-assistant-message.tsx); without the Athena wrapper as its parent it is upstream's message.
 * The note side: upstream's system rows, delivery notes and background results, which the Athena note container
 * wraps (athena-system-message.tsx); outside one they are upstream's.
 */
const WATCHED: Readonly<Record<Watched, { athena: string; upstream: string; isUpstream: (el: Element) => boolean }>> = {
  assistant: {
    athena: '[data-slot="athena_assistant-message"]',
    upstream: '[data-slot="aui_assistant-message-root"]',
    isUpstream: root => !root.parentElement?.matches('[data-slot="athena_assistant-message"]')
  },
  note: {
    athena: '[data-athena-note]',
    upstream: '[data-role="system"], [data-slot="aui_agent-message-note"], [data-slot="aui_background-result"]',
    isUpstream: note => !note.closest('[data-athena-note]')
  },
  user: {
    athena: '[data-slot="athena_user-message"]',
    upstream: '[data-slot="aui_user-bubble-actions"]',
    isUpstream: bubble => !bubble.querySelector('[data-slot="athena_user-message"]')
  }
}

const KINDS = Object.keys(WATCHED) as Watched[]

const within = (root: Element, selector: string) => [
  ...(root.matches(selector) ? [root] : []),
  ...root.querySelectorAll(selector)
]

const zero = (): Record<Watched, number> => ({ assistant: 0, note: 0, user: 0 })

export async function runUpstreamSuiteInAthenaLayout(
  load: () => Promise<unknown>,
  { expects = ['user'] }: { expects?: readonly Watched[] } = {}
): Promise<void> {
  setAthenaBrandForTests(true)
  beforeAll(() => setAthenaBrandForTests(true))
  afterAll(() => setAthenaBrandForTests(null))

  await load()

  const athenaMounts = zero()
  let upstreamMounts = zero()
  let observer: MutationObserver | null = null

  const count = (records: MutationRecord[]) => {
    for (const node of records.flatMap(record => [...record.addedNodes])) {
      if (node instanceof Element) {
        for (const kind of KINDS) {
          const { athena, isUpstream, upstream } = WATCHED[kind]

          athenaMounts[kind] += within(node, athena).length
          upstreamMounts[kind] += within(node, upstream).filter(isUpstream).length
        }
      }
    }
  }

  beforeEach(() => {
    upstreamMounts = zero()
    observer = new MutationObserver(count)
    observer.observe(window.document.body, { childList: true, subtree: true })
  })

  afterEach(() => {
    count(observer?.takeRecords() ?? [])
    observer?.disconnect()
    expect(upstreamMounts.user, 'an upstream user bubble mounted in the Athena layout').toBe(0)
    expect(upstreamMounts.assistant, 'an upstream agent message mounted in the Athena layout').toBe(0)
    expect(upstreamMounts.note, 'an upstream note mounted in the Athena layout').toBe(0)
  })

  afterAll(() => {
    for (const kind of expects) {
      expect(athenaMounts[kind], `no case mounted the Athena ${kind} message`).toBeGreaterThan(0)
    }
  })
}
