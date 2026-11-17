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
import { en } from '@/i18n/en'

import type { ClientConfigSnapshot } from '../managed/client-config'
import { $clientConfig } from '../managed/client-config'
import { installFeaturePolicy } from '../managed/feature-policy'

import { ATHENA_CHAT_ATTR } from './layout'

stubThreadViewportSize()

const SHELL = '[data-athena-code-block]'
const HEADER = '[data-slot="athena_code-header"]'
const LANGUAGE = '[data-slot="athena_code-language"]'
const CARD = '[data-slot="code-card"]'
const BODY = '[data-slot="code-card-body"]'
const COPY_CODE = en.assistant.tool.copyCode

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
  stubThreadEnvironment()
  uninstall = installFeaturePolicy()
})

afterEach(() => {
  cleanup()
  uninstall()
  $clientConfig.set(null)
  delete (window as Bridge).athenaDesktop
  vi.unstubAllGlobals()
})

function agent(id: string, text: string, running = false): ThreadMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
  } as ThreadMessage
}

const renderThread = (messages: ThreadMessage[]) =>
  render(
    <ThreadRuntime messages={messages}>
      <Thread />
    </ThreadRuntime>
  )

const CODE = 'const answer = 42\n  console.log(answer) // a long line that must scroll sideways rather than wrap'
const fence = (language: string, code = CODE) => `Here it is:\n\n\`\`\`${language}\n${code}\n\`\`\`\n\nDone.`

/** The one code block in the rendered thread, once it has mounted. */
async function codeBlock(container: HTMLElement, selector = CARD) {
  await waitFor(() => expect(container.querySelector(selector)).toBeTruthy())

  return container.querySelector<HTMLElement>(selector)!
}

describe('the Athena code block (layout on)', () => {
  beforeEach(() => build('athena'))

  test('a fenced block in an agent message has its own surface, a language header and Copy', async () => {
    const { container } = renderThread([userMessage('user-1', 'show me'), agent('assistant-1', fence('ts'))])

    const block = await codeBlock(container, SHELL)
    const header = block.querySelector<HTMLElement>(`:scope > ${HEADER}`)!
    const style = getComputedStyle(block)

    expect(block.closest('[data-slot="athena_assistant-message"]')).toBeTruthy()
    // Upstream's card underneath, so upstream's rhythm, streaming and HUD rules keep finding it.
    expect(block.dataset.slot).toBe('code-card')
    expect(style.backgroundColor).toBe('var(--chat-code-surface)')
    // (jsdom drops a var() border colour; the declaration is `border-color: var(--chat-code-border)`.)
    expect([style.borderTopWidth, style.borderTopStyle]).toEqual(['1px', 'solid'])
    expect(style.borderRadius).toBe('12px')
    expect(style.direction).toBe('ltr')
    expect(
      container.querySelector<HTMLElement>(`[${ATHENA_CHAT_ATTR}]`)!.style.getPropertyValue('--chat-code-surface')
    ).toMatch(/^#[0-9a-f]{6}$/)

    // Header first: the language, then Copy; the highlighted body after it.
    expect(block.firstElementChild).toBe(header)
    expect(header.querySelector(LANGUAGE)?.textContent).toBe('ts')
    expect(within(header).getByRole('button', { name: COPY_CODE }).textContent).toBe(en.common.copy)
    expect(block.lastElementChild?.matches(BODY)).toBe(true)
    expect(block.textContent).toContain('console.log(answer)')

    // Upstream's hover-reveal corner Copy is not rendered next to the header's.
    expect(within(block).getAllByRole('button', { name: COPY_CODE })).toHaveLength(1)

    // Monospace at 0.86em, no wrapping (the body scrolls sideways).
    const body = block.querySelector<HTMLElement>(BODY)!

    expect(getComputedStyle(body).fontSize).toBe('0.86em')
    expect(body.classList.contains('font-mono')).toBe(true)

    for (const el of block.querySelectorAll<HTMLElement>('pre, code')) {
      expect(getComputedStyle(el).whiteSpace).toBe('pre')
    }

    expect(body.querySelector('.overflow-x-auto')).toBeTruthy()
  })

  test('a block with no language shows a plain header with Copy only', async () => {
    const { container } = renderThread([userMessage('user-1', 'show me'), agent('assistant-1', fence(''))])

    const header = (await codeBlock(container, SHELL)).querySelector<HTMLElement>(HEADER)!

    expect(header.querySelector(LANGUAGE)).toBeNull()
    expect(within(header).getAllByRole('button')).toHaveLength(1)
    expect(within(header).getByRole('button', { name: COPY_CODE })).toBeTruthy()
  })

  test('Copy puts exactly the block text on the clipboard, and is a native, focusable, visible button', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }

    vi.stubGlobal('navigator', { ...navigator, clipboard })
    const { container } = renderThread([userMessage('user-1', 'show me'), agent('assistant-1', fence('ts'))])

    const copy = within(await codeBlock(container, SHELL)).getByRole('button', { name: COPY_CODE })

    // Keyboard: a native <button> in the tab order (Enter and Space activate it), never hover-only.
    expect(copy.tagName).toBe('BUTTON')
    expect(copy.getAttribute('type')).toBe('button')
    expect(copy.hasAttribute('tabindex')).toBe(false)
    expect(copy.className).not.toMatch(/(^|\s)opacity-0(\s|$)/)
    act(() => copy.focus())
    expect(window.document.activeElement).toBe(copy)

    fireEvent.click(copy)
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1))
    // The fence's payload as the parser hands it, trailing newline included: what upstream's corner Copy copies.
    expect(clipboard.writeText).toHaveBeenLastCalledWith(`${CODE}\n`)
  })

  test('Copy turns a URL reference in the block back into the plain URL, as upstream', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }

    vi.stubGlobal('navigator', { ...navigator, clipboard })

    const { container } = renderThread([
      userMessage('user-1', 'show me'),
      agent('assistant-1', fence('sh', 'curl @url:`https://example.com/a`'))
    ])

    fireEvent.click(within(await codeBlock(container, SHELL)).getByRole('button', { name: COPY_CODE }))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith('curl https://example.com/a\n'))
  })

  test('a streaming reply keeps the same block, header and body nodes across every delta', async () => {
    const prompt = userMessage('user-1', 'stream it')
    const { container, rerender } = renderThread([prompt, agent('assistant-1', '```ts\nconst a = 1\n', true)])

    const block = await codeBlock(container, SHELL)
    const header = block.querySelector(HEADER)
    const body = block.querySelector(BODY)

    expect(block.dataset.streaming).toBe('true')
    expect(block.querySelector(LANGUAGE)?.textContent).toBe('ts')

    const step = async (text: string, running: boolean, line: string) => {
      rerender(
        <ThreadRuntime messages={[prompt, agent('assistant-1', text, running)]}>
          <Thread />
        </ThreadRuntime>
      )
      await waitFor(() => expect(container.textContent).toContain(line))
    }

    const unchanged = () => {
      expect(block.isConnected).toBe(true)
      expect(container.querySelectorAll(SHELL)).toHaveLength(1)
      expect(container.querySelector(SHELL)).toBe(block)
      expect(block.querySelector(HEADER)).toBe(header)
      expect(block.querySelector(BODY)).toBe(body)
      expect(block.dataset.streaming).toBe('true')
    }

    await step('```ts\nconst a = 1\nconst b = 2\n', true, 'const b = 2')
    unchanged()
    await step('```ts\nconst a = 1\nconst b = 2\nconst c = 3\n', true, 'const c = 3')
    unchanged()
    // The fence closes and prose follows, still streaming.
    await step('```ts\nconst a = 1\nconst b = 2\nconst c = 3\n```\n\nAll', true, 'All')
    unchanged()
    expect(block.textContent).toContain('const c = 3')

    // The settle: upstream's markdown surface rebuilds its component map when the part stops running, so its own
    // card remounts there too (layout off alike); the Athena block comes back whole, highlighted and unmarked.
    await step('```ts\nconst a = 1\nconst b = 2\nconst c = 3\n```\n\nAll set.\n', false, 'All set.')
    const settled = container.querySelector<HTMLElement>(SHELL)!

    expect(container.querySelectorAll(SHELL)).toHaveLength(1)
    expect(settled.dataset.streaming).toBeUndefined()
    expect(settled.querySelector(LANGUAGE)?.textContent).toBe('ts')
    expect(settled.textContent).toContain('const c = 3')
  })

  test('a fence in the user bubble has the surface and language header, no Copy inside the bubble button', async () => {
    const { container } = renderThread([userMessage('user-1', 'try this:\n```py\nprint("hi")\n```\nthanks')])

    const block = await codeBlock(container, SHELL)
    const header = block.querySelector<HTMLElement>(HEADER)!
    const fenceEl = block.querySelector<HTMLElement>('[data-slot="aui_user-fence"]')!

    expect(block.closest('[data-slot="athena_user-bubble"]')).toBeTruthy()
    expect(getComputedStyle(block).backgroundColor).toBe('var(--chat-code-surface)')
    expect(header.querySelector(LANGUAGE)?.textContent).toBe('py')
    // The bubble is a button (click to edit): a button inside it would be invalid and steal the edit click.
    expect(block.querySelector('button')).toBeNull()
    expect(fenceEl.textContent).toBe('print("hi")\n')
    expect(getComputedStyle(fenceEl).whiteSpace).toBe('pre')
    expect(getComputedStyle(fenceEl).overflowX).toBe('auto')
    expect(getComputedStyle(fenceEl).fontSize).toBe('0.86em')
  })

  test('a user fence with no language has no header', async () => {
    const { container } = renderThread([userMessage('user-1', '```\nls -la\n```')])

    expect((await codeBlock(container, SHELL)).querySelector(HEADER)).toBeNull()
  })

  test('inline code takes the tint of the surface it sits on, in the full text colour', async () => {
    const { container } = renderThread([
      userMessage('user-1', 'what does `npm test` do?'),
      agent('assistant-1', 'It runs `vitest` once.')
    ])

    const agentCode = (await screen.findByText('vitest')).closest('code')!
    const userCode = container.querySelector<HTMLElement>('[data-slot="aui_user-inline-code"]')!

    expect(getComputedStyle(agentCode).backgroundColor).toBe('var(--chat-inline-code)')
    expect(getComputedStyle(agentCode).color).toBe('var(--dt-foreground)')
    expect(getComputedStyle(userCode).backgroundColor).toBe('var(--chat-user-inline-code)')
    expect(getComputedStyle(userCode).color).toBe('var(--dt-foreground)')
  })
})

describe('the code block with the Athena layout off', () => {
  test.each([
    ['row F15 off', () => build('athena', { F15: 'off' })],
    ['a stock build (no snapshot)', () => build(null)],
    ['a stock snapshot', () => build('stock')]
  ])('%s: upstream card with its corner Copy, and upstream user fence', async (_name, setUp) => {
    setUp()

    const { container } = renderThread([
      userMessage('user-1', 'try this:\n```py\nprint("hi")\n```\nthanks and `inline`'),
      agent('assistant-1', fence('ts'))
    ])

    const card = await codeBlock(container)

    expect(container.querySelector(SHELL)).toBeNull()
    expect(container.querySelector(HEADER)).toBeNull()
    // Upstream's card: the hover-reveal Copy first, then the body; no header row, no language label.
    expect(card.children).toHaveLength(2)
    expect(card.firstElementChild?.getAttribute('aria-label')).toBe(COPY_CODE)
    expect(card.firstElementChild?.className).toContain('opacity-0')
    expect(card.lastElementChild?.matches(BODY)).toBe(true)
    expect(card.textContent).not.toMatch(/^ts/)

    // Upstream's user fence: the bare <pre> inside the message text, wrapping, with no card around it.
    const userFence = container.querySelector<HTMLElement>('[data-slot="aui_user-fence"]')!

    expect(userFence.parentElement?.dataset.slot).toBe('aui_user-message-text')
    expect(userFence.closest(CARD)).toBeNull()
    expect(userFence.className).toContain('whitespace-pre-wrap')
    expect(container.querySelectorAll(CARD)).toHaveLength(1)
  })
})
