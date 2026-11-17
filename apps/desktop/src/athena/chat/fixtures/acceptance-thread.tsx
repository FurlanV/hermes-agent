/**
 * F15 slice 15: the acceptance transcript mounted in the real thread (with the theme provider, so a test can switch
 * light and dark), for `athena-acceptance.test.tsx` and the screenshot export (`athena-acceptance-screens.test.tsx`).
 * Test-only: nothing in the app imports this module.
 */
import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect } from 'vitest'

import { Thread } from '@/components/assistant-ui/thread'
import { ThemeProvider, useTheme } from '@/themes/context'

import { acceptanceTranscript, type LiveMoment } from './acceptance-transcript'

export type ThemeApi = ReturnType<typeof useTheme>

const noop = () => undefined

function ThemeHandle({ onTheme }: { onTheme: (theme: ThemeApi) => void }) {
  onTheme(useTheme())

  return null
}

function AcceptanceThread({ messages, onTheme }: { messages: ThreadMessage[]; onTheme: (theme: ThemeApi) => void }) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages,
    isRunning: messages.at(-1)?.status?.type === 'running',
    onNew: async () => {},
    onReload: async () => {}
  })

  // Every action a message can offer: branch, restore, stop, dismiss.
  return (
    <MemoryRouter>
      <ThemeProvider>
        <ThemeHandle onTheme={onTheme} />
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread onBranchInNewChat={noop} onCancel={noop} onDismissError={noop} onRestoreToMessage={noop} />
        </AssistantRuntimeProvider>
      </ThemeProvider>
    </MemoryRouter>
  )
}

/**
 * The transcript with its live turn at `moment`, mounted and settled (code highlighted, the error shown): the
 * thread root, and the theme as last rendered (to switch light and dark inside `act`).
 */
export async function renderAcceptanceTranscript(moment: LiveMoment) {
  let theme: ThemeApi | null = null

  const { container } = render(
    <AcceptanceThread messages={acceptanceTranscript(moment)} onTheme={value => (theme = value)} />
  )

  await screen.findByRole('alert')
  await waitFor(() => expect(container.querySelectorAll('[data-slot="code-card"] pre').length).toBeGreaterThan(0))

  return { root: container.querySelector<HTMLElement>('[data-slot="thread"]')!, theme: () => theme! }
}
