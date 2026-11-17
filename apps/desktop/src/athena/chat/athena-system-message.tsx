/**
 * F15 slice 06: notes in the Athena chat layout. Everything in the transcript that is neither the user nor the agent
 * speaking reads as a note: centred, in muted text, between two hairline rules, never bubble-shaped.
 *
 * - System messages (slash-command output, steer and review notes, background results, refused content, any other
 *   system line): `AthenaSystemMessage`, the thread's `SystemMessage` entry while the layout is active
 *   (`athenaMessageComponents` in `layout.ts`).
 * - Inter-agent deliveries and process notifications, which arrive on the user role: `AthenaUserMessage`.
 * - A settled reply to an inter-agent delivery, collapsed under "Replied to …": `AthenaAssistantMessage`.
 *
 * Each is upstream's own element inside an Athena note container (`AthenaNote`: `data-slot="athena_note"` and
 * `data-athena-note="<kind>"`); the look is `chat.css` under the thread marker. Upstream keeps the parsing of every
 * note kind, the markup, the disclosures (show message, show reply, a background report) and the links, so nothing
 * is copied; the kind below is read from the same metadata upstream's `SystemMessage` branches on first, and the
 * text kinds (slash, steer, review, plain) stay one kind here because only upstream tells them apart.
 */
import './chat.css'

import { useAuiState } from '@assistant-ui/react'
import type { FC, ReactNode } from 'react'

import { messageContentText } from '@/components/assistant-ui/thread/content'
import { SystemMessage } from '@/components/assistant-ui/thread/system-message'

/** The marker on an Athena note container; its value is the note kind. */
export const ATHENA_NOTE_ATTR = 'data-athena-note'

export type AthenaNoteKind =
  /** An inter-agent delivery ("Message from …"), user role. */
  | 'agent-message'
  /** A settled reply to a delivery, collapsed under "Replied to …". */
  | 'agent-reply'
  /** A background result (a finished background agent or process), system role. */
  | 'background'
  /** A safety-refused turn kept for display: the user's text, greyed and non-interactive. */
  | 'content-refused'
  /** A process notification ("[IMPORTANT: Background process …]"), user role. */
  | 'process'
  /** Any other system line: slash-command output, steer and review notes, plain system text. */
  | 'system'

/** The centred, ruled container a note's upstream element renders in. */
export function AthenaNote({ children, kind }: { children: ReactNode; kind: AthenaNoteKind }) {
  return (
    <div data-athena-note={kind} data-slot="athena_note">
      {children}
    </div>
  )
}

interface SystemRow {
  content: unknown
  metadata?: { custom?: Record<string, unknown> }
}

/**
 * The note kind of a system message, or null when upstream renders nothing for it (no text and not refused). Read in
 * upstream's order: refused content first (it renders even without text), then the empty row, then a background
 * result; the rest is system text.
 */
export function systemNoteKind({ content, metadata }: SystemRow): AthenaNoteKind | null {
  const custom = metadata?.custom ?? {}

  if (custom.contentRefused) {
    return 'content-refused'
  }

  if (!messageContentText(content)) {
    return null
  }

  return custom.asyncResultKind === 'process' || (typeof custom.asyncResult === 'string' && custom.asyncResult)
    ? 'background'
    : 'system'
}

/** The thread's `SystemMessage` entry while the Athena layout is active: upstream's, as a note. */
export const AthenaSystemMessage: FC = () => {
  // A string (or null), so the store's ticks bail out here; system rows don't stream.
  const kind = useAuiState(s => systemNoteKind(s.message))

  return kind ? (
    <AthenaNote kind={kind}>
      <SystemMessage />
    </AthenaNote>
  ) : (
    <SystemMessage />
  )
}
