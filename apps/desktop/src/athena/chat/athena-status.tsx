/**
 * F15 slice 09: the status of a running turn in the Athena chat layout. One status line, reading "Athena is working"
 * and the current step, and a pulsing caret at the end of the streaming text; both go when the turn ends.
 *
 * The line is upstream's, not a copy. Upstream's tail status slot (`AssistantStatusSlot` in
 * `thread/assistant-message.tsx`) keeps its TAIL-ONLY rule and picks the row: the pre-first-token row
 * (`ResponseLoadingIndicator`) or the turn's activity row (`TurnActivityIndicator`, `thread/status.tsx`). Both keep
 * their step text, wait hints, local model load progress, compaction label, timer and polite live region
 * (`role="status"`, announced when the hint changes, the timer hidden from it). The Athena agent message provides
 * `ATHENA_STATUS_LINE` through upstream's `TurnStatusLineContext` (a module constant, so the provider never
 * re-renders what it wraps), which makes the activity row steady: up whenever the turn works instead of only after
 * a quiet spell, timed from the turn's start; and both rows show the visible "Athena is working" lead after the
 * pulse. Upstream's two exemptions stay: a question the user is answering, and a running tool, whose row narrates
 * the wait with its own ticker and timer (so the line never repeats it). The lead is hidden from assistive tech: the
 * row's label already says it.
 *
 * The line stays where upstream renders it, at the end of the tail message, not under the "Athena" label: the label
 * rides the first block of a response group while the status belongs to the thread's tail (often a later block of
 * the same turn), and moving it would mean a second slot and a second live region.
 *
 * The caret is CSS (`chat.css`): the end of the running text part (`.aui-md[data-status='running']`) of a message
 * whose activity row is active, so it follows the same tail rule and the same "working" as the line, and adds no
 * subscription. The stopped notice is upstream's `StoppedNotice`, restyled there too.
 */
import type { FC } from 'react'

import type { TurnStatusLine } from '@/components/assistant-ui/thread/status'

import { brandText } from '../brand-text'

// A component, so the brand pass reads the build when it renders, not when this module loads.
const AthenaStatusLead: FC = () => (
  <span aria-hidden="true" data-slot="athena_status-lead">
    {brandText('Hermes is working')}
  </span>
)

/** The Athena layout's status line, provided to upstream's status rows through `TurnStatusLineContext`. */
export const ATHENA_STATUS_LINE: TurnStatusLine = Object.freeze({ lead: <AthenaStatusLead /> })
