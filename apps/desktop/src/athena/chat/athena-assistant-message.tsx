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
 * enter animation and the double-click tapback. Nothing upstream is copied or exported for this.
 *
 * The wrapper subscribes to one boolean (does this message lead its response group?), never to streaming text or
 * status, so a stream flush re-renders neither the wrapper nor, through it, upstream's root; and the root stays the
 * wrapper's last child whether or not the label shows, so a label flip never remounts it.
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

import { AssistantMessage } from '@/components/assistant-ui/thread/assistant-message'
import { responseMessageRole } from '@/components/assistant-ui/thread/response-group'
import { threadMessageIndex } from '@/components/assistant-ui/thread/thread-message-index'

import logoUrl from '../assets/source/sickkids-logo.svg'
import { athenaStrings } from '../strings'

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

/** The thread's `AssistantMessage` entry while the Athena layout is active; same props as upstream's. */
export const AthenaAssistantMessage: FC<AthenaAssistantMessageProps> = props => {
  // The label rides the first message of a response group: the one whose previous row is not part of the same
  // group (the grouping rule of ResponseMessages). A boolean, so stream flushes bail out here.
  const leadsResponse = useAuiState(s => {
    const messages = s.thread.messages
    const previous = messages[threadMessageIndex(messages, s.message.id) - 1]

    return !previous || !RESPONSE_ROLES.has(responseMessageRole(previous))
  })

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col self-start" data-slot="athena_assistant-message">
      {leadsResponse && AGENT_LABEL}
      <AssistantMessage {...props} />
    </div>
  )
}
