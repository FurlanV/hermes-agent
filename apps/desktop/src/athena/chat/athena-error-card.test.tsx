import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createdAt,
  stubThreadEnvironment,
  stubThreadViewportSize,
  userMessage
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { en } from '@/i18n/en'
import type { ErrorSurface } from '@/lib/error-surface'
import { errorCardText } from '@/lib/error-surface-copy'
import { ThemeProvider, useTheme } from '@/themes/context'

import type { ClientConfigSnapshot } from '../managed/client-config'
import { $clientConfig } from '../managed/client-config'
import { installFeaturePolicy } from '../managed/feature-policy'
import { athenaTheme } from '../theme'

import { ATHENA_CHAT_ATTR } from './layout'
import { chatContrastFailures, chatTokens } from './tokens'

stubThreadViewportSize()

const copy = en.assistant.thread
const CARD = '[data-slot="aui_error-card"]'

let sheet: HTMLStyleElement

// jsdom applies a stylesheet's declarations (unresolved) but vitest loads no CSS: inject the Athena one.
beforeAll(() => {
  sheet = window.document.createElement('style')

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

/** The preload's snapshot (the variant) and the live client config (the rows); `null` is a stock build. */
function build(variant: 'athena' | 'stock' | null, features: Record<string, string> = {}) {
  if (variant) {
    ;(window as Bridge).athenaDesktop = { clientConfig: { snapshot: snapshot(variant, features) } }
  }

  $clientConfig.set(variant ? snapshot(variant, features) : null)
}

let uninstall: () => void

beforeEach(() => {
  window.localStorage.clear()
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

/** A failed turn; with `errorSurface`, the descriptor the gateway stamps (lib/error-surface.ts). */
function failed(errorSurface?: Record<string, unknown>, error = 'HTTP 500: upstream exploded'): ThreadMessage {
  return {
    id: 'assistant-error',
    role: 'assistant',
    content: [],
    status: { type: 'incomplete', reason: 'error', error },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: errorSurface ? { errorSurface } : {}
    }
  } as unknown as ThreadMessage
}

/** Blocking upstream: the model is gone, so the card offers a way to another model. */
const MODEL_NOT_FOUND = { code: 'model_not_found', layer: 'provider', provider: 'openai', retryable: false }
const modelNotFound = () => failed(MODEL_NOT_FOUND)

/** Degraded upstream: Retry, a dismiss and the details. */
const rateLimited = () =>
  failed({ code: 'rate_limit', layer: 'provider', provider: 'openai', retryable: true }, 'HTTP 429: slow down')

/** A rejected API key: "Update API key" (row S80, refused in Athena), then Retry. */
const badKey = () =>
  failed(
    { authKind: 'api_key', code: 'auth', layer: 'auth', provider: 'openai', retryable: false },
    'HTTP 401: Incorrect API key'
  )

/** An expired sign-in: "Sign in to … again" (row S79, refused in Athena), then Retry. */
const expiredSignIn = () =>
  failed(
    {
      authKind: 'oauth',
      code: 'auth',
      layer: 'auth',
      provider: 'nous',
      providerLabel: 'Nous Portal',
      retryable: false
    },
    'HTTP 401: User not found.'
  )

let theme: ReturnType<typeof useTheme>

function ThemeHandle() {
  theme = useTheme()

  return null
}

function Harness({
  assistant,
  onDismissError,
  onReload
}: {
  assistant: ThreadMessage
  onDismissError?: (messageId: string) => void
  onReload?: () => Promise<void>
}) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: [userMessage('user-1', 'please answer'), assistant],
    isRunning: false,
    onNew: async () => {},
    ...(onReload ? { onReload } : {})
  })

  // In a router, as in the app: the settings actions (Update API key) render only there.
  return (
    <MemoryRouter>
      <ThemeProvider>
        <ThemeHandle />
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread onDismissError={onDismissError} />
        </AssistantRuntimeProvider>
      </ThemeProvider>
    </MemoryRouter>
  )
}

async function renderCard(props: Parameters<typeof Harness>[0]) {
  const view = render(<Harness {...props} />)
  const card = await screen.findByRole('alert')

  return { ...view, card }
}

const style = (el: Element) => getComputedStyle(el)
const variable = (el: Element, name: string) => style(el).getPropertyValue(name).trim()

/** The outline an Athena `:focus-visible` rule gives `el`, or '' (matched with the pseudo-class dropped). */
function focusRing(el: Element): string {
  const rules = [...sheet.sheet!.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)

  const ring = rules
    .filter(rule => rule.selectorText.includes('.aui-error-card') && rule.selectorText.endsWith(':focus-visible'))
    .filter(rule => el.matches(rule.selectorText.replace(/:focus-visible$/, '')))
    .map(rule => rule.style.getPropertyValue('outline'))

  return ring.at(-1) ?? ''
}

/** A native button in the tab order: focus reaches it, and Enter on it is a click (jsdom does not synthesise the
 *  click from the key, so it is dispatched as the browser would). */
function pressEnter(button: HTMLElement) {
  expect(button.tagName).toBe('BUTTON')
  expect(button.getAttribute('type')).toBe('button')
  expect(button.tabIndex).toBe(0)
  button.focus()
  expect(window.document.activeElement).toBe(button)
  fireEvent.keyDown(button, { key: 'Enter' })
  fireEvent.click(button)
}

describe('the Athena error card (layout on)', () => {
  beforeEach(() => build('athena'))

  test.each([
    ['light', athenaTheme.colors],
    ['dark', athenaTheme.darkColors!]
  ] as const)('%s: a block with a red edge, the icon, the sentence and its action', async (mode, colors) => {
    const { card, container } = await renderCard({ assistant: modelNotFound() })

    act(() => theme.setMode(mode))

    const root = container.querySelector<HTMLElement>('[data-slot="thread"]')!
    const tokens = chatTokens(colors, mode === 'dark')

    // Inside the Athena thread and the Athena agent message, upstream's card with its alert role.
    expect(theme.themeName).toBe('athena')
    expect(root.hasAttribute(ATHENA_CHAT_ATTR)).toBe(true)
    expect(card.matches(`[${ATHENA_CHAT_ATTR}] [data-slot="athena_assistant-message"] ${CARD}`)).toBe(true)
    expect(card.dataset.severity).toBe('blocking')

    // The tokens it is painted with are this appearance's, and every pair passes (the error card's among them).
    expect(root.style.getPropertyValue('--chat-state-error')).toBe(tokens['chat-state-error'])
    expect(root.style.getPropertyValue('--chat-state-error-surface')).toBe(tokens['chat-state-error-surface'])
    expect(root.style.getPropertyValue('--chat-state-error-text')).toBe(tokens['chat-state-error-text'])
    expect(chatContrastFailures(tokens, colors)).toEqual([])

    // The red edge on the inline start, on the error surface; no box border.
    expect(style(card).getPropertyValue('border-inline-start')).toBe('3px solid var(--athena-error-edge)')
    expect(variable(card, '--athena-error-edge')).toBe('var(--chat-state-error)')
    expect(style(card).getPropertyValue('background')).toBe('var(--athena-error-surface)')
    expect(variable(card, '--athena-error-surface')).toBe('var(--chat-state-error-surface)')

    // Never colour alone: the icon (decorative, in the error text colour) and the words say it.
    const icon = card.querySelector<SVGElement>('svg.aui-error-card-icon')!

    expect(icon.getAttribute('aria-hidden')).not.toBeNull()
    expect(variable(card, '--err-alert')).toBe('var(--chat-state-error-text)')
    expect(variable(card, '--err-ink')).toBe('var(--dt-foreground)')

    const { body, title } = errorCardText(copy, MODEL_NOT_FOUND as ErrorSurface)

    expect(card.querySelector('.aui-error-card-title')?.textContent).toBe(title)
    expect(card.querySelector('.aui-error-card-body')?.textContent).toBe(body)
    expect(body.length).toBeGreaterThan(0)

    // The action, and the details behind their disclosure.
    const action = card.querySelector<HTMLElement>('.aui-error-card-actions > button')!

    expect(action.textContent).toBeTruthy()
    expect(within(card).getByRole('button', { name: copy.errorDetails }).getAttribute('aria-expanded')).toBe('false')
    expect(card.querySelector<HTMLElement>('[data-slot="aui_error-details"]')!.hidden).toBe(true)

    // A visible focus ring on every control (jsdom matches no :focus-visible, so the rule is matched by hand).
    for (const control of card.querySelectorAll('button')) {
      expect(focusRing(control), control.outerHTML.slice(0, 80)).toMatch(/^2px solid /)
    }

    expect(focusRing(action)).toBe('2px solid var(--chat-agent-label)')
  })

  test('a degraded card is not a hard fault: a neutral edge on the page, still with its icon and words', async () => {
    const { card } = await renderCard({ assistant: rateLimited(), onDismissError: () => undefined })

    expect(card.dataset.severity).toBe('degraded')
    expect(style(card).getPropertyValue('border-inline-start')).toBe('3px solid var(--athena-error-edge)')
    expect(variable(card, '--athena-error-edge')).toBe('var(--chat-note-rule)')
    expect(variable(card, '--athena-error-surface')).toBe('transparent')
    expect(card.querySelector('svg.aui-error-card-icon')).not.toBeNull()
    expect(card.querySelector('.aui-error-card-body')?.textContent).toBeTruthy()
    expect(within(card).getByRole('button', { name: copy.errorRetry })).toBeTruthy()
    expect(within(card).getByRole('button', { name: copy.dismissError })).toBeTruthy()
  })

  test('Retry works by pointer and by keyboard', async () => {
    const onReload = vi.fn(async () => {})
    const { card } = await renderCard({ assistant: failed(), onReload })
    const retry = within(card).getByRole('button', { name: copy.errorRetry })

    fireEvent.click(retry)
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))

    pressEnter(retry)
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(2))
  })

  test('dismiss works by pointer and by keyboard', async () => {
    const onDismissError = vi.fn()
    const { card } = await renderCard({ assistant: rateLimited(), onDismissError })
    const dismiss = within(card).getByRole('button', { name: copy.dismissError })

    fireEvent.click(dismiss)
    expect(onDismissError).toHaveBeenCalledWith('assistant-error')

    pressEnter(dismiss)
    expect(onDismissError).toHaveBeenCalledTimes(2)
  })

  test('the details disclosure opens and closes by pointer and by keyboard', async () => {
    const { card } = await renderCard({ assistant: rateLimited() })
    const toggle = within(card).getByRole('button', { name: copy.errorDetails })
    const details = card.querySelector<HTMLElement>(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`)!

    expect(details.dataset.slot).toBe('aui_error-details')
    expect(details.hidden).toBe(true)

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(details.hidden).toBe(false)
    expect(within(details).getByText('HTTP 429: slow down')).toBeTruthy()

    fireEvent.click(toggle)
    expect(details.hidden).toBe(true)

    pressEnter(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(details.hidden).toBe(false)
    expect(window.document.activeElement).toBe(toggle)

    pressEnter(toggle)
    expect(details.hidden).toBe(true)
    expect(toggle.textContent).toBe(copy.errorDetails)
  })

  test.each([
    ['a rejected API key (row S80)', badKey, copy.errorUpdateApiKey],
    ['an expired sign-in (row S79)', expiredSignIn, copy.errorSignInAgain('Nous Portal')]
  ])('%s: the action into the refused feature is not offered, Retry still is', async (_name, message, label) => {
    const { card } = await renderCard({ assistant: message() })

    expect(card.closest(`[${ATHENA_CHAT_ATTR}]`)).not.toBeNull()
    expect(within(card).queryByRole('button', { name: label })).toBeNull()
    expect(within(card).getByRole('button', { name: copy.errorRetry })).toBeTruthy()
  })
})

describe('the error card with the Athena layout off', () => {
  /** The card's markup with React's generated ids blanked, to compare two renders. */
  const markup = (card: Element) => card.outerHTML.replace(/_r_[\w]+_|:r[\w]+:/g, 'ID')

  // The markup is compared where the feature filter is the Athena one (row F15 aside); a stock snapshot allows
  // everything, so its card also offers what F02 refuses in Athena (Send diagnostics).
  test.each([
    ['row F15 off', () => build('athena', { F15: 'off' }), true],
    ['a stock build (no snapshot)', () => build(null), true],
    ['a stock snapshot', () => build('stock'), false]
  ])('%s: upstream renders it, unstyled by the Athena CSS', async (_name, setUp, sameFilter) => {
    build('athena')
    const athena = await renderCard({ assistant: rateLimited(), onDismissError: () => undefined })
    const athenaMarkup = markup(athena.card)

    cleanup()
    uninstall()
    $clientConfig.set(null)
    delete (window as Bridge).athenaDesktop
    uninstall = installFeaturePolicy()
    setUp()

    const { card, container } = await renderCard({ assistant: rateLimited(), onDismissError: () => undefined })

    expect(container.querySelector(`[${ATHENA_CHAT_ATTR}]`)).toBeNull()
    expect(container.querySelector('[data-slot="athena_assistant-message"]')).toBeNull()
    expect(card.className).toBe('aui-error-card')
    expect(card.dataset.severity).toBe('degraded')

    // The card's DOM is upstream's in both layouts (the Athena look is CSS only)...
    if (sameFilter) {
      expect(markup(card)).toBe(athenaMarkup)
    }

    // ...and none of the Athena rules reach it here.
    expect(variable(card, '--athena-error-edge')).toBe('')
    expect(variable(card, '--err-ink')).toBe('')
    expect(style(card).getPropertyValue('border-inline-start')).toBe('')
  })

  test.each([
    ['a rejected API key', badKey, copy.errorUpdateApiKey],
    ['an expired sign-in', expiredSignIn, copy.errorSignInAgain('Nous Portal')]
  ])(
    '%s in a stock build: the action Athena refuses is offered, as upstream offers it',
    async (_name, message, label) => {
      build('stock')
      const { card } = await renderCard({ assistant: message() })

      expect(within(card).getByRole('button', { name: label })).toBeTruthy()
      expect(within(card).getByRole('button', { name: copy.errorRetry })).toBeTruthy()
    }
  )
})
