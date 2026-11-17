/**
 * F15 slice 05: the agent message in the Athena chat layout. A left-aligned, full-width block on the page background
 * (no bubble), labelled "Athena" with the small mark above. Consecutive agent blocks of one turn (one response group)
 * show the label once, on the first. Chosen by the layout switch (`athenaMessageType` in `layout.ts`) only while the
 * layout is active.
 *
 * Structure: an Athena wrapper holds the label row and then upstream's `AssistantMessage`, unchanged, with the
 * thread's props. Upstream's message keeps everything it owns: the `aui_assistant-message-root` slot and its
 * `data-role`, the hoisted parts element and its PERF leaves (status, previews, changed files, streaming marker), the
 * inter-agent collapse, the footer rules (copy, read aloud, branch, reactions, turn duration), the timeline stamp, the
 * enter animation and the double-click tapback. Nothing upstream is copied for this; slice 06 reads upstream's
 * inter-agent reply rule through `interAgentReplySender`, exported from `thread/assistant-message.tsx`.
 *
 * The wrapper subscribes to two booleans (does this message lead its response group? is it a reply to an inter-agent
 * delivery?), never to streaming text or status, so a stream flush re-renders neither the wrapper nor, through it,
 * upstream's root; and the root stays the wrapper's last child whether or not the label shows, so a label flip never
 * remounts it. A settled inter-agent reply is a note, not speech (slice 06): see `AthenaAgentReply`.
 *
 * Fenced code inside the message renders in the Athena code block shell (slice 07, `athena-code-block.tsx`): the
 * wrapper provides it to upstream's highlighter through `CodeBlockShellContext`, a module constant, so the provider
 * never re-renders what it wraps. The turn's status rows take the Athena status line the same way (slice 09,
 * `athena-status.tsx`, through upstream's `TurnStatusLineContext`), and generic tool calls the Athena tool row
 * (slice 10, `athena-tool-block.tsx`, through upstream's `ToolLayoutContext`).
 *
 * Later slices that restyle a leaf inside the body (status, tool rows, errors) can do it in `chat.css` under the
 * marker; one that needs a different leaf component has the seam upstream already has: `AssistantMessage` spreads its
 * props into `InterAgentAssistantMessage` and `AssistantMessageBody`, so an optional leaf prop defaulting to the
 * upstream leaf (for example a module-level parts element in place of `MESSAGE_PARTS`) reaches the body unchanged,
 * and this component passes its own module constant.
 *
 * The model name next to the label is left out: the renderer does not know each message's model (`ChatMessage` has
 * no model field, only the session's current model is known). Plan open question 6.
 */
import './chat.css'

import { useAuiState } from '@assistant-ui/react'
import type { ComponentProps, FC } from 'react'

import { AssistantMessage, interAgentReplySender } from '@/components/assistant-ui/thread/assistant-message'
import { responseMessageRole } from '@/components/assistant-ui/thread/response-group'
import { TurnStatusLineContext } from '@/components/assistant-ui/thread/status'
import { threadMessageIndex } from '@/components/assistant-ui/thread/thread-message-index'
import { ToolLayoutContext } from '@/components/assistant-ui/tool/fallback'
import { CodeBlockShellContext } from '@/components/chat/shiki-highlighter'

import logoUrl from '../assets/source/sickkids-logo.svg'
import { athenaStrings } from '../strings'

import { AthenaCodeBlock } from './athena-code-block'
import { ATHENA_STATUS_LINE } from './athena-status'
import type { AthenaNoteKind } from './athena-system-message'
import { ATHENA_TOOL_LAYOUT } from './athena-tool-block'

export type AthenaAssistantMessageProps = ComponentProps<typeof AssistantMessage>

/** The roles `ResponseMessages` (thread/response-group.tsx) folds into one response group. */
const RESPONSE_ROLES: ReadonlySet<string> = new Set(['assistant', 'background'])

// Hoisted: one element object for every agent message, so a re-render of the wrapper never descends into it.
// The logo is the brand's (branding.json `logo`, the splash's wordmark): the square app mark is that wordmark on a
// tile, unreadable at label size. Decorative next to the name, so hidden from assistive tech.
const AGENT_LABEL = (
  <div
    className="flex select-none items-center gap-1.5 px-(--message-text-indent) pb-1 text-[0.75rem] leading-4 font-medium"
    data-slot="athena_assistant-label"
  >
    <img
      alt=""
      aria-hidden="true"
      className="h-3.5 w-auto dark:brightness-0 dark:invert"
      data-slot="athena_assistant-mark"
      draggable={false}
      src={logoUrl}
    />
    <span>{athenaStrings.chat.agentLabel}</span>
  </div>
)

type ThreadRow = { content: unknown; id: string; role: string; status?: { type: string } }

/** A settled reply to an inter-agent delivery: upstream collapses it under "Replied to …" (a note, not a block). */
const isCollapsedAgentReply = (messages: readonly ThreadRow[], row: ThreadRow) =>
  row.status?.type !== 'running' && interAgentReplySender(messages, row.id) !== null

/**
 * Does message `id` lead its response group, i.e. carry the label? The group is the run of agent and background rows
 * before it (the grouping rule of ResponseMessages); the label rides its first agent block that speaks. Background
 * rows and collapsed inter-agent replies are notes, so they neither carry the label nor take it from the block after.
 */
function leadsResponse(messages: readonly ThreadRow[], id: string): boolean {
  for (let j = threadMessageIndex(messages, id) - 1; j >= 0; j--) {
    const row = messages[j]!
    const role = responseMessageRole(row)

    if (!RESPONSE_ROLES.has(role)) {
      return true
    }

    if (role === 'assistant' && !isCollapsedAgentReply(messages, row)) {
      return false
    }
  }

  return true
}

/**
 * Upstream's `AssistantMessage`, with the Athena leaves its seams take: the code block shell (slice 07), the steady
 * status line (slice 09, `athena-status.tsx`) and the tool row (slice 10, `athena-tool-block.tsx`). All three values
 * are module constants, so the providers never re-render what they wrap.
 */
const UpstreamAssistantMessage: FC<AthenaAssistantMessageProps> = props => (
  <CodeBlockShellContext.Provider value={AthenaCodeBlock}>
    <TurnStatusLineContext.Provider value={ATHENA_STATUS_LINE}>
      <ToolLayoutContext.Provider value={ATHENA_TOOL_LAYOUT}>
        <AssistantMessage {...props} />
      </ToolLayoutContext.Provider>
    </TurnStatusLineContext.Provider>
  </CodeBlockShellContext.Provider>
)

const AGENT_REPLY_NOTE: AthenaNoteKind = 'agent-reply'
const BLOCK_CLASS = 'flex w-full min-w-0 max-w-full flex-col self-start'

/** The thread's `AssistantMessage` entry while the Athena layout is active; same props as upstream's. */
export const AthenaAssistantMessage: FC<AthenaAssistantMessageProps> = props => {
  // Booleans, so stream flushes bail out here.
  const leads = useAuiState(s => leadsResponse(s.thread.messages, s.message.id))
  // Upstream's rule for a reply to an inter-agent delivery (it collapses once settled).
  const agentReply = useAuiState(s => interAgentReplySender(s.thread.messages, s.message.id) !== null)

  return agentReply ? (
    <AthenaAgentReply {...props} leads={leads} />
  ) : (
    <div className={BLOCK_CLASS} data-slot="athena_assistant-message">
      {leads && AGENT_LABEL}
      <UpstreamAssistantMessage {...props} />
    </div>
  )
}

/**
 * A reply to an inter-agent delivery. While it streams it is the agent speaking: a labelled block like any other.
 * Once settled upstream collapses it under "Replied to …", an event in the transcript rather than speech, so it
 * drops the label and reads as a note (`data-athena-note`). Like upstream's `InterAgentAssistantMessage`, this is the
 * only place that subscribes to the running status, and only for this rare case; the root stays the wrapper's last
 * child either way, so settling never remounts it.
 */
const AthenaAgentReply: FC<AthenaAssistantMessageProps & { leads: boolean }> = ({ leads, ...props }) => {
  const collapsed = useAuiState(s => s.message.status?.type !== 'running')

  return (
    <div
      className={BLOCK_CLASS}
      data-athena-note={collapsed ? AGENT_REPLY_NOTE : undefined}
      data-slot="athena_assistant-message"
    >
      {leads && !collapsed && AGENT_LABEL}
      <UpstreamAssistantMessage {...props} />
    </div>
  )
}
