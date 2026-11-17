import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  assistantMessage,
  stubThreadEnvironment,
  stubThreadViewportSize,
  userMessage
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { getBaseColors, ThemeProvider, useTheme } from '@/themes/context'
import { BUILTIN_THEME_LIST } from '@/themes/presets'

import { setAthenaBrandForTests } from '../brand-text'
import { setFeatureFilter } from '../managed/features'
import { athenaTheme } from '../theme'

import { ATHENA_CHAT_ATTR } from './layout'
import { CHAT_STATES, type ChatTokenName, chatTokens } from './tokens'

stubThreadEnvironment()
stubThreadViewportSize()

const MESSAGES: ThreadMessage[] = [userMessage('user-1', 'hello from the user'), assistantMessage()]

const TOKEN_NAMES: ChatTokenName[] = [
  'chat-user-surface',
  'chat-user-border',
  'chat-agent-label',
  'chat-code-surface',
  'chat-code-border',
  ...CHAT_STATES.flatMap(
    state => [`chat-state-${state}`, `chat-state-${state}-surface`, `chat-state-${state}-text`] as const
  )
]

let theme: ReturnType<typeof useTheme>

function ThemeHandle() {
  theme = useTheme()

  return null
}

function Harness() {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: MESSAGES,
    isRunning: false,
    onNew: async () => {}
  })

  return (
    <ThemeProvider>
      <ThemeHandle />
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread />
      </AssistantRuntimeProvider>
    </ThemeProvider>
  )
}

async function renderThread() {
  const { container } = render(<Harness />)

  await waitFor(() => expect(screen.getByText('hello from the user')).toBeTruthy())

  return () => container.querySelector<HTMLElement>('[data-slot="thread"]')!
}

beforeEach(() => {
  window.localStorage.clear()
  setAthenaBrandForTests(true)
})

afterEach(() => {
  cleanup()
  setAthenaBrandForTests(null)
  setFeatureFilter(null)
})

describe('the chat colour tokens', () => {
  test('every token exists for light and dark under every built-in skin, as #rrggbb', () => {
    for (const skin of BUILTIN_THEME_LIST) {
      for (const mode of ['light', 'dark'] as const) {
        const tokens = chatTokens(getBaseColors(skin.name, mode), mode === 'dark')

        expect(Object.keys(tokens).sort(), skin.name).toEqual([...TOKEN_NAMES].sort())

        for (const value of Object.values(tokens)) {
          expect(value, `${skin.name} ${mode}`).toMatch(/^#[0-9a-f]{6}$/)
        }
      }
    }
  })

  test('the Athena thread root carries them under the Athena skin, light and dark', async () => {
    const root = await renderThread()

    expect(theme.themeName).toBe('athena')
    expect(root().hasAttribute(ATHENA_CHAT_ATTR)).toBe(true)

    for (const [mode, colors] of [
      ['light', athenaTheme.colors],
      ['dark', athenaTheme.darkColors!]
    ] as const) {
      act(() => theme.setMode(mode))
      const tokens = chatTokens(colors, mode === 'dark')

      for (const name of TOKEN_NAMES) {
        expect(root().style.getPropertyValue(`--${name}`), `${mode} ${name}`).toBe(tokens[name])
      }
    }

    expect(root().style.getPropertyValue('--chat-agent-label')).toBe('#00b3e2')
  })

  test('under another built-in skin they are derived from that skin', async () => {
    const root = await renderThread()

    act(() => {
      theme.setTheme('github')
      theme.setMode('dark')
    })

    const tokens = chatTokens(getBaseColors('github', 'dark'), theme.renderedMode === 'dark')

    expect(theme.themeName).toBe('github')
    expect(root().style.getPropertyValue('--chat-user-surface')).toBe(tokens['chat-user-surface'])
    expect(root().style.getPropertyValue('--chat-agent-label')).toBe(getBaseColors('github', 'dark').primary)

    for (const name of TOKEN_NAMES) {
      expect(root().style.getPropertyValue(`--${name}`), name).toBe(tokens[name])
    }
  })

  test('the upstream root (layout off) gets no tokens and no marker', async () => {
    setFeatureFilter(entry => entry !== 'chat:athena-layout')
    const root = await renderThread()

    expect(root().hasAttribute(ATHENA_CHAT_ATTR)).toBe(false)
    expect(root().getAttribute('style')).toBeNull()
  })
})
