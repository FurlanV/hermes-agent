/**
 * F15 slice 07: the code block in the Athena chat layout. Its own surface (`--chat-code-surface`) with a 1px
 * `--chat-code-border` and a 12px radius, a header row with the fence's language and a Copy button (a plain header
 * with Copy only when the fence names no language), horizontal scroll instead of wrapping, monospace at 0.86em.
 * Styles in `chat.css`.
 *
 * It is a shell, not a highlighter. Upstream's `SyntaxHighlighter` (`components/chat/shiki-highlighter.tsx`) reads
 * `CodeBlockShellContext` and, when a shell is provided, hands it the body it would have put in its own card: the
 * Shiki or plain code (deferred while the reply streams, chunked by lines, within the highlight budget) inside the
 * expandable scroller. The rich fences upstream draws in place of code (diagrams, embeds, artifact cards) never
 * reach it. The Athena agent message provides `AthenaCodeBlock`; with no provider (layout off, stock build) the
 * upstream card renders unchanged.
 *
 * The surface is upstream's `CodeCard` (same `data-slot="code-card"`, so upstream's rhythm, LTR, streaming and HUD
 * rules still find it) marked `data-athena-code-block`. The shell's element types never depend on the text, so a
 * stream delta re-renders the block in place: the card, the header and the body keep their DOM nodes.
 *
 * Copy is upstream's `CopyButton` with upstream's copy text (`copyableCodeText`: the fence as shown, URL references
 * back to plain URLs); a native button, always visible, in the tab order. Upstream's hover-reveal corner Copy is not
 * rendered, the header's replaces it.
 *
 * The user bubble's fences (`UserMessageText`) read the same context. The bubble is itself a button (click opens the
 * edit composer), and a button may not hold another, so the bubble provides `AthenaUserCodeBlock`: the same surface
 * and language header without Copy (the bubble's own Copy action copies the message).
 */
import './chat.css'

import type { FC } from 'react'

import { CodeCard } from '@/components/chat/code-card'
import { type CodeBlockShellProps, copyableCodeText } from '@/components/chat/shiki-highlighter'
import { CopyButton } from '@/components/ui/copy-button'
import { useI18n } from '@/i18n'

// The header's text size (chat.css, the type scale's small step) applies to the button too.
const COPY_CLASS = 'h-6 gap-1 rounded-md px-1.5 leading-none'

function CodeShell({ children, code, copy, language, streaming }: CodeBlockShellProps & { copy: boolean }) {
  const { t } = useI18n()
  const label = language?.trim() || null

  return (
    <CodeCard data-athena-code-block="" data-streaming={streaming ? 'true' : undefined}>
      {(label || copy) && (
        <div data-slot="athena_code-header">
          {label && <span data-slot="athena_code-language">{label}</span>}
          {copy && (
            <CopyButton
              appearance="inline"
              className={COPY_CLASS}
              iconClassName="size-3"
              label={t.assistant.tool.copyCode}
              text={() => copyableCodeText(code)}
            >
              {t.common.copy}
            </CopyButton>
          )}
        </div>
      )}
      {children}
    </CodeCard>
  )
}

/** The code-block shell for the agent message: surface, language header and Copy. */
export const AthenaCodeBlock: FC<CodeBlockShellProps> = props => <CodeShell {...props} copy />

/** The code-block shell inside the user bubble (itself a button): surface and language header, no Copy. */
export const AthenaUserCodeBlock: FC<CodeBlockShellProps> = props => <CodeShell {...props} copy={false} />
