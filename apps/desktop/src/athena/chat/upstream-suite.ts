/**
 * F15: run an upstream thread test file unchanged against the Athena chat layout (plan Risks: behaviour drift). The
 * upstream file is imported, not copied, so its cases register in the importing test file and run with the Athena
 * variant active; feature row F15 is on by default (no client config: every row allowed).
 *
 * Each case also checks that the user message it rendered was the Athena one, so a suite can't pass vacuously on
 * upstream's bubble: every user bubble mounted during a case must be the Athena one (an edit case replaces it with
 * the composer, so this watches mounts rather than the page at the end), and across the file at least one Athena
 * user message must have mounted.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'

import { setAthenaBrandForTests } from '../brand-text'

/** The Athena user message's own slot (athena-user-message.tsx). */
const ATHENA_USER = '[data-slot="athena_user-message"]'
/** Upstream's bubble wrapper, which the Athena message keeps; without the Athena slot inside it is upstream's bubble. */
const USER_BUBBLE = '[data-slot="aui_user-bubble-actions"]'

const within = (root: Element, selector: string) => [
  ...(root.matches(selector) ? [root] : []),
  ...root.querySelectorAll(selector)
]

export async function runUpstreamSuiteInAthenaLayout(load: () => Promise<unknown>): Promise<void> {
  setAthenaBrandForTests(true)
  beforeAll(() => setAthenaBrandForTests(true))
  afterAll(() => setAthenaBrandForTests(null))

  await load()

  let athenaMounts = 0
  let upstreamMounts = 0
  let observer: MutationObserver | null = null

  const count = (records: MutationRecord[]) => {
    for (const node of records.flatMap(record => [...record.addedNodes])) {
      if (node instanceof Element) {
        athenaMounts += within(node, ATHENA_USER).length
        upstreamMounts += within(node, USER_BUBBLE).filter(bubble => !bubble.querySelector(ATHENA_USER)).length
      }
    }
  }

  beforeEach(() => {
    upstreamMounts = 0
    observer = new MutationObserver(count)
    observer.observe(window.document.body, { childList: true, subtree: true })
  })

  afterEach(() => {
    count(observer?.takeRecords() ?? [])
    observer?.disconnect()
    expect(upstreamMounts, 'an upstream user bubble mounted in the Athena layout').toBe(0)
  })

  afterAll(() => {
    expect(athenaMounts, 'no case mounted the Athena user message').toBeGreaterThan(0)
  })
}
