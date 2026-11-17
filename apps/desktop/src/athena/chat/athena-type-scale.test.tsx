import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ThreadMessage } from '@assistant-ui/react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createdAt,
  stubThreadEnvironment,
  stubThreadViewportSize,
  ThreadRuntime,
  userMessage
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'

import type { ClientConfigSnapshot } from '../managed/client-config'
import { $clientConfig } from '../managed/client-config'
import { installFeaturePolicy } from '../managed/feature-policy'

import { ATHENA_CHAT_ATTR } from './layout'

stubThreadViewportSize()

// jsdom applies a stylesheet's declarations (unresolved: a var() stays as written, no layout) but vitest loads no
// CSS: inject the Athena one. Assertions read the declared values and the class hooks.
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

const REPLY = [
  '# Title one',
  '## Title two',
  '### Title three',
  '#### Title four',
  '',
  'A paragraph with `inline code`.',
  '',
  '- a list item',
  '- another item',
  '',
  '> a quote',
  '',
  '| Name | A very long column header | Value |',
  '| --- | --- | --- |',
  `| row | ${'wide '.repeat(60)} | 1 |`
].join('\n')

const agent = (id: string, text: string): ThreadMessage =>
  ({
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    status: { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
  }) as ThreadMessage

async function renderReply() {
  const view = render(
    <ThreadRuntime messages={[userMessage('user-1', 'tell me with `code`'), agent('assistant-1', REPLY)]}>
      <Thread />
    </ThreadRuntime>
  )

  await screen.findByText('Title one')
  await waitFor(() => expect(view.container.querySelector('.aui-md-table')).toBeTruthy())

  const q = <T extends HTMLElement = HTMLElement>(selector: string) => view.container.querySelector<T>(selector)!
  const reply = q('[data-slot="aui_assistant-message-content"] > .aui-md')

  return { ...view, q, reply }
}

const size = (el: Element) => getComputedStyle(el).fontSize
const prop = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim()

describe('the Athena type scale (layout on)', () => {
  beforeEach(() => build('athena'))

  test('the chat uses the theme font, and the scale is declared on the thread content from the conversation sizes', async () => {
    const { q } = await renderReply()
    const root = q(`[${ATHENA_CHAT_ATTR}]`)
    const content = q('[data-slot="aui_thread-content"]')

    // The theme's sans stack (the Athena skin's is branding.json `fontStack`), not a hardcoded family.
    expect(getComputedStyle(root).fontFamily).toBe('var(--dt-font-sans)')

    expect(prop(content, '--athena-text-body')).toBe('var(--conversation-text-font-size)')
    expect(prop(content, '--athena-text-small')).toBe('var(--conversation-caption-font-size)')
    expect(prop(content, '--athena-text-h4')).toBe('var(--conversation-text-font-size)')

    for (const step of ['h1', 'h2', 'h3']) {
      expect(prop(content, `--athena-text-${step}`)).toMatch(
        /^calc\(\s*var\(--conversation-text-font-size\)\s*\*\s*[\d.]+\s*\)$/
      )
    }

    expect(prop(content, '--athena-text-code')).toBe('0.86em')
  })

  test('headings, paragraphs, lists, quotes and tables take their size from the scale', async () => {
    const { reply } = await renderReply()
    const one = (selector: string) => reply.querySelector(selector)!

    expect(size(reply)).toBe('var(--athena-text-body)')
    expect(size(one('h1'))).toBe('var(--athena-text-h1)')
    expect(size(one('h2'))).toBe('var(--athena-text-h2)')
    expect(size(one('h3'))).toBe('var(--athena-text-h3)')
    expect(size(one('h4'))).toBe('var(--athena-text-h4)')

    for (const selector of ['p', 'ul', 'li', 'blockquote', 'table', 'td']) {
      expect(size(one(selector)), selector).toBe('var(--athena-text-body)')
    }

    expect(size(one('th'))).toBe('var(--athena-text-small)')
    expect(size(one(':not(pre) > code'))).toBe('var(--athena-text-code)')

    // Every element that carries a text size in the reply has one from the scale (none set outside it).
    for (const el of reply.querySelectorAll('*')) {
      const value = size(el)

      if (value) {
        expect(value, el.tagName).toMatch(/^var\(--athena-text-[a-z0-9]+\)$/)
      }
    }
  })

  test('a wide table scrolls inside the message, with code-border rules and a muted header row', async () => {
    const { q, reply } = await renderReply()
    const scroller = reply.querySelector<HTMLElement>('.aui-md-table')!
    const head = scroller.querySelector('thead')!

    expect(scroller.querySelector(':scope > table')).toBeTruthy()
    expect(getComputedStyle(scroller).overflowX).toBe('auto')
    expect(prop(scroller, 'max-inline-size')).toBe('100%')
    expect(getComputedStyle(head).backgroundColor).toBe('var(--chat-code-surface)')
    expect(getComputedStyle(head).color).toBe('var(--chat-code-label)')
    expect(getComputedStyle(scroller.querySelector('th')!).color).toBe('var(--chat-code-label)')
    // The page itself never scrolls sideways: upstream's viewport clips the inline axis.
    expect(q('[data-slot="aui_thread-viewport"]').className).toContain('overflow-x-hidden')
  })

  test('the chat text size setting scales user and agent text alike: both take the body step', async () => {
    const { q, reply } = await renderReply()
    const content = q('[data-slot="aui_thread-content"]')
    const userText = q('[data-slot="athena_user-bubble"] [data-slot="aui_user-message-text"]')
    const userCode = q('[data-slot="aui_user-inline-code"]')

    // One step for both, declared on the thread content (where upstream multiplies in --chat-text-scale) above both.
    expect(size(userText)).toBe('var(--athena-text-body)')
    expect(size(reply)).toBe('var(--athena-text-body)')
    expect(content.contains(userText) && content.contains(reply)).toBe(true)
    expect(size(userCode)).toBe('var(--athena-text-code)')

    // The labels ride the small step of the same scale.
    expect(size(q('[data-slot="athena_user-label"]'))).toBe('var(--athena-text-small)')
    expect(size(q('[data-slot="athena_assistant-label"]'))).toBe('var(--athena-text-small)')
  })
})

describe('the type scale with the Athena layout off', () => {
  test.each([
    ['row F15 off', () => build('athena', { F15: 'off' })],
    ['a stock build (no snapshot)', () => build(null)],
    ['a stock snapshot', () => build('stock')]
  ])('%s: no scale, no Athena sizes, upstream table', async (_name, setUp) => {
    setUp()
    const { container, q, reply } = await renderReply()
    const content = q('[data-slot="aui_thread-content"]')
    const scroller = reply.querySelector<HTMLElement>('.aui-md-table')!

    expect(container.querySelector(`[${ATHENA_CHAT_ATTR}]`)).toBeNull()
    expect(prop(content, '--athena-text-body')).toBe('')

    for (const el of [reply, ...reply.querySelectorAll('*')]) {
      expect(size(el), el.tagName).not.toMatch(/--athena-text/)
    }

    // Upstream's own table scroller and colours, by class.
    expect(scroller.className).toContain('overflow-x-auto')
    expect(scroller.className).toContain('border-(--ui-stroke-tertiary)')
    expect(getComputedStyle(scroller.querySelector('thead')!).backgroundColor).not.toBe('var(--chat-code-surface)')
    expect(reply.querySelector('thead')!.className).toContain('bg-muted/35')
  })
})
