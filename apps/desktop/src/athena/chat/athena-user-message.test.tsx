import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  type AppendMessage,
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  type ThreadMessage
} from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  assistantMessage,
  createdAt,
  stubThreadEnvironment,
  stubThreadViewportSize,
  ThreadRuntime,
  userMessage
} from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { useStickyPromptClip } from '@/components/assistant-ui/thread/use-sticky-prompt-clip'
import { en } from '@/i18n/en'
import { useIncrementalExternalStoreRuntime } from '@/lib/incremental-external-store-runtime'
import { setTextDirection } from '@/store/text-direction'

import type { ClientConfigSnapshot } from '../managed/client-config'
import { $clientConfig } from '../managed/client-config'
import { installFeaturePolicy } from '../managed/feature-policy'

import { isUserRoleNote } from './athena-user-message'
import { ATHENA_CHAT_ATTR } from './layout'

stubThreadEnvironment()
stubThreadViewportSize()

const copy = en.assistant.thread
const ATHENA_USER = '[data-slot="athena_user-message"]'
const USER_ROOT = '[data-slot="aui_user-message-root"]'

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
  uninstall = installFeaturePolicy()
})

afterEach(() => {
  cleanup()
  uninstall()
  $clientConfig.set(null)
  setTextDirection('auto')
  delete (window as Bridge).athenaDesktop
})

function withRefs(message: ThreadMessage, attachmentRefs: string[]): ThreadMessage {
  return { ...message, metadata: { custom: { attachmentRefs } } } as ThreadMessage
}

function running(message: ThreadMessage): ThreadMessage {
  return { ...message, status: { type: 'running' } } as ThreadMessage
}

type ThreadCallbacks = Pick<Parameters<typeof Thread>[0], 'onCancel' | 'onRestoreToMessage'>

function renderThread(messages: ThreadMessage[], callbacks: ThreadCallbacks = {}) {
  return render(
    <ThreadRuntime messages={messages}>
      <Thread {...callbacks} />
    </ThreadRuntime>
  )
}

/** The app's runtime shape (chat/index.tsx): an incremental store with `onEdit`, so the bubble can open the editor. */
function EditHarness({ onEdit }: { onEdit: (message: AppendMessage) => Promise<void> }) {
  const runtime = useIncrementalExternalStoreRuntime<ThreadMessage>({
    messageRepository: ExportedMessageRepository.fromArray([userMessage(), assistantMessage()]),
    isRunning: false,
    setMessages: () => {},
    onNew: async () => {},
    onEdit,
    onCancel: async () => {},
    onReload: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  )
}

const athenaUser = (container: HTMLElement) => container.querySelector<HTMLElement>(ATHENA_USER)
const part = (container: HTMLElement, slot: string) => container.querySelector<HTMLElement>(`[data-slot="${slot}"]`)

describe('the Athena user message (layout on)', () => {
  beforeEach(() => build('athena'))

  test('is labelled "You" above a right-aligned bubble on the user surface token', async () => {
    const { container } = renderThread([userMessage('user-1', 'hello there'), assistantMessage()])

    await screen.findByText('hello there')
    const root = container.querySelector<HTMLElement>(`[${ATHENA_CHAT_ATTR}]`)!
    const message = athenaUser(container)!
    const label = part(container, 'athena_user-label')!
    const frame = part(container, 'athena_user-bubble')!
    const bubble = screen.getByRole('button', { name: copy.editMessage })

    expect(label.textContent).toBe('You')
    // The label comes first, then the bubble holding the text.
    expect(label.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(frame.contains(screen.getByText('hello there'))).toBe(true)

    // Right-aligned, at most 44rem or 80% wide, in logical properties (so a right-to-left page mirrors it).
    expect(getComputedStyle(message).alignItems).toBe('flex-end')
    expect(getComputedStyle(frame).getPropertyValue('margin-inline-start')).toBe('auto')
    expect(getComputedStyle(frame).getPropertyValue('max-inline-size')).toBe('min(44rem, 80%)')
    expect(getComputedStyle(frame).getPropertyValue('inline-size')).toBe('fit-content')

    // The surface: the token on the bubble and on upstream's action cluster (both paint --dt-user-bubble).
    expect(getComputedStyle(frame).getPropertyValue('--dt-user-bubble')).toBe('var(--chat-user-surface)')
    expect(getComputedStyle(bubble).backgroundColor).toBe('var(--chat-user-surface)')
    expect(getComputedStyle(bubble).getPropertyValue('border-color')).not.toBe('')
    expect(getComputedStyle(bubble).borderRadius).toBe('16px')
    expect(getComputedStyle(bubble).getPropertyValue('border-end-end-radius')).toBe('4px')
    // The token itself is painted on the thread root (slice 03).
    expect(root.style.getPropertyValue('--chat-user-surface')).toMatch(/^#[0-9a-f]{6}$/)
  })

  test('keeps the slots the sticky prompt, selection and edit rules key on', async () => {
    const { container } = renderThread([userMessage('user-1', 'sticky prompt'), assistantMessage()])

    await screen.findByText('sticky prompt')
    const prompt = container.querySelector<HTMLElement>(USER_ROOT)!

    expect(prompt.contains(athenaUser(container))).toBe(true)
    expect(prompt.classList.contains('sticky')).toBe(true)
    expect(prompt.dataset.role).toBe('user')
    expect(prompt.dataset.messageId).toBe('user-1')
    expect(prompt.closest('[data-slot="aui_message-group"]')).toBeTruthy()
    // The bubble keeps upstream's base class (the titlebar no-drag carve-out, the edit composer's twin).
    expect(screen.getByRole('button', { name: copy.editMessage }).classList.contains('composer-human-message')).toBe(
      true
    )
  })

  test('shows the time on hover in the bubble corner', async () => {
    const { container } = renderThread([userMessage('user-1', 'when was this'), assistantMessage()])

    await screen.findByText('when was this')
    const time = part(container, 'athena_user-bubble')!.querySelector('time')

    expect(time?.dateTime).toBe(createdAt.toISOString())
    expect(time?.parentElement?.className).toMatch(/group-hover\/user-message:opacity-100/)
  })

  test('click opens the shared edit composer, and an edit is sent', async () => {
    const onEdit = vi.fn(async (_message: AppendMessage) => {})
    const { container } = render(<EditHarness onEdit={onEdit} />)
    const bubble = await screen.findByRole('button', { name: copy.editMessage })

    expect(athenaUser(container)?.contains(bubble)).toBe(true)
    fireEvent.click(bubble)
    await waitFor(() => expect(part(container, 'aui_edit-composer-root')).toBeTruthy())

    const editor = await screen.findByRole('textbox', { name: copy.editMessage })

    editor.textContent = 'edited in the Athena bubble'
    fireEvent.input(editor)
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1))
    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ content: [{ text: 'edited in the Athena bubble', type: 'text' }] })
    )
  })

  test('shows Stop on the latest prompt while a turn runs, and Stop calls onCancel', async () => {
    const onCancel = vi.fn()
    const onRestoreToMessage = vi.fn()

    const { container } = renderThread([userMessage('user-1', 'stop me'), running(assistantMessage())], {
      onCancel,
      onRestoreToMessage
    })

    const stop = await screen.findByRole('button', { name: copy.stop })

    expect(athenaUser(container)?.contains(stop)).toBe(true)

    expect(screen.queryByRole('button', { name: copy.restoreCheckpoint })).toBeNull()
    fireEvent.click(stop)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onRestoreToMessage).not.toHaveBeenCalled()
  })

  test('Restore asks for confirmation before restoring to the prompt', async () => {
    const onRestoreToMessage = vi.fn()

    const { container } = renderThread([userMessage('user-1', 'restore me'), assistantMessage()], {
      onCancel: vi.fn(),
      onRestoreToMessage
    })

    const restore = await screen.findByRole('button', { name: copy.restoreCheckpoint })

    expect(athenaUser(container)?.contains(restore)).toBe(true)
    expect(screen.queryByRole('button', { name: copy.stop })).toBeNull()
    fireEvent.click(restore)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(onRestoreToMessage).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: copy.restoreConfirm }))
    expect(onRestoreToMessage).toHaveBeenCalledWith('user-1', expect.objectContaining({ text: 'restore me' }))
  })

  test('without the callbacks there is neither Stop nor Restore', async () => {
    const { container } = renderThread([userMessage('user-1', 'no actions'), running(assistantMessage())])

    await screen.findByText('no actions')
    expect(athenaUser(container)).toBeTruthy()
    expect(screen.queryByRole('button', { name: copy.stop })).toBeNull()
    expect(screen.queryByRole('button', { name: copy.restoreCheckpoint })).toBeNull()
  })

  test('renders attachments below the sticky bubble, and a file-only turn as chips inside it', async () => {
    const { container } = renderThread([
      withRefs(userMessage('user-1', 'see the file'), ['@file:/tmp/notes.txt']),
      assistantMessage()
    ])

    await screen.findByText('see the file')
    const row = part(container, 'athena_user-attachments')!
    const prompt = container.querySelector(USER_ROOT)!

    expect(row.textContent).toMatch(/notes\.txt/)
    // A flow sibling after the sticky box, so it scrolls away behind the pinned bubble.
    expect(prompt.contains(row)).toBe(false)
    expect(prompt.nextElementSibling).toBe(row)

    cleanup()
    const chipOnly = renderThread([withRefs(userMessage('user-2', ''), ['@file:/tmp/only.txt']), assistantMessage()])

    await waitFor(() => expect(part(chipOnly.container, 'athena_user-bubble')?.textContent).toMatch(/only\.txt/))
    expect(part(chipOnly.container, 'athena_user-attachments')).toBeNull()
  })

  test('the sticky-prompt clip masks the attachments behind the pinned Athena bubble, never the bubble', async () => {
    const { container } = renderThread([
      withRefs(userMessage('user-1', 'pinned'), ['@file:/tmp/notes.txt']),
      assistantMessage()
    ])

    await screen.findByText('pinned')
    const group = container.querySelector<HTMLElement>('[data-slot="aui_message-group"]')!
    const prompt = group.querySelector<HTMLElement>(USER_ROOT)!
    const attachments = part(container, 'athena_user-attachments')!
    const viewport = window.document.createElement('div')
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect

    const rects = new Map<Element, DOMRect>([
      [viewport, rect(0, 500)],
      [group, rect(0, 900)],
      [prompt, rect(0, 60)],
      [attachments, rect(-50, 40)]
    ])

    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return rects.get(this) ?? rect(1000, 0)
    })
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        disconnect() {}
        observe() {}
        unobserve() {}
      }
    )

    try {
      const options = {
        contentRef: { current: container },
        paneVisible: true,
        rows: 'rows',
        scrollRef: { current: viewport }
      }

      const clip = renderHook(() => useStickyPromptClip(options))

      expect(attachments.style.getPropertyValue('--sticky-prompt-clip')).toBe('40px')
      expect(prompt.hasAttribute('data-sticky-prompt-clip')).toBe(false)
      expect(prompt.querySelector('[data-sticky-prompt-clip]')).toBeNull()
      clip.unmount()
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      stubThreadEnvironment()
    }
  })

  test('a forced right-to-left direction reaches the user lines; the bubble keeps its logical width limits', async () => {
    act(() => setTextDirection('rtl'))
    const { container } = renderThread([userMessage('user-1', 'مرحبا Hello'), assistantMessage()])

    await screen.findByText('مرحبا Hello')
    const frame = part(container, 'athena_user-bubble')!

    expect(part(container, 'aui_user-inline-text')?.getAttribute('dir')).toBe('rtl')
    expect(getComputedStyle(frame).getPropertyValue('max-inline-size')).toBe('min(44rem, 80%)')
    expect(getComputedStyle(frame).getPropertyValue('margin-inline-start')).toBe('auto')
  })

  test.each([
    [
      'a process notification',
      '[IMPORTANT: Background process proc_1 completed normally (exit code 0).]',
      'aui_background-result'
    ],
    ['an inter-agent note', 'Message from 🤖 Scout: the build is green', 'aui_agent-message-note']
  ])('%s keeps the upstream look (no "You", no bubble)', async (_name, text, slot) => {
    const { container } = renderThread([userMessage('user-1', text), assistantMessage()])

    await waitFor(() => expect(part(container, slot)).toBeTruthy())
    expect(athenaUser(container)).toBeNull()
    expect(screen.queryByText('You')).toBeNull()
  })
})

describe('the user message with the Athena layout off', () => {
  test.each([
    ['row F15 off', () => build('athena', { F15: 'off' })],
    ['a stock build (no snapshot)', () => build(null)],
    ['a stock snapshot', () => build('stock')]
  ])('%s: upstream UserMessage renders', async (_name, setUp) => {
    setUp()

    const { container } = renderThread([userMessage('user-1', 'plain upstream'), assistantMessage()], {
      onRestoreToMessage: vi.fn()
    })

    await screen.findByText('plain upstream')
    expect(athenaUser(container)).toBeNull()
    expect(container.querySelector('[data-slot^="athena_"]')).toBeNull()
    expect(screen.queryByText('You')).toBeNull()
    expect(part(container, 'aui_user-bubble-actions')).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.editMessage }).classList.contains('composer-human-message')).toBe(
      true
    )
    expect(screen.getByRole('button', { name: copy.restoreCheckpoint })).toBeTruthy()
  })

  test('a live config change swaps the user message both ways', async () => {
    build('athena')
    const { container } = renderThread([userMessage('user-1', 'flip me'), assistantMessage()])

    await screen.findByText('flip me')
    expect(athenaUser(container)).toBeTruthy()

    act(() => $clientConfig.set(snapshot('athena', { F15: 'off' })))
    expect(athenaUser(container)).toBeNull()
    expect(screen.getByText('flip me')).toBeTruthy()

    act(() => $clientConfig.set(snapshot('athena')))
    expect(athenaUser(container)).toBeTruthy()
  })
})

describe('isUserRoleNote', () => {
  test.each([
    ['[IMPORTANT: Background process proc_1 completed normally (exit code 0).]', true],
    ["[Message from agent 'scout'] hello", true],
    ['Message from 🤖 Scout: hi', true],
    ['  Message from Scout (@scout): hi', true],
    ['a plain prompt', false],
    ['tell me about the Message from Scout: thing', false]
  ])('%j → %s', (text, note) => {
    expect(isUserRoleNote(text)).toBe(note)
  })
})
